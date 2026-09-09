/**
 * Builds Feishu interactive message cards with native i18n: content for
 * every configured locale is sent in one card, and the Feishu client picks
 * the matching language per viewer (falls back to en_us for anything else,
 * e.g. ja_jp, ko_kr). Layout follows docs/sentry-card/README.md.
 */

type Locale = 'zh_cn' | 'en_us';
const LOCALES: Locale[] = ['zh_cn', 'en_us'];

export type FieldLabelKey =
  | 'level'
  | 'originalLevel'
  | 'triggeredRule'
  | 'action'
  | 'status'
  | 'locationHint'
  | 'alertDescription'
  | 'resourceType';

const FIELD_LABELS: Record<FieldLabelKey, Record<Locale, string>> = {
  level: { zh_cn: '级别', en_us: 'Level' },
  originalLevel: { zh_cn: '原问题级别', en_us: 'Original issue level' },
  triggeredRule: { zh_cn: '触发规则', en_us: 'Triggered rule' },
  action: { zh_cn: '动作', en_us: 'Action' },
  status: { zh_cn: '状态', en_us: 'Status' },
  locationHint: { zh_cn: '定位线索', en_us: 'Location hint' },
  alertDescription: { zh_cn: '告警说明', en_us: 'Alert description' },
  resourceType: { zh_cn: '资源类型', en_us: 'Resource type' },
};

/** `action`/`status` field values are translated when recognized; everything else (level, culprit...) stays raw/upstream. */
const ACTION_VALUE_LABELS: Record<string, Record<Locale, string>> = {
  created: { zh_cn: '已创建', en_us: 'Created' },
  resolved: { zh_cn: '已解决', en_us: 'Resolved' },
  assigned: { zh_cn: '已分配', en_us: 'Assigned' },
  archived: { zh_cn: '已归档', en_us: 'Archived' },
  unresolved: { zh_cn: '未解决', en_us: 'Unresolved' },
};
const STATUS_VALUE_LABELS: Record<string, Record<Locale, string>> = {
  critical: { zh_cn: '严重', en_us: 'Critical' },
  warning: { zh_cn: '警告', en_us: 'Warning' },
  resolved: { zh_cn: '已恢复', en_us: 'Resolved' },
};

function fieldValueDisplay(field: AlertField, locale: Locale): string {
  const table = field.labelKey === 'action' ? ACTION_VALUE_LABELS : field.labelKey === 'status' ? STATUS_VALUE_LABELS : undefined;
  return table?.[field.value]?.[locale] ?? field.value;
}

export type TitleKey =
  | 'error'
  | 'ruleAlert'
  | 'issueCreated'
  | 'issueResolved'
  | 'issueUnresolved'
  | 'issueAssigned'
  | 'issueArchived'
  | 'metricCritical'
  | 'metricWarning'
  | 'metricResolved'
  | 'notification';

/** Fixed, translated "type/status" text — the header title is `{raw environment} · {this}`, or just this when there's no environment. */
const TITLE_TEXTS: Record<TitleKey, Record<Locale, string>> = {
  error: { zh_cn: '错误事件', en_us: 'Error event' },
  ruleAlert: { zh_cn: '规则告警', en_us: 'Rule alert' },
  issueCreated: { zh_cn: '新问题', en_us: 'New issue' },
  issueResolved: { zh_cn: '问题已解决', en_us: 'Issue resolved' },
  issueUnresolved: { zh_cn: '问题未解决', en_us: 'Issue unresolved' },
  issueAssigned: { zh_cn: '问题已分配', en_us: 'Issue assigned' },
  issueArchived: { zh_cn: '问题已归档', en_us: 'Issue archived' },
  metricCritical: { zh_cn: '指标告警 · 严重', en_us: 'Metric alert · Critical' },
  metricWarning: { zh_cn: '指标告警 · 警告', en_us: 'Metric alert · Warning' },
  metricResolved: { zh_cn: '指标告警 · 已恢复', en_us: 'Metric alert · Resolved' },
  notification: { zh_cn: 'Sentry 通知', en_us: 'Sentry notification' },
};
const UNTITLED: Record<Locale, string> = { zh_cn: '(无标题)', en_us: '(untitled)' };

type ButtonCategory = 'error' | 'ruleAlert' | 'issue' | 'metric' | 'notification';
const BUTTON_CATEGORY: Record<TitleKey, ButtonCategory> = {
  error: 'error',
  ruleAlert: 'ruleAlert',
  issueCreated: 'issue',
  issueResolved: 'issue',
  issueUnresolved: 'issue',
  issueAssigned: 'issue',
  issueArchived: 'issue',
  metricCritical: 'metric',
  metricWarning: 'metric',
  metricResolved: 'metric',
  notification: 'notification',
};
const BUTTON_LABELS: Record<ButtonCategory, Record<Locale, string>> = {
  error: { zh_cn: '查看错误事件', en_us: 'View error event' },
  ruleAlert: { zh_cn: '查看告警事件', en_us: 'View alert event' },
  issue: { zh_cn: '查看问题', en_us: 'View issue' },
  metric: { zh_cn: '查看指标告警', en_us: 'View metric alert' },
  notification: { zh_cn: '查看详情', en_us: 'View details' },
};

/**
 * The raw error/issue title can be an arbitrarily long message (e.g. a serialized
 * object or long exception message), so it's truncated in the card body rather
 * than shown in the (single-line) header.
 */
const TITLE_TEXT_MAX_LEN = 200;
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export interface AlertField {
  labelKey: FieldLabelKey;
  /** Raw upstream value (level name, culprit...) or a translatable code (action/status) — see fieldValueDisplay */
  value: string;
}

export interface AlertMessage {
  titleKey: TitleKey;
  /** Raw Sentry environment value (e.g. "production", "staging"); shown as-is, never translated. Header-only. */
  environment?: string;
  color: 'red' | 'orange' | 'green' | 'blue' | 'grey';
  /** Error/issue/metric title text, shown once as a standalone body line (raw, truncated). Not rendered at all for 'notification'. */
  summary?: string;
  /** Rendered as their own standalone lines, before the fields grid (e.g. triggered rule name) */
  standaloneFieldsBefore?: AlertField[];
  /** Rendered together as a compact grid (e.g. level, action, status) */
  fields: AlertField[];
  /** Rendered as a standalone line after a divider (culprit / alert description) */
  trailingField?: AlertField;
  /** Link to the Sentry detail page — must be a user-facing web_url, never an API url or request.url */
  url?: string;
  /** Sentry numeric project ID (string form), used to route to a per-project Feishu group */
  projectId?: string;
  /** Sentry project slug, display/auto-fill only, not used for routing */
  projectSlug?: string;
  /** Sentry project name, display/auto-fill only, not used for routing */
  projectName?: string;
}

/** Best available human-readable project label: prefer name, then slug, then a raw "#id" fallback. Shown once, in the body. */
function projectDisplay(msg: AlertMessage): string | undefined {
  return msg.projectName ?? msg.projectSlug ?? (msg.projectId ? `#${msg.projectId}` : undefined);
}

/** `{raw environment} · {translated type text}`, or just the type text when there's no environment. Environment is never translated. */
function renderTitle(msg: AlertMessage, locale: Locale): string {
  const typeText = TITLE_TEXTS[msg.titleKey][locale];
  return msg.environment ? `${msg.environment} · ${typeText}` : typeText;
}

function fieldLine(field: AlertField, locale: Locale): Record<string, unknown> {
  return {
    tag: 'div',
    text: { tag: 'plain_text', content: `${FIELD_LABELS[field.labelKey][locale]}\n${fieldValueDisplay(field, locale)}` },
  };
}

/** Build a Feishu interactive card with native i18n (viewer's Feishu client language picks the matching content) */
export function buildFeishuCard(msg: AlertMessage): Record<string, unknown> {
  const i18nTitle: Record<string, string> = {};
  const i18nElements: Record<string, unknown[]> = {};
  const project = projectDisplay(msg);
  for (const locale of LOCALES) {
    i18nTitle[locale] = renderTitle(msg, locale);
    const elements: unknown[] = [];
    if (project) {
      elements.push({ tag: 'div', text: { tag: 'plain_text', content: project } });
    }
    // 'notification' (unknown resource/action) has no title concept at all — every other type always shows one,
    // falling back to a translated placeholder rather than silently dropping the line.
    if (msg.titleKey !== 'notification') {
      elements.push({ tag: 'div', text: { tag: 'plain_text', content: truncate(msg.summary || UNTITLED[locale], TITLE_TEXT_MAX_LEN) } });
    }
    for (const field of msg.standaloneFieldsBefore ?? []) {
      elements.push(fieldLine(field, locale));
    }
    if (msg.fields.length) {
      elements.push({
        tag: 'div',
        fields: msg.fields.map((f) => ({
          is_short: true,
          text: { tag: 'plain_text', content: `${FIELD_LABELS[f.labelKey][locale]}\n${fieldValueDisplay(f, locale)}` },
        })),
      });
    }
    if (msg.trailingField) {
      elements.push({ tag: 'hr' });
      elements.push(fieldLine(msg.trailingField, locale));
    }
    if (msg.url) {
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: BUTTON_LABELS[BUTTON_CATEGORY[msg.titleKey]][locale] },
            type: 'primary',
            url: msg.url,
          },
        ],
      });
    }
    i18nElements[locale] = elements;
  }
  return {
    config: { wide_screen_mode: true },
    header: {
      template: msg.color,
      title: { tag: 'plain_text', i18n: i18nTitle },
    },
    i18n_elements: i18nElements,
  };
}
