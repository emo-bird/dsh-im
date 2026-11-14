import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { GroupHistoryStore } from '../../../src/channels/shared/group-history-store.mjs';
import {
  backfillGroupHistory,
  listedMessageText,
  namedMentions,
} from '../../../src/channels/feishu/group-backfill.mjs';

const BASE = Date.parse('2026-11-13T10:00:00Z');
const silent = { info() {}, warn() {}, error() {} };

/** One message as `im.v1.message.list` reports it. */
function listed({ messageId, text, senderId, senderName, sentAt, msgType = 'text', mentions, threadId, parentId }) {
  return {
    message_id: messageId,
    chat_id: 'oc_live_group',
    msg_type: msgType,
    create_time: String(sentAt),
    body: { content: JSON.stringify(msgType === 'text' ? { text } : { title: text, elements: [] }) },
    sender: { id: senderId, id_type: 'open_id', sender_type: 'user', sender_name: senderName },
    ...(mentions ? { mentions } : {}),
    ...(threadId ? { thread_id: threadId } : {}),
    ...(parentId ? { parent_id: parentId } : {}),
    deleted: false,
  };
}

/** A client whose message listing answers with the given pages. */
function clientOf(pages, calls = []) {
  return {
    im: { v1: { message: { list: async ({ params }) => {
      calls.push(params);
      const page = pages[Math.min(calls.length - 1, pages.length - 1)] ?? [];
      return { code: 0, data: page };
    } } } },
  };
}

async function archiveStore(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-feishu-backfill-'));
  const archive = new GroupHistoryStore(root, { now: () => BASE + 60_000, logger: silent });
  t.after(async () => { await archive.close(); await rm(root, { recursive: true, force: true }); });
  return archive;
}

test('the sweep files the neighbour bot messages the provider holds', async (t) => {
  const archive = await archiveStore(t);
  const calls = [];
  const client = clientOf([{
    has_more: false,
    items: [
      listed({ messageId: 'om_bot', text: '我这边已经升好了', senderId: 'ou_other_bot', senderName: '小肥鱼', sentAt: BASE - 30_000 }),
      listed({ messageId: 'om_human', text: '等我升个依赖', senderId: 'ou_human', senderName: '一门鸽鸽', sentAt: BASE - 40_000 }),
    ],
  }], calls);

  const seen = await backfillGroupHistory(client, archive, {
    chatId: 'oc_live_group', until: BASE, logger: silent,
  });
  assert.equal(seen, 2, 'the provider offered two messages');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].container_id_type, 'chat');
  assert.equal(calls[0].container_id, 'oc_live_group');
  assert.equal(calls[0].sort_type, 'ByCreateTimeDesc');
  assert.equal(calls[0].with_sender_name, true);
  assert.equal(Number(calls[0].end_time) * 1000, BASE);

  const page = await archive.query(
    (await archive.capture({
      channel: 'feishu', scope: 'feishu', groupId: 'oc_live_group',
      messageId: 'om_probe', senderId: 'ou_probe', sentAt: BASE - 1_000, text: 'probe',
    })).groupId,
    { limit: 10 },
  );
  const bot = page.items.find((item) => item.senderId === 'ou_other_bot');
  assert.ok(bot, 'the other bot\'s line is archived');
  assert.equal(bot.senderName, '小肥鱼');
  assert.equal(bot.text, '我这边已经升好了');
  const human = page.items.find((item) => item.senderId === 'ou_human');
  assert.equal(human.text, '等我升个依赖');
});

test('the sweep is idempotent, so a repeated window adds no rows', async (t) => {
  const archive = await archiveStore(t);
  const items = [listed({ messageId: 'om_twice', text: '同一句话', senderId: 'ou_human', senderName: '甲', sentAt: BASE - 10_000 })];
  const client = clientOf([{ has_more: false, items }]);
  await backfillGroupHistory(client, archive, { chatId: 'oc_live_group', until: BASE, logger: silent });
  await backfillGroupHistory(client, archive, { chatId: 'oc_live_group', until: BASE + 1, logger: silent });
  const context = await archive.capture({
    channel: 'feishu', scope: 'feishu', groupId: 'oc_live_group',
    messageId: 'om_probe', senderId: 'ou_probe', sentAt: BASE - 1_000, text: 'probe',
  });
  const page = await archive.query(context.groupId, { limit: 10 });
  assert.equal(page.items.filter((item) => item.text === '同一句话').length, 1);
});

test('a mention placeholder is replaced by the name the provider gives', () => {
  assert.equal(namedMentions('@_user_1 你看下', [{ key: '@_user_1', name: '一门鸽鸽' }]), '@一门鸽鸽 你看下');
  assert.equal(namedMentions('@_user_1 @_user_2 都对', [
    { key: '@_user_1', name: '甲' }, { key: '@_user_2', name: '乙' },
  ]), '@甲 @乙 都对');
  // No name to substitute: the placeholder goes away rather than staying cryptic.
  assert.equal(namedMentions('@_user_3 你好', [{ key: '@_user_3' }]), '你好');
  assert.equal(namedMentions('没有提及', undefined), '没有提及');
});

test('a card or post payload is read down to its text', () => {
  assert.equal(listedMessageText({ msg_type: 'text', body: { content: '{"text":"纯文本"}' } }), '纯文本');
  assert.equal(listedMessageText({
    msg_type: 'post',
    body: { content: JSON.stringify({ title: '标题', content: [[{ tag: 'text', text: '正文' }]] }) },
  }), '标题 正文');
  assert.equal(listedMessageText({ msg_type: 'text', body: { content: 'not json' } }), '');
  assert.equal(listedMessageText({ msg_type: 'image', body: { content: '{"image_key":"k"}' } }), '');
});

test('a missing permission is reported, not thrown at the caller', async (t) => {
  const archive = await archiveStore(t);
  const client = { im: { v1: { message: { list: async () => ({ code: 99991672, msg: 'no permission' }) } } } };
  const seen = await backfillGroupHistory(client, archive, { chatId: 'oc_live_group', until: BASE, logger: silent });
  assert.equal(seen, 0);
});

test('a rejected request is reported, not thrown at the caller', async (t) => {
  const archive = await archiveStore(t);
  const client = { im: { v1: { message: { list: async () => { throw new Error('network down'); } } } } };
  const seen = await backfillGroupHistory(client, archive, { chatId: 'oc_live_group', until: BASE, logger: silent });
  assert.equal(seen, 0);
});
