import * as React from 'react';
import { h } from './i18n.js';

export const GROUP_HISTORY_SETTINGS_ENDPOINTS = Object.freeze({
  get: 'settings.group-history.get', set: 'settings.group-history.set',
});

const LIMIT_MAX = 100;
const WINDOW_MAX = 1440;

// Fixed sentences rather than interpolated ones: the dictionaries carry whole
// keys, and a sentence assembled at runtime would fall through to the
// phrase-by-phrase path and read wrong in English and Russian.
const LIMIT_MESSAGE = '读取条数必须是 1 到 100 的整数。';
const WINDOW_MESSAGE = '读取时间范围必须是 1 到 1440 的整数分钟。';

function result(value) {
  if (value?.ok === false) throw new Error(value.error?.message || '无法读取或保存群记录设置，请稍后重试。');
  return value?.ok === true ? value.value : value;
}

// A count field: digits only, inside the range the Host accepts, so the reader
// sees the rejection before the round trip and the message names the limits.
function parseCount(raw, max, message) {
  const text = String(raw ?? '').trim();
  const value = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < 1 || value > max) return { error: message };
  return { value };
}

export function GroupHistorySettings({ rpcCall }) {
  const [days, setDays] = React.useState('14');
  const [limit, setLimit] = React.useState('20');
  const [minutes, setMinutes] = React.useState('60');
  const [phase, setPhase] = React.useState('loading');
  const [error, setError] = React.useState(null);
  const [notice, setNotice] = React.useState(null);
  const mounted = React.useRef(false);
  const busy = React.useRef(false);
  const id = React.useId();
  const load = React.useCallback(async (signal) => {
    setPhase('loading'); setError(null);
    try {
      const settings = result(await rpcCall(GROUP_HISTORY_SETTINGS_ENDPOINTS.get, {}, signal));
      if (signal?.aborted || !mounted.current) return;
      if (!Number.isSafeInteger(settings?.groupHistoryRetentionDays)) throw new Error('群记录设置返回了无法识别的响应。');
      setDays(String(settings.groupHistoryRetentionDays));
      // Both context keys arrived after the first release, and a Host that has
      // not been rebuilt yet answers without them: fall back to the defaults it
      // would itself use rather than rendering an empty box.
      if (Number.isSafeInteger(settings?.groupHistoryContextLimit)) setLimit(String(settings.groupHistoryContextLimit));
      if (Number.isSafeInteger(settings?.groupHistoryContextWindowMinutes)) setMinutes(String(settings.groupHistoryContextWindowMinutes));
      setError(settings.error ?? null); setPhase('ready');
    } catch (caught) {
      if (signal?.aborted || !mounted.current) return;
      setError(caught.message); setPhase('error');
    }
  }, [rpcCall]);
  React.useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void load(controller.signal);
    return () => { mounted.current = false; controller.abort(); };
  }, [load]);

  const save = async (event) => {
    event.preventDefault();
    if (busy.current || phase !== 'ready') return;
    const dayCount = parseCount(days, Number.MAX_SAFE_INTEGER, '保留天数必须为正整数。');
    if (dayCount.error) { setError(dayCount.error); return; }
    const limitCount = parseCount(limit, LIMIT_MAX, LIMIT_MESSAGE);
    if (limitCount.error) { setError(limitCount.error); return; }
    const windowCount = parseCount(minutes, WINDOW_MAX, WINDOW_MESSAGE);
    if (windowCount.error) { setError(windowCount.error); return; }
    busy.current = true; setPhase('saving'); setError(null); setNotice(null);
    try {
      const settings = result(await rpcCall(GROUP_HISTORY_SETTINGS_ENDPOINTS.set, {
        groupHistoryRetentionDays: dayCount.value,
        groupHistoryContextLimit: limitCount.value,
        groupHistoryContextWindowMinutes: windowCount.value,
      }));
      if (mounted.current) {
        setDays(String(settings.groupHistoryRetentionDays));
        if (Number.isSafeInteger(settings?.groupHistoryContextLimit)) setLimit(String(settings.groupHistoryContextLimit));
        if (Number.isSafeInteger(settings?.groupHistoryContextWindowMinutes)) setMinutes(String(settings.groupHistoryContextWindowMinutes));
        setNotice('已保存');
      }
    } catch (caught) { if (mounted.current) setError(caught.message); }
    finally { busy.current = false; if (mounted.current) setPhase('ready'); }
  };

  const disabled = phase !== 'ready';
  const numberInput = (suffix, field, state) => h('div', { className: 'dim-botGeneralControl dim-groupHistoryControl' },
    h('input', { id: `${id}-${suffix}`, className: 'dim-groupHistoryInput', type: 'number', min: 1, step: 1,
      value: state.value, disabled, 'aria-describedby': `${id}-${suffix}-description`,
      onChange: (event) => { state.set(event.target.value); setNotice(null); } }),
    h('span', { className: 'dim-groupHistoryUnit' }, state.unit));

  return h('section', { className: 'dim-botGeneralSettings dim-groupHistorySettings', 'aria-label': '群聊天记录', 'aria-busy': phase === 'loading' || phase === 'saving' },
    h('form', { onSubmit: save },
      h('div', { className: 'dim-botGeneralRow' },
        h('div', { className: 'dim-botGeneralText' },
          h('label', { className: 'dim-botGeneralTitle', htmlFor: `${id}-days` }, '群聊天记录保留天数'),
          h('p', { className: 'dim-botGeneralHelp', id: `${id}-days-description` }, '过期的群消息和文件会自动清理。')),
        numberInput('days', 'days', { value: days, set: setDays, unit: '天' })),
      h('div', { className: 'dim-botGeneralRow' },
        h('div', { className: 'dim-botGeneralText' },
          h('label', { className: 'dim-botGeneralTitle', htmlFor: `${id}-limit` }, '被 @ 时读取的前文条数'),
          h('p', { className: 'dim-botGeneralHelp', id: `${id}-limit-description` }, '只影响被 @ 或回复的那条回答：机器人会带着群里的前文理解语境，但仍然只回答被 @ 的消息。最多 100 条。')),
        numberInput('limit', 'limit', { value: limit, set: setLimit, unit: '条' })),
      h('div', { className: 'dim-botGeneralRow' },
        h('div', { className: 'dim-botGeneralText' },
          h('label', { className: 'dim-botGeneralTitle', htmlFor: `${id}-minutes` }, '被 @ 时读取前文的时间范围'),
          h('p', { className: 'dim-botGeneralHelp', id: `${id}-minutes-description` }, '只取这段时间内的群消息；条数与时间两个上限同时生效。最多 1440 分钟。')),
        numberInput('minutes', 'minutes', { value: minutes, set: setMinutes, unit: '分钟' })),
      h('div', { className: 'dim-botGeneralActions' },
        h('button', { type: 'submit', className: 'dim-deliveryButton dim-groupHistorySave', 'data-kind': 'primary',
          disabled }, phase === 'saving' ? '保存中…' : '保存'))),
    phase === 'loading' ? h('p', { role: 'status', className: 'dim-botGeneralHelp dim-groupHistoryFeedback' }, '正在读取群记录设置…') : null,
    error ? h('p', { role: 'alert', className: 'dim-accessFeedback dim-groupHistoryFeedback', 'data-tone': 'error' }, error) : null,
    notice ? h('p', { role: 'status', className: 'dim-botGeneralHelp dim-groupHistoryFeedback' }, notice) : null);
}
