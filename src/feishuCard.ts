/**
 * Builds Feishu interactive message cards (Card JSON 1.0) with native i18n: content for
 * every configured locale is sent in one card, and the Feishu client picks the matching
 * language per viewer (falls back to en_us for anything else, e.g. ja_jp, ko_kr).
 *
 * The "错误告警" (event_alert/error) card layout follows the Figma spec —
 * https://www.figma.com/design/3pg9cagKXQp0iUsTZEpTLP/Feishu-Card?node-id=24-2 — and
 * docs/sentry-card/event-alert-card-content.md. The "问题已解决" (activity_alert resolved)
 * card follows node-id=69-2 and docs/sentry-card/activity-alert-card-content.md. Other
 * alert kinds (issue/metric_alert/fallback) reuse the same building blocks but weren't
 * part of either redesign.
 */

type Locale = 'zh_cn' | 'en_us';
const LOCALES: Locale[] = ['zh_cn', 'en_us'];

export type FieldLabelKey =
  | 'level'
  | 'originalLevel'
  | 'eventTime'
  | 'triggeredRule'
  | 'locationHint'
  | 'release'
  | 'crashModule'
  | 'device'
  | 'appVersion'
  | 'action'
  | 'status'
  | 'alertDescription'
  | 'resourceType'
  | 'issueId'
  | 'changedBy'
  | 'alertName'
  | 'totalEvents'
  | 'totalUsers'
  | 'firstSeen'
  | 'lastSeen';

const FIELD_LABELS: Record<FieldLabelKey, Record<Locale, string>> = {
  level: { zh_cn: '级别', en_us: 'Level' },
  originalLevel: { zh_cn: '原问题级别', en_us: 'Original issue level' },
  eventTime: { zh_cn: '时间', en_us: 'Event time' },
  triggeredRule: { zh_cn: '触发规则', en_us: 'Triggered rule' },
  locationHint: { zh_cn: '定位线索', en_us: 'Location hint' },
  release: { zh_cn: '版本', en_us: 'Release' },
  crashModule: { zh_cn: '崩溃模块', en_us: 'Crash module' },
  device: { zh_cn: '设备', en_us: 'Device' },
  appVersion: { zh_cn: 'App 版本', en_us: 'App version' },
  action: { zh_cn: '动作', en_us: 'Action' },
  status: { zh_cn: '状态', en_us: 'Status' },
  alertDescription: { zh_cn: '告警说明', en_us: 'Alert description' },
  resourceType: { zh_cn: '资源类型', en_us: 'Resource type' },
  issueId: { zh_cn: '问题编号', en_us: 'Issue ID' },
  changedBy: { zh_cn: '操作人', en_us: 'Changed by' },
  alertName: { zh_cn: '告警名称', en_us: 'Alert name' },
  totalEvents: { zh_cn: '累计事件数', en_us: 'Total events' },
  totalUsers: { zh_cn: '累计用户数', en_us: 'Total users' },
  firstSeen: { zh_cn: '首次出现', en_us: 'First seen' },
  lastSeen: { zh_cn: '最近出现', en_us: 'Last seen' },
};

/** Fixed, translated standalone caption lines that aren't a label/value field (e.g. a disclaimer under a stats block). */
export type NoteKey = 'cumulativeStats';
const NOTE_TEXTS: Record<NoteKey, Record<Locale, string>> = {
  cumulativeStats: { zh_cn: '统计为该 Issue 的累计值。', en_us: 'Cumulative totals for this issue.' },
};

/** `action`/`status` field values are translated when recognized; everything else (level, culprit, release...) stays raw/upstream. */
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
  | 'errorAlert'
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
  // event_alert and error resources are unified into one "错误告警" concept — see docs/sentry-card/event-alert-card-content.md
  errorAlert: { zh_cn: '错误告警', en_us: 'Error alert' },
  issueCreated: { zh_cn: '新问题', en_us: 'New issue' },
  issueResolved: { zh_cn: '已解决', en_us: 'Resolved' },
  issueUnresolved: { zh_cn: '问题未解决', en_us: 'Issue unresolved' },
  issueAssigned: { zh_cn: '问题已分配', en_us: 'Issue assigned' },
  issueArchived: { zh_cn: '问题已归档', en_us: 'Issue archived' },
  metricCritical: { zh_cn: '指标告警 · 严重', en_us: 'Metric alert · Critical' },
  metricWarning: { zh_cn: '指标告警 · 警告', en_us: 'Metric alert · Warning' },
  metricResolved: { zh_cn: '指标告警 · 已恢复', en_us: 'Metric alert · Resolved' },
  notification: { zh_cn: 'Sentry 通知', en_us: 'Sentry notification' },
};
const UNTITLED: Record<Locale, string> = { zh_cn: '(无标题)', en_us: '(untitled)' };

/** Button label follows the alert category — event_alert/error and unknown/fallback both use the same generic "view details" text. */
type ButtonCategory = 'errorAlert' | 'issue' | 'metric' | 'generic';
const BUTTON_CATEGORY: Record<TitleKey, ButtonCategory> = {
  errorAlert: 'errorAlert',
  issueCreated: 'issue',
  issueResolved: 'issue',
  issueUnresolved: 'issue',
  issueAssigned: 'issue',
  issueArchived: 'issue',
  metricCritical: 'metric',
  metricWarning: 'metric',
  metricResolved: 'metric',
  notification: 'generic',
};
const BUTTON_LABELS: Record<ButtonCategory, Record<Locale, string>> = {
  errorAlert: { zh_cn: '查看详情', en_us: 'View details' },
  issue: { zh_cn: '查看问题', en_us: 'View issue' },
  metric: { zh_cn: '查看指标告警', en_us: 'View metric alert' },
  generic: { zh_cn: '查看详情', en_us: 'View details' },
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
  /** Raw upstream value (level name, culprit, release...) or a translatable code (action/status) — see fieldValueDisplay */
  value: string;
}

/**
 * One row of body content, following the Figma spec's "并列字段 / 独占整行字段" pattern:
 * - 'full': the field always takes the full card width (e.g. release, crash module).
 * - 'short': fields flow left-to-right and Feishu wraps them 2-per-row. Missing fields are
 *   simply not passed in, so remaining fields reflow next to whatever comes after them —
 *   this is what makes the Figma "missing fields" narrow-card case show two otherwise
 *   unrelated fields side by side instead of leaving blank columns.
 */
export type ContentBlock = { kind: 'full'; field: AlertField } | { kind: 'short'; fields: AlertField[] } | { kind: 'note'; noteKey: NoteKey };

/** Build a 'short' block from possibly-missing fields, in order; omitted entirely if none are present. */
export function shortFields(...fields: (AlertField | undefined)[]): ContentBlock[] {
  const present = fields.filter((f): f is AlertField => f != null);
  return present.length ? [{ kind: 'short', fields: present }] : [];
}

/** Build a 'full' block from a possibly-missing field; omitted entirely if not present. */
export function fullField(field: AlertField | undefined): ContentBlock[] {
  return field ? [{ kind: 'full', field }] : [];
}

/** Build a standalone caption line, only when `present` (e.g. gated on the stats it explains actually being shown). */
export function noteBlock(noteKey: NoteKey, present: boolean): ContentBlock[] {
  return present ? [{ kind: 'note', noteKey }] : [];
}

export interface AlertMessage {
  titleKey: TitleKey;
  /** Raw Sentry environment value (e.g. "production", "staging"); shown as-is, never translated. Header-only. */
  environment?: string;
  color: 'red' | 'orange' | 'green' | 'blue' | 'grey';
  /** Error/issue/metric title text, shown once as a standalone body line (raw, truncated). Not rendered at all for 'notification'. */
  summary?: string;
  /** Rendered in order, after project/summary and before the divider+button — see ContentBlock. */
  blocks: ContentBlock[];
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

function textLine(content: string): Record<string, unknown> {
  return { tag: 'div', text: { tag: 'plain_text', content } };
}

/**
 * Markdown-sensitive characters that could otherwise be (mis)interpreted by lark_md if they
 * happen to appear in upstream text (error messages, stack traces...) — escaped so raw content
 * always renders as literal text instead of accidentally toggling emphasis/links/etc.
 */
function escapeLarkMd(text: string): string {
  return text.replace(/[\\`*_~<>[\]]/g, (ch) => `\\${ch}`);
}

/**
 * The error/issue summary line renders bolder than the rest of the body (Figma: 17px medium vs.
 * 14px regular for field values), matching every card the design covers. Feishu's Card JSON
 * (1.0 or 2.0's rich-text component) has no `<font color>` tag and no way to set an arbitrary hex
 * color on plain text — the only color-capable inline element is `<text_tag>`, a small colored
 * badge/chip from a fixed named palette, which would add an unwanted pill shape here. So only the
 * bold weight from the Figma spec is reproduced; the grey (#646A73) field-label color is not.
 */
function boldTextLine(content: string): Record<string, unknown> {
  return { tag: 'div', text: { tag: 'lark_md', content: `**${escapeLarkMd(content)}**` } };
}

/** Label suffixed with ":" — with no color available to set field labels apart (see boldTextLine above), the colon is the substitute visual cue. */
function fieldLabel(field: AlertField, locale: Locale): string {
  return `${FIELD_LABELS[field.labelKey][locale]}:`;
}

function fieldLine(field: AlertField, locale: Locale): Record<string, unknown> {
  return textLine(`${fieldLabel(field, locale)}\n${fieldValueDisplay(field, locale)}`);
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
      elements.push(textLine(project));
    }
    // 'notification' (unknown resource/action) has no title concept at all — every other type always shows one,
    // falling back to a translated placeholder rather than silently dropping the line.
    if (msg.titleKey !== 'notification') {
      elements.push(boldTextLine(truncate(msg.summary || UNTITLED[locale], TITLE_TEXT_MAX_LEN)));
    }
    for (const block of msg.blocks) {
      if (block.kind === 'full') {
        elements.push(fieldLine(block.field, locale));
      } else if (block.kind === 'note') {
        elements.push(textLine(NOTE_TEXTS[block.noteKey][locale]));
      } else if (block.fields.length) {
        elements.push({
          tag: 'div',
          fields: block.fields.map((f) => ({
            is_short: true,
            text: { tag: 'plain_text', content: `${fieldLabel(f, locale)}\n${fieldValueDisplay(f, locale)}` },
          })),
        });
      }
    }
    if (msg.url) {
      elements.push({ tag: 'hr' });
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: BUTTON_LABELS[BUTTON_CATEGORY[msg.titleKey]][locale] },
            // 'default' renders as Feishu's outlined (not filled) button, matching the Figma spec
            type: 'default',
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
