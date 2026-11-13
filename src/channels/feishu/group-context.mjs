/**
 * Recent group chatter, handed to the model whenever this bot is addressed.
 *
 * A mention answers "the bot was asked something", not "the bot heard only
 * that sentence". In a busy group the question usually refers to what was said
 * a minute earlier by someone else, so a bot that sees only the mentioning
 * message answers the wrong thing — or asks who "he" is.
 *
 * The material comes from the same local archive that already records every
 * delivered group message before the response gate (`captureGroupHistory`):
 * nothing is fetched from Feishu, no permission is needed, and the archive is
 * bounded by its own retention setting. The entries ride ahead of the prompt as
 * `<dsh_im_context>` blocks of the shared injected-context grammar, so the Host
 * splits each one into its own plugin-sourced context message and the human's
 * question stays verbatim in the Session.
 *
 * This only ever runs for a message the bot will answer: a non-mentioned group
 * message is archived and dropped before any prompt is built, so the archive is
 * read on behalf of an actual question, never to keep a background tab busy.
 */

import { renderContextEntries } from '../shared/conversation/context-builder.mjs';
import { INJECTED_CONTEXT_SEPARATOR } from '../shared/context-enhancement.mjs';

/** How many earlier messages one prompt may carry. */
export const GROUP_CONTEXT_LIMIT = 20;

/** How far back those messages may reach. */
export const GROUP_CONTEXT_WINDOW_MS = 60 * 60 * 1000;

/** Per-message body bound; a long paste must not crowd out the rest. */
export const GROUP_CONTEXT_TEXT_MAX = 1_000;

/** Whole-prefix bound, so context can never dominate the prompt. */
export const GROUP_CONTEXT_BYTES_MAX = 24_000;

/**
 * Read the messages that led up to one inbound group message.
 *
 * @param groupHistory - the live archive context `{ store, groupId }` captured
 *   for this message; absent when the channel has no archive.
 * @param anchor - the incoming message `{ chatId, messageId, sentAt }`.
 * @param options.limit - how many earlier messages to read.
 * @param options.windowMs - how far back to look.
 * @param options.logger - sink for a failed read; the prompt proceeds without.
 * @returns ambient context entries, oldest first, or `[]`.
 */
export async function collectGroupContext(groupHistory, anchor, {
  limit = GROUP_CONTEXT_LIMIT,
  windowMs = GROUP_CONTEXT_WINDOW_MS,
  logger = console,
} = {}) {
  const store = groupHistory?.store;
  const groupId = groupHistory?.groupId;
  if (typeof store?.query !== 'function' || typeof groupId !== 'string' || !groupId) return [];
  const sentAt = Number(anchor?.sentAt);
  const upper = Number.isSafeInteger(sentAt) && sentAt > 0 ? sentAt : Date.now();
  const lower = upper - Math.max(1, windowMs);
  let page;
  try {
    page = await store.query(groupId, {
      kind: 'messages',
      // The archive speaks epoch milliseconds; `from`/`to` take either an ISO
      // string or a number, and a number round-trips without a timezone guess.
      from: lower,
      to: upper,
      limit: Math.max(1, Math.min(100, limit)),
    });
  } catch (error) {
    // An unreadable archive costs the background, never the answer.
    logger?.warn?.('[dsh-feishu] unable to read recent group context:', error?.message ?? String(error));
    return [];
  }
  const items = Array.isArray(page?.items) ? page.items : [];
  const self = typeof anchor?.messageId === 'string' ? anchor.messageId : '';
  const entries = [];
  for (const item of items) {
    if (typeof item?.text !== 'string' || item.text.trim() === '') continue;
    // The question itself is already in the prompt; repeating it as background
    // reads as a second person saying the same thing. `query` projects the
    // archive row without the platform message id, so the anchor is excluded by
    // time as well: background is only what came *before* the question.
    if (self !== '' && item.messageId === self) continue;
    if (self !== '' && typeof item.id === 'string' && item.id === self) continue;
    if (Number.isSafeInteger(Number(item.sentAt)) && Number(item.sentAt) >= upper) continue;
    entries.push({
      collector: 'ambient-recent',
      roomId: typeof anchor?.chatId === 'string' ? anchor.chatId : groupId,
      eventId: item.messageId ?? item.id,
      // The block schema has one `sender` slot and no separate name field, so
      // the name goes there: "who said this" is the question these entries
      // exist to answer, and an opaque `ou_…` id answers it for nobody.
      sender: item.senderName ?? item.senderId,
      name: item.senderName,
      ts: item.sentAt,
      text: item.text.length > GROUP_CONTEXT_TEXT_MAX
        ? item.text.slice(0, GROUP_CONTEXT_TEXT_MAX)
        : item.text,
    });
  }
  return entries;
}

/**
 * Render the collected background as the leading injected-context prefix.
 *
 * @param entries - entries from `collectGroupContext`.
 * @returns the joined blocks, `''` when there is nothing worth saying, or
 *   `''` once the whole prefix would exceed its budget.
 */
export function groupContextPrefix(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const block = renderContextEntries(entries);
  if (!block || Buffer.byteLength(block, 'utf8') > GROUP_CONTEXT_BYTES_MAX) return '';
  return block;
}

/**
 * Put the background in front of a prompt body, keeping the human's own text
 * last and untouched.
 *
 * @param content - the prompt body: a string, a content-part array, or undefined.
 * @param prefix - the rendered context blocks.
 * @returns the same shape with the blocks leading it.
 */
export function prependGroupContext(content, prefix) {
  if (typeof prefix !== 'string' || prefix === '') return content;
  if (typeof content === 'string') return `${prefix}${INJECTED_CONTEXT_SEPARATOR}${content}`;
  if (Array.isArray(content)) return [{ type: 'text', text: prefix }, ...content];
  // No body at all means there is no question to answer; the background would
  // be a prompt made only of other people's messages, so it is dropped with it.
  return content;
}
