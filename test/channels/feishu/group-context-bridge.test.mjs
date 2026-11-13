import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { GroupHistoryStore } from '../../../src/channels/shared/group-history-store.mjs';
import { FeishuHarnessBridge } from '../../../src/channels/feishu/bridge.mjs';

const BASE = Date.parse('2026-11-13T10:00:00Z');
const silent = { info() {}, warn() {}, error() {} };

function fixtureState() {
  const sessions = new Map();
  const seen = new Set();
  return {
    state: {
      hasSeen: (id) => seen.has(id),
      markSeen: async (id) => seen.add(id),
      sessionFor: (key) => sessions.get(key) ?? null,
      setSession: async (key, id) => sessions.set(key, id),
      clearSession: async (key) => sessions.delete(key),
      pendingSenders: () => [],
    },
  };
}

/** The slice of the Host client the bridge actually calls during a turn. */
function harnessMock(prompts) {
  return {
    currentBusyMessageMode: () => 'queue',
    ensureRunning: async () => true,
    createSession: async () => 'session-group',
    renameSession: async (_sessionId, title) => ({ title, seq: 0 }),
    sessionExists: async () => true,
    hasActiveTurn: async () => false,
    isSessionRunning: async () => false,
    currentWorkspace: () => null,
    ask: async (_sessionId, content) => {
      prompts.push(Array.isArray(content)
        ? content.filter((item) => item?.type === 'text').map((item) => item.text).join('\n\n')
        : content);
      return '收到';
    },
  };
}

/**
 * One inbound Feishu group event, in the shape the SDK delivers.
 *
 * Deliberately carries no `sender_name`: the live payload does not include one,
 * which is the whole reason the bridge reads the name back from the API.
 */
function groupEvent({ messageId, text, senderOpenId, sentAt, mentions = [] }) {
  return {
    sender: {
      sender_type: 'user',
      sender_id: { open_id: senderOpenId },
    },
    message: {
      message_id: messageId,
      message_type: 'text',
      chat_type: 'group',
      chat_id: 'oc_live_group',
      create_time: String(sentAt),
      content: JSON.stringify({ text }),
      mentions,
    },
  };
}

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-feishu-group-names-'));
  const store = new GroupHistoryStore(root, { now: () => BASE, logger: silent });
  // Seed the platform group so the test has the internal group id to read back.
  const group = await store.capture({
    channel: 'feishu', scope: 'feishu', groupId: 'oc_live_group',
    messageId: 'om_seed', senderId: 'ou_seed', senderName: '种子',
    sentAt: BASE - 60_000, text: 'seed',
  });
  const prompts = [];
  const lookups = [];
  const names = new Map();
  const { state } = fixtureState();
  const bridge = new FeishuHarnessBridge({
    client: { im: { v1: { message: {
      create: async () => ({ code: 0, data: { message_id: 'om_reply' } }),
      reply: async () => ({ code: 0, data: { message_id: 'om_reply' } }),
      // What Feishu really answers: the name lives here, not on the event.
      get: async ({ path }) => {
        lookups.push(path.message_id);
        const senderName = names.get(path.message_id);
        return { code: 0, data: { items: [{
          message_id: path.message_id,
          chat_id: 'oc_live_group',
          sender: { id: 'ou_unknown', sender_name: senderName },
        }] } };
      },
    } } } },
    channel: {},
    harness: harnessMock(prompts),
    state,
    logger: silent,
    status: { messagesReceived: 0, messagesReplied: 0, messagesRejected: 0,
      lastMessageAt: null, lastReplyAt: null, lastRejectedAt: null, lastError: null },
    allowedSenderOpenIds: new Set(['ou_owner']),
    botOpenId: 'ou_bot',
    groupHistory: store,
    groupHistoryScope: 'feishu',
    groupResponseMode: 'mention',
    mentionTopicReply: false,
  });
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  return { store, groupId: group.groupId, bridge, prompts, lookups, names };
}

test('the archive records who spoke, not just their open id', async (t) => {
  const { store, groupId, bridge, names, lookups } = await harness(t);
  names.set('om_first', '一门鸽鸽');
  await bridge.accept(groupEvent({
    messageId: 'om_first', text: '构建挂了', senderOpenId: 'ou_owner',
    sentAt: BASE - 1_000,
    mentions: [{ key: '@_bot', id: { open_id: 'ou_bot' } }],
  }));
  const page = await store.query(groupId, { limit: 10 });
  const stored = page.items.find((item) => item.senderId === 'ou_owner');
  assert.ok(stored, 'the mentioning message was archived');
  assert.equal(stored.senderName, '一门鸽鸽', 'the name is read back and stored');
  assert.deepEqual(lookups, ['om_first'], 'one lookup for one unknown sender');
});

test('an addressed message answers with the group chatter that led up to it', async (t) => {
  const { bridge, prompts, names } = await harness(t);
  names.set('om_noise', '用户492486');
  // Someone else talks first; in mention mode the bot stays silent.
  await bridge.accept(groupEvent({
    messageId: 'om_noise', text: '等我升个依赖', senderOpenId: 'ou_other',
    sentAt: BASE - 2_000,
  }));
  assert.deepEqual(prompts, [], 'unaddressed chatter is archived, never answered');

  names.set('om_self', '一门鸽鸽');
  await bridge.accept(groupEvent({
    messageId: 'om_self', text: '@_bot 刚才说升什么来着', senderOpenId: 'ou_owner',
    sentAt: BASE - 1_000,
    mentions: [{ key: '@_bot', id: { open_id: 'ou_bot' } }],
  }));
  assert.equal(prompts.length, 1);
  const prompt = prompts[0];
  // The question stays verbatim at the end.
  assert.equal(prompt.endsWith('刚才说升什么来着'), true);
  // The earlier line arrives as context, with the person who said it.
  assert.equal(prompt.includes('<dsh_im_context>'), true);
  assert.equal(prompt.includes('等我升个依赖'), true);
  assert.equal(prompt.includes('用户492486'), true, 'the background names its author');
  // The mentioning message is not repeated as background.
  assert.equal(prompt.split('刚才说升什么来着').length, 2, 'the question appears exactly once');
});

test('a sender is resolved once, then served from the cache', async (t) => {
  const { store, groupId, bridge, names, lookups } = await harness(t);
  names.set('om_one', '一门鸽鸽');
  for (const [index, messageId] of ['om_one', 'om_two', 'om_three'].entries()) {
    await bridge.accept(groupEvent({
      messageId, text: `第 ${index + 1} 句`, senderOpenId: 'ou_owner',
      sentAt: BASE - 1_000 + index,
    }));
  }
  assert.deepEqual(lookups, ['om_one'], 'only the first message pays for the lookup');
  const page = await store.query(groupId, { limit: 10 });
  const named = page.items.filter((item) => item.senderId === 'ou_owner');
  assert.equal(named.length, 3);
  for (const item of named) assert.equal(item.senderName, '一门鸽鸽');
});

test('a message from a sender the API cannot name is still archived', async (t) => {
  const { store, groupId, bridge, lookups } = await harness(t);
  await bridge.accept(groupEvent({
    messageId: 'om_blank', text: '无名氏说了一句', senderOpenId: 'ou_nameless',
    sentAt: BASE - 1_000,
  }));
  assert.deepEqual(lookups, ['om_blank']);
  const page = await store.query(groupId, { limit: 10 });
  const stored = page.items.find((item) => item.messageId === 'om_blank')
    ?? page.items.find((item) => item.senderId === 'ou_nameless');
  assert.ok(stored, 'the message is archived even without a name');
  assert.equal(stored.text, '无名氏说了一句');
});

test('a direct message never picks up group background', async (t) => {
  const { bridge, prompts, names } = await harness(t);
  names.set('om_group_noise', '用户492486');
  await bridge.accept(groupEvent({
    messageId: 'om_group_noise', text: '群里的闲聊', senderOpenId: 'ou_other',
    sentAt: BASE - 2_000,
  }));
  const direct = groupEvent({
    messageId: 'om_direct', text: '私聊一句话', senderOpenId: 'ou_owner',
    sentAt: BASE - 1_000,
  });
  direct.message.chat_type = 'p2p';
  await bridge.accept(direct);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].includes('<dsh_im_context>'), false);
});
