/**
 * Per-bot presentation of an inbound group message.
 *
 * Both facts used to be fixed: every @ was erased before the model saw the
 * text, and every answered group message quoted twenty archived lines from the
 * last hour. They are now settings on the bot itself, because two bots in one
 * group rarely want the same privacy or the same amount of background.
 */

/** @-mentions are erased by default; that is what every bot did before. */
export const DEFAULT_FEISHU_MENTION_REDACTION = true;

/** How many archived messages an answered group message may quote. */
export const DEFAULT_FEISHU_GROUP_CONTEXT_LIMIT = 20;
export const MAX_FEISHU_GROUP_CONTEXT_LIMIT = 100;

/** How far back, in minutes, an answered group message may reach. */
export const DEFAULT_FEISHU_GROUP_CONTEXT_WINDOW_MINUTES = 60;
export const MAX_FEISHU_GROUP_CONTEXT_WINDOW_MINUTES = 1440;

function positiveInRange(value, max) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : null;
}

export function normalizeFeishuMentionRedaction(value) {
  return typeof value === 'boolean' ? value : DEFAULT_FEISHU_MENTION_REDACTION;
}

export function normalizeFeishuGroupContextLimit(value) {
  return positiveInRange(value, MAX_FEISHU_GROUP_CONTEXT_LIMIT)
    ?? DEFAULT_FEISHU_GROUP_CONTEXT_LIMIT;
}

export function normalizeFeishuGroupContextWindowMinutes(value) {
  return positiveInRange(value, MAX_FEISHU_GROUP_CONTEXT_WINDOW_MINUTES)
    ?? DEFAULT_FEISHU_GROUP_CONTEXT_WINDOW_MINUTES;
}

export function isFeishuMentionRedaction(value) {
  return typeof value === 'boolean';
}

export function isFeishuGroupContextLimit(value) {
  return positiveInRange(value, MAX_FEISHU_GROUP_CONTEXT_LIMIT) !== null;
}

export function isFeishuGroupContextWindowMinutes(value) {
  return positiveInRange(value, MAX_FEISHU_GROUP_CONTEXT_WINDOW_MINUTES) !== null;
}
