import * as React from 'react';
import { h } from './i18n.js';
import { SET_MESSAGE_MODE_ENDPOINT, normalizeBusyMessageMode } from '../../src/channels/shared/message-mode.mjs';
import { normalizeFeishuStepCardPanels } from '../../src/channels/feishu/step-push-mode.mjs';
import {
  MAX_FEISHU_GROUP_CONTEXT_LIMIT,
  MAX_FEISHU_GROUP_CONTEXT_WINDOW_MINUTES,
  normalizeFeishuGroupContextLimit,
  normalizeFeishuGroupContextWindowMinutes,
  normalizeFeishuMentionRedaction,
} from '../../src/channels/feishu/mention-settings.mjs';
import { FEISHU_ENDPOINTS } from './channels/feishu/api.js';

function settingsFromResult(result, botId) {
  if (result?.ok !== true) throw new Error(result?.error?.message || '无法读取通用设置，请稍后重试。');
  const bot = result.value?.bots?.find((entry) => entry.botId === botId);
  if (!bot) throw new Error('找不到要修改的机器人。');
  return {
    busyMessageMode: normalizeBusyMessageMode(bot.busyMessageMode),
    stepCardPanels: normalizeFeishuStepCardPanels(bot.stepCardPanels),
    mentionRedaction: normalizeFeishuMentionRedaction(bot.mentionRedaction),
    groupContextLimit: normalizeFeishuGroupContextLimit(bot.groupContextLimit),
    groupContextWindowMinutes: normalizeFeishuGroupContextWindowMinutes(bot.groupContextWindowMinutes),
  };
}

/** Which endpoint writes one field of the general settings page. */
const SET_ENDPOINTS = {
  busyMessageMode: SET_MESSAGE_MODE_ENDPOINT,
  stepCardPanels: FEISHU_ENDPOINTS.setStepCardPanels,
  mentionRedaction: FEISHU_ENDPOINTS.setMentionRedaction,
  groupContextLimit: FEISHU_ENDPOINTS.setGroupContextLimit,
  groupContextWindowMinutes: FEISHU_ENDPOINTS.setGroupContextWindowMinutes,
};

/** The two bounded counts, in the order they read best under the switch. */
const COUNT_FIELDS = [
  {
    field: 'groupContextLimit',
    label: '读取前文条数',
    help: '被 @ 时最多向上翻多少条群消息作为背景。',
    min: 1,
    max: MAX_FEISHU_GROUP_CONTEXT_LIMIT,
    message: '读取条数必须是 1 到 100 的整数。',
  },
  {
    field: 'groupContextWindowMinutes',
    label: '读取前文时间范围（分钟）',
    help: '只把这个时间窗内说过的话当作背景。',
    min: 1,
    max: MAX_FEISHU_GROUP_CONTEXT_WINDOW_MINUTES,
    message: '读取时间范围必须是 1 到 1440 的整数分钟。',
  },
];

export function BotGeneralSettingsPage({ channel, account, rpcCall }) {
  const modeId = React.useId();
  const [settings, setSettings] = React.useState(() => ({
    busyMessageMode: 'queue',
    stepCardPanels: normalizeFeishuStepCardPanels(),
    mentionRedaction: true,
    groupContextLimit: 20,
    groupContextWindowMinutes: 60,
  }));
  // Counts are edited as text so a half-typed value is never written to the Host.
  const [drafts, setDrafts] = React.useState(() => ({ groupContextLimit: '', groupContextWindowMinutes: '' }));
  const [savedSettings, setSavedSettings] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [feedback, setFeedback] = React.useState(null);
  const mounted = React.useRef(false);
  const inFlight = React.useRef(false);
  const mode = settings.busyMessageMode;

  const load = React.useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFeedback(null);
    try {
      const value = settingsFromResult(await rpcCall('connection.status', {}), account.botId);
      if (!mounted.current) return;
      setSettings(value);
      setSavedSettings(value);
      setDrafts({
        groupContextLimit: String(value.groupContextLimit),
        groupContextWindowMinutes: String(value.groupContextWindowMinutes),
      });
    } catch (error) {
      if (mounted.current) setFeedback(error.message);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [account.botId, rpcCall]);

  React.useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load]);

  const save = async (field, value) => {
    if (inFlight.current || savedSettings === null || value === savedSettings[field]) return;
    inFlight.current = true;
    setSettings({ ...settings, [field]: value });
    setBusy(true);
    setFeedback(null);
    try {
      const saved = settingsFromResult(await rpcCall(SET_ENDPOINTS[field], {
        botId: account.botId, [field]: value,
      }), account.botId);
      if (!mounted.current) return;
      setSettings(saved);
      setSavedSettings(saved);
      setDrafts({
        groupContextLimit: String(saved.groupContextLimit),
        groupContextWindowMinutes: String(saved.groupContextWindowMinutes),
      });
    } catch (error) {
      if (mounted.current) {
        setSettings(savedSettings);
        setDrafts({
          groupContextLimit: String(savedSettings.groupContextLimit),
          groupContextWindowMinutes: String(savedSettings.groupContextWindowMinutes),
        });
        setFeedback(error.message);
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const commitCount = (spec) => {
    const raw = drafts[spec.field].trim();
    const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < spec.min || parsed > spec.max) {
      setDrafts({ ...drafts, [spec.field]: String(settings[spec.field]) });
      setFeedback(spec.message);
      return;
    }
    void save(spec.field, parsed);
  };

  return h('section', { className: 'dim-botGeneralSettings', 'aria-label': '机器人通用设置', 'aria-busy': busy },
    h('div', { className: 'dim-botGeneralList' },
      h('div', { className: 'dim-botGeneralRow' },
        h('div', { className: 'dim-botGeneralText' },
          h('label', { className: 'dim-botGeneralTitle', htmlFor: modeId }, '消息处理方式'),
          h('p', { className: 'dim-botGeneralHelp', id: `${modeId}-description` }, mode === 'queue'
            ? '当前任务结束后处理新消息'
            : '将新消息补充到当前任务')),
        h('div', { className: 'dim-botGeneralControl' },
          h('select', {
            id: modeId, value: mode, disabled: busy || savedSettings === null,
            'aria-label': '消息处理方式',
            'aria-describedby': `${modeId}-description`,
            onChange: (event) => void save('busyMessageMode', event.target.value),
          },
          h('option', { value: 'queue' }, '排队'),
          h('option', { value: 'steer' }, '插话')),
          h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
            h('path', { d: 'm4 6 4 4 4-4', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' })))),
      channel === 'feishu' ? [
        ['thinkingExpanded', '展开思考过程'],
        ['toolsExpanded', '展开工具摘要'],
      ].map(([field, label]) => h('div', { key: field, className: 'dim-botGeneralRow dim-botGeneralPanelRow' },
        h('label', { className: 'dim-botGeneralTitle', htmlFor: `${modeId}-${field}` }, label),
        h('div', { className: 'dim-botGeneralControl' },
          h('input', {
            id: `${modeId}-${field}`, type: 'checkbox', role: 'switch', className: 'dim-contextSwitch',
            checked: settings.stepCardPanels[field], disabled: busy || savedSettings === null,
            'aria-label': label, 'aria-describedby': `${modeId}-panels-description`,
            onChange: (event) => void save('stepCardPanels', {
              ...settings.stepCardPanels, [field]: event.target.checked,
            }),
          })))) : null,
      channel === 'feishu' ? h('div', { className: 'dim-botGeneralRow dim-botGeneralPanelRow' },
        h('div', { className: 'dim-botGeneralText' },
          h('label', { className: 'dim-botGeneralTitle', htmlFor: `${modeId}-mentionRedaction` }, '@ 信息脱敏'),
          h('p', { className: 'dim-botGeneralHelp', id: `${modeId}-mentionRedaction-description` },
            '开启后把被 @ 的人换成占位，只留指令；关闭后保留真实名字。')),
        h('div', { className: 'dim-botGeneralControl' },
          h('input', {
            id: `${modeId}-mentionRedaction`, type: 'checkbox', role: 'switch', className: 'dim-contextSwitch',
            checked: settings.mentionRedaction, disabled: busy || savedSettings === null,
            'aria-label': '@ 信息脱敏',
            'aria-describedby': `${modeId}-mentionRedaction-description`,
            onChange: (event) => void save('mentionRedaction', event.target.checked),
          }))) : null,
      channel === 'feishu' ? COUNT_FIELDS.map((spec) => h('div', { key: spec.field, className: 'dim-botGeneralRow dim-botGeneralPanelRow' },
        h('div', { className: 'dim-botGeneralText' },
          h('label', { className: 'dim-botGeneralTitle', htmlFor: `${modeId}-${spec.field}` }, spec.label),
          h('p', { className: 'dim-botGeneralHelp', id: `${modeId}-${spec.field}-description` }, spec.help)),
        h('div', { className: 'dim-botGeneralControl' },
          h('input', {
            id: `${modeId}-${spec.field}`, type: 'number', inputMode: 'numeric', className: 'dim-botGeneralNumber',
            value: drafts[spec.field], min: spec.min, max: spec.max,
            disabled: busy || savedSettings === null,
            'aria-label': spec.label, 'aria-describedby': `${modeId}-${spec.field}-description`,
            onChange: (event) => setDrafts({ ...drafts, [spec.field]: event.target.value }),
            onBlur: () => commitCount(spec),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commitCount(spec);
              }
            },
          })))) : null),
    channel === 'feishu' ? h('p', { className: 'dim-botGeneralHelp dim-botGeneralPanelHelp', id: `${modeId}-panels-description` },
      '仅对实时过程卡生效，任务结束后自动收起。') : null,
    feedback ? h('p', {
      className: 'dim-accessFeedback', 'data-tone': 'error', role: 'alert',
    }, feedback) : null,
    savedSettings === null && !busy ? h('div', { className: 'dim-botGeneralActions' },
      h('button', {
        type: 'button', className: 'dim-deliveryButton', onClick: () => void load(),
      }, '重新读取')) : null);
}
