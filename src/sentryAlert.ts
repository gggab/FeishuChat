import crypto from 'node:crypto';

/**
 * Sentry Internal Integration webhook 接收与飞书群转发。
 *
 * Sentry 侧配置：Settings → Developer Settings → New Internal Integration，
 * Webhook URL 填 https://<网关地址>/webhooks/sentry，Alert Rule Action 勾选，
 * 把集成的 Client Secret 配到网关的 SENTRY_WEBHOOK_SECRET。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** 校验 Sentry-Hook-Signature：HMAC-SHA256(原始请求体, Client Secret) 的 hex */
export function verifySentrySignature(rawBody: Buffer, signature: string, secret: string): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface AlertMessage {
  title: string;
  color: 'red' | 'orange' | 'green' | 'blue' | 'grey';
  /** [字段名, 字段值] 短字段对 */
  fields: Array<[string, string]>;
  /** 正文（culprit / 描述） */
  detail?: string;
  /** Sentry 详情页链接 */
  url?: string;
  /** Sentry 项目数字 ID（字符串形式），用于按项目路由到不同飞书群；取不到则 undefined，走默认群 */
  projectId?: string;
  /** Sentry 项目 slug，仅用于展示/自动回填，不参与路由 */
  projectSlug?: string;
  /** Sentry 项目名，仅用于展示/自动回填，不参与路由 */
  projectName?: string;
}

/** 从 Sentry API URL（形如 .../api/0/projects/<org>/<slug>/...）里取项目 slug */
function projectSlugFromUrl(url?: string): string | undefined {
  return String(url ?? '').match(/\/projects\/[^/]+\/([^/]+)\//)?.[1];
}

/** 把 Sentry webhook 负载解析为通用告警结构（对未知 resource 做兜底） */
export function parseSentryAlert(resource: string, body: any): AlertMessage {
  if (resource === 'event_alert') {
    const ev = body?.data?.event ?? {};
    const level = String(ev.level ?? 'error').toLowerCase();
    return {
      title: `Sentry 告警：${ev.title ?? ev.message ?? '(无标题)'}`,
      color: level === 'fatal' || level === 'error' ? 'red' : level === 'warning' ? 'orange' : 'blue',
      fields: [
        ['级别', level],
        ['触发规则', String(body?.data?.triggered_rule ?? '-')],
      ],
      detail: ev.culprit ?? ev.message,
      url: ev.web_url ?? ev.url,
      projectId: ev.project != null ? String(ev.project) : undefined,
      projectSlug: projectSlugFromUrl(ev.url),
    };
  }
  if (resource === 'metric_alert') {
    const ma = body?.data?.metric_alert ?? {};
    const resolved = body?.action === 'resolved';
    return {
      title: `Sentry 指标告警${resolved ? '（已恢复）' : ''}：${ma.title ?? '(无标题)'}`,
      color: resolved ? 'green' : 'red',
      fields: [['状态', String(body?.action ?? '-')]],
      detail: body?.data?.description_text ?? body?.data?.description,
      url: body?.data?.web_url,
      // metric_alert payload 没有数字项目 ID，只有 slug 数组，无法参与按 ID 路由
      projectSlug: ma.alert_rule?.projects?.[0],
    };
  }
  if (resource === 'issue') {
    const issue = body?.data?.issue ?? {};
    const action = String(body?.action ?? '-');
    return {
      title: `Sentry Issue：${issue.title ?? '(无标题)'}`,
      color: action === 'resolved' ? 'green' : issue.level === 'warning' ? 'orange' : 'red',
      fields: [
        ['动作', action],
        ['级别', String(issue.level ?? '-')],
        ['项目', String(issue.project?.name ?? '-')],
      ],
      detail: issue.culprit,
      url: issue.web_url,
      projectId: issue.project?.id != null ? String(issue.project.id) : undefined,
      projectSlug: issue.project?.slug,
      projectName: issue.project?.name,
    };
  }
  if (resource === 'error') {
    const err = body?.data?.error ?? {};
    const level = String(err.level ?? 'error').toLowerCase();
    // error payload 里 project 只是数字 ID，没有名字；从详情 URL 里的 /projects/<org>/<slug>/ 取 slug 兜底展示
    const projectSlug = projectSlugFromUrl(err.url);
    return {
      title: `Sentry 报错：${err.title ?? '(无标题)'}`,
      color: level === 'fatal' || level === 'error' ? 'red' : level === 'warning' ? 'orange' : 'blue',
      fields: [
        ['级别', level],
        ['项目', projectSlug ?? String(err.project ?? '-')],
      ],
      detail: err.culprit,
      url: err.web_url,
      projectId: err.project != null ? String(err.project) : undefined,
      projectSlug,
    };
  }
  // 未适配精细样式的 resource 类型：先打印完整 payload，方便后续按真实字段补充解析
  console.log(`[sentry] 未识别的 resource=${resource}，原始 payload：${JSON.stringify(body)}`);
  return {
    title: `Sentry 通知（${resource}）`,
    color: 'grey',
    fields: [['动作', String(body?.action ?? '-')]],
    url: body?.data?.web_url,
  };
}

/** 生成飞书 interactive 卡片（供 im/v1/messages 的 msg_type=interactive 使用） */
export function buildFeishuCard(msg: AlertMessage): Record<string, unknown> {
  const elements: unknown[] = [
    {
      tag: 'div',
      fields: msg.fields.map(([name, value]) => ({
        is_short: true,
        text: { tag: 'lark_md', content: `**${name}**\n${value}` },
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
          text: { tag: 'plain_text', content: '查看详情' },
          type: 'primary',
          url: msg.url,
        },
      ],
    });
  }
  return {
    config: { wide_screen_mode: true },
    header: {
      template: msg.color,
      title: { tag: 'plain_text', content: msg.title },
    },
    elements,
  };
}
