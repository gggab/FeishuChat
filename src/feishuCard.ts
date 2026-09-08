/**
 * Builds Feishu interactive message cards with native i18n: content for
 * every configured locale is sent in one card, and the Feishu client picks
 * the matching language per viewer (falls back to en_us for anything else,
 * e.g. ja_jp, ko_kr).
 */

type Locale = 'zh_cn' | 'en_us';
const LOCALES: Locale[] = ['zh_cn', 'en_us'];

type FieldLabelKey = 'level' | 'project' | 'triggeredRule' | 'action' | 'status';
const FIELD_LABELS: Record<FieldLabelKey, Record<Locale, string>> = {
  level: { zh_cn: '级别', en_us: 'Level' },
  project: { zh_cn: '项目', en_us: 'Project' },
  triggeredRule: { zh_cn: '触发规则', en_us: 'Triggered rule' },
  action: { zh_cn: '动作', en_us: 'Action' },
  status: { zh_cn: '状态', en_us: 'Status' },
};

type TitlePrefixKey = 'alert' | 'metricAlert' | 'metricAlertResolved' | 'issue' | 'error' | 'notification';
const TITLE_PREFIXES: Record<TitlePrefixKey, Record<Locale, string>> = {
  alert: { zh_cn: 'Sentry 告警', en_us: 'Sentry Alert' },
  metricAlert: { zh_cn: 'Sentry 指标告警', en_us: 'Sentry Metric Alert' },
  metricAlertResolved: { zh_cn: 'Sentry 指标告警（已恢复）', en_us: 'Sentry Metric Alert (resolved)' },
  issue: { zh_cn: 'Sentry Issue', en_us: 'Sentry Issue' },
  error: { zh_cn: 'Sentry 报错', en_us: 'Sentry Error' },
  notification: { zh_cn: 'Sentry 通知', en_us: 'Sentry Notification' },
};
const UNTITLED: Record<Locale, string> = { zh_cn: '(无标题)', en_us: '(untitled)' };
const VIEW_DETAILS: Record<Locale, string> = { zh_cn: '查看详情', en_us: 'View details' };

export interface AlertField {
  labelKey: FieldLabelKey;
  /** Raw value (level name, action, project name...) — already language-neutral, not translated */
  value: string;
}

export interface AlertMessage {
  titlePrefixKey: TitlePrefixKey;
  /** Dynamic part after the title prefix (error title, issue title...); undefined shows a translated placeholder */
  titleText?: string;
  color: 'red' | 'orange' | 'green' | 'blue' | 'grey';
  fields: AlertField[];
  /** Body text (culprit / description) */
  detail?: string;
  /** Link to the Sentry detail page */
  url?: string;
  /** Sentry numeric project ID (string form), used to route to a per-project Feishu group */
  projectId?: string;
  /** Sentry project slug, display/auto-fill only, not used for routing */
  projectSlug?: string;
  /** Sentry project name, display/auto-fill only, not used for routing */
  projectName?: string;
}

/** Render the title for one locale, e.g. "Sentry Error: TypeError: ..." or "Sentry Notification (comment)" */
function renderTitle(msg: AlertMessage, locale: Locale): string {
  const prefix = TITLE_PREFIXES[msg.titlePrefixKey][locale];
  if (msg.titlePrefixKey === 'notification') {
    return `${prefix} (${msg.titleText})`;
  }
  return `${prefix}: ${msg.titleText || UNTITLED[locale]}`;
}

/** Build a Feishu interactive card with native i18n (viewer's Feishu client language picks the matching content) */
export function buildFeishuCard(msg: AlertMessage): Record<string, unknown> {
  const i18nTitle: Record<string, string> = {};
  const i18nElements: Record<string, unknown[]> = {};
  for (const locale of LOCALES) {
    i18nTitle[locale] = renderTitle(msg, locale);
    const elements: unknown[] = [
      {
        tag: 'div',
        fields: msg.fields.map((f) => ({
          is_short: true,
          text: { tag: 'lark_md', content: `**${FIELD_LABELS[f.labelKey][locale]}**\n${f.value}` },
        })),
      },
    ];
    if (msg.detail) {
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: msg.detail } });
    }
    if (msg.url) {
      elements.push({
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: VIEW_DETAILS[locale] },
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
