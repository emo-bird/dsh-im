/**
 * Pulls a group's recent messages back from Feishu and files whatever the local
 * archive is missing.
 *
 * Feishu only pushes a bot the messages it is addressed with — another bot's
 * chatter never arrives as an event, and neither do the human messages around
 * it unless the tenant grants "all group messages". The archive therefore grew
 * from arrivals only, and a bot could not read what its neighbour in the same
 * group had said. This module asks the provider for the chat's recent window
 * and writes each message through the same `capture()` path as an event, so the
 * archive holds one row per platform message no matter which way it arrived.
 */

/** How far back a single sweep looks. */
export const GROUP_BACKFILL_WINDOW_MS = 30 * 60_000;
/** How long a chat waits between sweeps; the sweep is not on the reply path. */
export const GROUP_BACKFILL_INTERVAL_MS = 5 * 60_000;
/** Page size the provider accepts for chat message listing. */
const PAGE_SIZE = 50;
/** Upper bound on pages per sweep so a burst can never turn into a long read. */
const MAX_PAGES = 3;
/** The capability text every row of this archive carries. */
export const GROUP_BACKFILL_CAPABILITY = '需授权 im:message.group_msg；授权采集不改变群回复模式。';

/** Strings inside a card/post payload, in reading order. */
function collectText(node, out) {
  if (typeof node === 'string') return out;
  if (Array.isArray(node)) {
    for (const entry of node) collectText(entry, out);
    return out;
  }
  if (!node || typeof node !== 'object') return out;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'text' || key === 'title') {
      if (typeof value === 'string' && value.trim()) out.push(value);
    } else {
      collectText(value, out);
    }
  }
  return out;
}

/** The readable text of one listed message, or `''` when it carries none. */
export function listedMessageText(item) {
  const body = typeof item?.body?.content === 'string' ? item.body.content : '';
  if (!body) return '';
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return '';
  }
  if (item?.msg_type === 'text' && typeof parsed?.text === 'string') return parsed.text;
  return collectText(parsed, []).join(' ');
}

/** `@_user_1` is a delivery artifact; the archive keeps the name it stood for. */
export function namedMentions(text, mentions) {
  let result = typeof text === 'string' ? text : '';
  for (const mention of Array.isArray(mentions) ? mentions : []) {
    const key = typeof mention?.key === 'string' ? mention.key : '';
    if (!key || !result.includes(key)) continue;
    const name = typeof mention?.name === 'string' && mention.name.trim() ? mention.name.trim() : '';
    result = result.split(key).join(name ? `@${name}` : '');
  }
  return result.trim();
}

/** One listed message as a `GroupHistoryStore.capture()` entry, or null. */
function captureEntry(item, { channel, scope, chatId, groupName }) {
  const messageId = typeof item?.message_id === 'string' ? item.message_id : '';
  const senderId = typeof item?.sender?.id === 'string' ? item.sender.id : '';
  if (!messageId || !senderId) return null;
  const sentAt = Number(item?.create_time);
  if (!Number.isFinite(sentAt) || sentAt <= 0) return null;
  const senderName = typeof item?.sender?.sender_name === 'string' ? item.sender.sender_name : '';
  return {
    channel,
    scope,
    groupId: chatId,
    groupName,
    messageId,
    senderId,
    senderName,
    sentAt,
    type: typeof item?.msg_type === 'string' && item.msg_type ? item.msg_type : 'text',
    text: namedMentions(listedMessageText(item), item?.mentions),
    threadId: typeof item?.thread_id === 'string' ? item.thread_id : undefined,
    replyToMessageId: typeof item?.parent_id === 'string' ? item.parent_id : undefined,
    capability: GROUP_BACKFILL_CAPABILITY,
  };
}

/**
 * Sweeps one chat's recent window and captures every message it does not
 * already hold. Never throws: a missing permission or a provider hiccup is
 * logged and the caller carries on with the turn it was really serving.
 *
 * @returns the number of rows the provider offered, for logging and tests.
 */
export async function backfillGroupHistory(client, store, {
  chatId,
  channel = 'feishu',
  scope = 'feishu',
  groupName,
  until = Date.now(),
  windowMs = GROUP_BACKFILL_WINDOW_MS,
  pageSize = PAGE_SIZE,
  maxPages = MAX_PAGES,
  logger = console,
  signal,
} = {}) {
  if (typeof client?.im?.v1?.message?.list !== 'function') return 0;
  if (!store || typeof store.capture !== 'function') return 0;
  if (typeof chatId !== 'string' || !chatId) return 0;
  const end = Math.floor(until / 1000);
  const start = Math.max(0, end - Math.ceil(Math.max(1, windowMs) / 1000));
  let pageToken;
  let seen = 0;
  for (let page = 0; page < Math.max(1, maxPages); page += 1) {
    let response;
    try {
      response = await client.im.v1.message.list({
        params: {
          container_id_type: 'chat',
          container_id: chatId,
          start_time: String(start),
          end_time: String(end),
          sort_type: 'ByCreateTimeDesc',
          page_size: Math.max(1, Math.min(PAGE_SIZE, pageSize)),
          with_sender_name: true,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      }, { signal });
    } catch (error) {
      if (error?.name === 'AbortError') return seen;
      // Missing `im:message.group_msg` is the common case and is not worth a
      // stack trace on every sweep.
      logger?.warn?.('[dsh-feishu] unable to list group messages for the archive:', error?.message ?? String(error));
      return seen;
    }
    signal?.throwIfAborted();
    const data = response?.data ?? {};
    if (response?.code) {
      logger?.warn?.(`[dsh-feishu] group message listing refused (${response.code}):`, response.msg ?? '');
      return seen;
    }
    const items = Array.isArray(data.items) ? data.items : [];
    for (const item of items) {
      seen += 1;
      const entry = captureEntry(item, { channel, scope, chatId, groupName });
      if (!entry) continue;
      try {
        await store.capture(entry);
      } catch (error) {
        logger?.warn?.('[dsh-im] unable to save an archived group message:', error?.message ?? String(error));
      }
    }
    if (data.has_more !== true || typeof data.page_token !== 'string' || !data.page_token) return seen;
    pageToken = data.page_token;
  }
  return seen;
}
