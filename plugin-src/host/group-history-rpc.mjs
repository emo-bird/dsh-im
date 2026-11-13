export const GROUP_HISTORY_ENDPOINTS = Object.freeze({
  get: 'settings.group-history.get', set: 'settings.group-history.set',
});

// Each settable key, mapped to the store method that validates and persists it.
// The request may carry any subset: the settings surface saves one field at a
// time, and the store serialises every write through one chain, so applying a
// subset never drops a sibling value.
const SETTERS = Object.freeze({
  groupHistoryRetentionDays: (store, value) => store.setRetentionDays(value),
  groupHistoryContextLimit: (store, value) => store.setContextLimit(value),
  groupHistoryContextWindowMinutes: (store, value) => store.setContextWindowMinutes(value),
});

export function createGroupHistoryRpcHandler(store) {
  return async (endpoint, payload, signal) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || signal?.aborted) {
      return { ok: false, error: { code: 'bad-request', message: '群记录设置请求无效。' } };
    }
    const keys = Object.keys(payload).sort();
    try {
      let value;
      if (endpoint === GROUP_HISTORY_ENDPOINTS.get && keys.length === 0) value = await store.settings();
      else if (endpoint === GROUP_HISTORY_ENDPOINTS.set && keys.length > 0 && keys.every((key) => Object.hasOwn(SETTERS, key))) {
        // Sequentially, so a request carrying several fields observes each
        // setter's validation before the next one writes.
        for (const key of keys) value = await SETTERS[key](store, payload[key]);
      } else throw new Error('群记录设置请求无效。');
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: { code: error.code ?? 'group-history-unavailable',
        message: error.code === 'group-history-invalid' ? error.message : '无法读取或保存群记录设置，请稍后重试。' } };
    }
  };
}
