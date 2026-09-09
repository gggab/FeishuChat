import crypto from 'node:crypto';
import { AlertField, AlertMessage, ContentBlock, fullField, noteBlock, shortFields, TitleKey } from './feishuCard.js';

/**
 * Sentry Internal Integration webhook receiver.
 *
 * Sentry side: Settings -> Developer Settings -> New Internal Integration,
 * set the Webhook URL to https://<gateway>/webhooks/sentry, enable the
 * Alert Rule Action, and put the integration's Client Secret into the
 * gateway's SENTRY_WEBHOOK_SECRET.
 *
 * Card rendering (native Feishu i18n) lives in ./feishuCard.js — this file
 * only verifies the webhook signature and parses the payload into the
 * generic AlertMessage structure that feishuCard.js knows how to render.
 * The event_alert/error "错误告警" field/layout contract follows
 * docs/sentry-card/event-alert-card-content.md.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Verify Sentry-Hook-Signature: hex HMAC-SHA256(raw body, Client Secret) */
export function verifySentrySignature(rawBody: Buffer, signature: string, secret: string): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Extract a project slug from a Sentry API URL like .../api/0/projects/<org>/<slug>/... */
function projectSlugFromUrl(url?: string): string | undefined {
  return String(url ?? '').match(/\/projects\/[^/]+\/([^/]+)\//)?.[1];
}

/**
 * Sentry doesn't put `environment` as a plain top-level field on event/error payloads —
 * it's carried in the event's `tags`, either as `[["environment","production"], ...]`
 * or `[{key:"environment",value:"production"}, ...]` depending on payload version.
 */
function tagValue(tags: unknown, key: string): string | undefined {
  if (!Array.isArray(tags)) return undefined;
  for (const t of tags) {
    if (Array.isArray(t) && t[0] === key && t[1] != null) return String(t[1]);
    if (t && typeof t === 'object' && (t as any).key === key && (t as any).value != null) {
      return String((t as any).value);
    }
  }
  return undefined;
}

function stripHtml(text?: string): string | undefined {
  if (!text) return undefined;
  const stripped = text.replace(/<[^>]*>/g, '').trim();
  return stripped || undefined;
}

function levelColor(level: string): 'red' | 'orange' | 'blue' {
  return level === 'fatal' || level === 'error' ? 'red' : level === 'warning' ? 'orange' : 'blue';
}

/**
 * Feishu cards have no per-viewer timezone concept, so timestamps are displayed in this
 * deployment's fixed local offset (Asia/Riyadh, UTC+3) rather than the raw UTC instant —
 * see docs/sentry-card/event-alert-card-content.md row 6. Rendered as one line
 * ("YYYY-MM-DD HH:mm:ss (UTC+03:00)"); an earlier two-line variant (offset on its own line)
 * wasted vertical space in the real Feishu client and was dropped after visual review.
 */
const DISPLAY_UTC_OFFSET_HOURS = 3;
function formatDisplayDateTime(iso?: string): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  const shifted = new Date(date.getTime() + DISPLAY_UTC_OFFSET_HOURS * 3600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = shifted.getUTCFullYear();
  const m = pad(shifted.getUTCMonth() + 1);
  const d = pad(shifted.getUTCDate());
  const hh = pad(shifted.getUTCHours());
  const mm = pad(shifted.getUTCMinutes());
  const ss = pad(shifted.getUTCSeconds());
  return `${y}-${m}-${d} ${hh}:${mm}:${ss} (UTC+${pad(DISPLAY_UTC_OFFSET_HOURS)}:00)`;
}

/** `{module} · {function}（{crash_location}）`, dropping whichever part is missing. */
function formatCrashModule(moduleCrash: any): string | undefined {
  if (!moduleCrash) return undefined;
  const head = [moduleCrash.module, moduleCrash.function].filter(Boolean).join(' · ');
  const location = moduleCrash.crash_location ? `（${moduleCrash.crash_location}）` : '';
  const combined = `${head}${location}`;
  return combined || undefined;
}

/** `{model} · {os}`, e.g. "Pixel 4 · Android 13". */
function formatDevice(device: any, os: any): string | undefined {
  const parts = [device?.model, os?.os].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}

/** `{app_version} ({app_build})`, e.g. "2.9.2 (260901001)"; requires app_version, app_build is optional. */
function formatAppVersion(app: any): string | undefined {
  if (!app?.app_version) return undefined;
  return app.app_build ? `${app.app_version} (${app.app_build})` : String(app.app_version);
}

/**
 * Shared body-content blocks for the unified "错误告警" card (event_alert + error resources —
 * see docs/sentry-card/event-alert-card-content.md, which doesn't distinguish a new issue from
 * a recurring one). `ev` is either `data.event` or `data.error`, whose shapes are near-identical.
 *
 * Flutter-only rows (crash module / device / app version) are added as a set, gated on whether
 * any of contexts.module_crash/device/app is present — not on the `platform` field.
 */
function buildErrorAlertBlocks(ev: any, triggeredRule?: string): ContentBlock[] {
  const level = String(ev.level ?? 'error').toLowerCase();
  const culprit = ev.culprit ?? ev.message;
  const contexts = ev.contexts ?? {};
  const isFlutterish = Boolean(contexts.module_crash || contexts.device || contexts.app);
  const crashModule = isFlutterish ? formatCrashModule(contexts.module_crash) : undefined;
  const device = isFlutterish ? formatDevice(contexts.device, contexts.os) : undefined;
  const appVersion = isFlutterish ? formatAppVersion(contexts.app) : undefined;

  return [
    // level/time and triggeredRule/locationHint are two separate row-blocks (not one flowing group of
    // 4 fields) — each is its own `fields` div, which is what gives them a visible gap between the two
    // rows, matching the "问题已解决" card's per-pair blocks (docs/sentry-card/event-alert-card-content.md
    // pairs level with time and triggeredRule with locationHint; packing all 4 into one block instead
    // rendered the two rows flush against each other).
    ...shortFields(
      { labelKey: 'level', value: level },
      formatDisplayDateTime(ev.datetime) ? { labelKey: 'eventTime', value: formatDisplayDateTime(ev.datetime)! } : undefined,
    ),
    ...shortFields(
      triggeredRule ? { labelKey: 'triggeredRule', value: String(triggeredRule) } : undefined,
      culprit ? { labelKey: 'locationHint', value: culprit } : undefined,
    ),
    ...fullField(ev.release ? { labelKey: 'release', value: String(ev.release) } : undefined),
    ...fullField(crashModule ? { labelKey: 'crashModule', value: crashModule } : undefined),
    ...shortFields(
      device ? { labelKey: 'device', value: device } : undefined,
      appVersion ? { labelKey: 'appVersion', value: appVersion } : undefined,
    ),
  ];
}

/**
 * Body-content blocks for the "问题已解决" card (activity_alert, data.activity.type=status_resolved) —
 * see docs/sentry-card/activity-alert-card-content.md. Richer than the classic 'issue' resource's resolved
 * card because this resource's `data.issue` carries shortId/count/userCount/firstSeen/lastSeen and there's
 * a sibling `data.activity`/`data.alert` object; none of that is verified to exist on the plain 'issue'
 * resource, so this layout is only used here, not shared with the generic issue-lifecycle path.
 */
function buildActivityResolvedBlocks(issue: any, activity: any, alert: any): ContentBlock[] {
  const level = String(issue.level ?? 'error').toLowerCase();
  // data.issue.shortId (e.g. "STD-SMART-OFFICE-DASHBOARD-7") is the human-facing issue number; data.issue.id is the fallback
  const issueId = issue.shortId ?? (issue.id != null ? `#${issue.id}` : undefined);
  // the user who resolved it; firstSeen/lastSeen/assignedTo/actor.name ("Sentry") are NOT this
  const changedBy = activity?.details?.user?.name ?? activity?.details?.user?.username;
  // count/userCount are cumulative totals for the issue's whole lifetime, not a recent window — 0 is a legitimate value
  const totalEvents = issue.count != null ? String(issue.count) : undefined;
  const totalUsers = issue.userCount != null ? String(issue.userCount) : undefined;
  const firstSeen = formatDisplayDateTime(issue.firstSeen);
  const lastSeen = formatDisplayDateTime(issue.lastSeen);
  const hasStats = totalEvents != null || totalUsers != null || firstSeen != null || lastSeen != null;

  return [
    ...fullField(issueId ? { labelKey: 'issueId', value: String(issueId) } : undefined),
    ...shortFields(
      changedBy ? { labelKey: 'changedBy', value: String(changedBy) } : undefined,
      { labelKey: 'originalLevel', value: level },
    ),
    ...shortFields(
      issue.culprit ? { labelKey: 'locationHint', value: issue.culprit } : undefined,
      // data.alert is the Workflow that produced this notification, not a threshold/trigger-rule condition
      alert?.title ? { labelKey: 'alertName', value: String(alert.title) } : undefined,
    ),
    ...shortFields(
      totalEvents != null ? { labelKey: 'totalEvents', value: totalEvents } : undefined,
      totalUsers != null ? { labelKey: 'totalUsers', value: totalUsers } : undefined,
    ),
    ...shortFields(
      firstSeen ? { labelKey: 'firstSeen', value: firstSeen } : undefined,
      lastSeen ? { labelKey: 'lastSeen', value: lastSeen } : undefined,
    ),
    ...noteBlock('cumulativeStats', hasStats),
  ];
}

/** Unknown resource, or a known resource with an action we don't have a dedicated layout for: keep the raw values, invent nothing. */
function buildFallback(resource: string, body: any): AlertMessage {
  console.log(`[sentry] unrecognized resource/action=${resource}/${body?.action}, raw payload: ${JSON.stringify(body)}`);
  const fields: AlertField[] = [{ labelKey: 'resourceType', value: resource }];
  if (body?.action) fields.push({ labelKey: 'action', value: String(body.action) });
  return {
    titleKey: 'notification',
    color: 'grey',
    blocks: shortFields(...fields),
    url: body?.data?.web_url,
  };
}

const ISSUE_TITLE_KEYS: Record<string, TitleKey> = {
  created: 'issueCreated',
  resolved: 'issueResolved',
  unresolved: 'issueUnresolved',
  assigned: 'issueAssigned',
  archived: 'issueArchived',
};
const ISSUE_FIXED_COLOR: Record<string, AlertMessage['color']> = {
  resolved: 'green',
  assigned: 'blue',
  archived: 'grey',
};

/**
 * `activity_alert` comes from Sentry's newer Workflow/Notification-Action system (distinct from the
 * classic `issue` resource's Issue-lifecycle checkboxes) and carries the same rich `data.issue` object,
 * but `action` is always 'triggered' — the real transition lives in `data.activity.type`. Sentry's own
 * public docs for this resource only document Seer-related activity types, not issue status ones, so
 * only values actually observed in a real payload are mapped here; guessing the rest risks a silently
 * wrong label (e.g. showing "resolved" for what's actually a regression).
 */
const ACTIVITY_TYPE_TO_ISSUE_ACTION: Record<string, string> = {
  status_resolved: 'resolved',
};

const METRIC_TITLE_KEYS: Record<string, TitleKey> = {
  critical: 'metricCritical',
  warning: 'metricWarning',
  resolved: 'metricResolved',
};
const METRIC_COLOR: Record<string, AlertMessage['color']> = {
  critical: 'red',
  warning: 'orange',
  resolved: 'green',
};

/** Parse a Sentry webhook payload into a generic alert structure (unknown resources/actions fall back to a generic card) */
export function parseSentryAlert(resource: string, body: any): AlertMessage {
  if (resource === 'event_alert') {
    const ev = body?.data?.event ?? {};
    const level = String(ev.level ?? 'error').toLowerCase();
    const environment = ev.environment ?? tagValue(ev.tags, 'environment');
    return {
      titleKey: 'errorAlert',
      environment,
      color: levelColor(level),
      summary: ev.title ?? ev.message,
      blocks: buildErrorAlertBlocks(ev, body?.data?.triggered_rule),
      // web_url is the user-facing page; data.event.url is the API URL and must never be used as a link
      url: ev.web_url,
      // event_alert payload only has a numeric project ID, no name; fall back to the API URL for a slug
      projectId: ev.project != null ? String(ev.project) : undefined,
      projectSlug: projectSlugFromUrl(ev.url),
    };
  }
  if (resource === 'metric_alert') {
    const ma = body?.data?.metric_alert ?? {};
    const action = String(body?.action ?? '').toLowerCase();
    const titleKey = METRIC_TITLE_KEYS[action];
    if (!titleKey) return buildFallback(resource, body);
    // description_text is already plain text; the legacy `description` fallback may carry HTML and needs stripping
    const description = body?.data?.description_text ?? stripHtml(body?.data?.description);
    return {
      titleKey,
      // Metric Alert Rules scope to a single environment (unlike per-event alerts), set on the rule itself
      environment: ma.alert_rule?.environment,
      color: METRIC_COLOR[action],
      summary: ma.title,
      blocks: [
        ...shortFields({ labelKey: 'status', value: action }),
        ...fullField(description ? { labelKey: 'alertDescription', value: description } : undefined),
      ],
      url: body?.data?.web_url,
      // metric_alert payload has no numeric project ID (only a slug array), so it can't be routed by ID
      projectSlug: ma.alert_rule?.projects?.[0],
    };
  }
  if (resource === 'issue') {
    const issue = body?.data?.issue ?? {};
    const action = String(body?.action ?? '').toLowerCase();
    const titleKey = ISSUE_TITLE_KEYS[action];
    if (!titleKey) return buildFallback(resource, body);
    const level = String(issue.level ?? 'error').toLowerCase();
    const environment = issue.environment ?? tagValue(issue.tags, 'environment');
    return {
      titleKey,
      environment,
      // resolved/assigned/archived carry a fixed color regardless of severity; created/unresolved follow the issue's level
      color: ISSUE_FIXED_COLOR[action] ?? levelColor(level),
      summary: issue.title,
      blocks: [
        ...shortFields(
          { labelKey: 'action', value: action },
          // a resolved issue's level describes what it *was*, not its current state — label it accordingly
          { labelKey: action === 'resolved' ? 'originalLevel' : 'level', value: level },
        ),
        ...fullField(issue.culprit ? { labelKey: 'locationHint', value: issue.culprit } : undefined),
      ],
      url: issue.web_url,
      projectId: issue.project?.id != null ? String(issue.project.id) : undefined,
      projectSlug: issue.project?.slug,
      projectName: issue.project?.name,
    };
  }
  if (resource === 'activity_alert') {
    const issue = body?.data?.issue ?? {};
    const activityType = String(body?.data?.activity?.type ?? '');
    const action = ACTIVITY_TYPE_TO_ISSUE_ACTION[activityType];
    // data.issue.project is reliably present on this resource regardless of whether we recognize the
    // activity type, so routing/enrichment works even for activity types we haven't mapped yet.
    const projectId = issue.project?.id != null ? String(issue.project.id) : undefined;
    const projectSlug = issue.project?.slug;
    const projectName = issue.project?.name;
    const titleKey = action ? ISSUE_TITLE_KEYS[action] : undefined;
    if (!titleKey) {
      console.log(`[sentry] unrecognized activity_alert activity.type=${activityType || '(empty)'}, raw payload: ${JSON.stringify(body)}`);
      return {
        titleKey: 'notification',
        color: 'grey',
        blocks: shortFields({ labelKey: 'resourceType', value: `activity_alert:${activityType || 'unknown'}` }),
        url: issue.web_url,
        projectId,
        projectSlug,
        projectName,
      };
    }
    const level = String(issue.level ?? 'error').toLowerCase();
    const environment = issue.environment ?? tagValue(issue.tags, 'environment');
    return {
      titleKey,
      environment,
      color: ISSUE_FIXED_COLOR[action] ?? levelColor(level),
      summary: issue.title,
      // ACTIVITY_TYPE_TO_ISSUE_ACTION currently only maps to 'resolved'; the rich stats layout below is
      // specific to that card (see docs/sentry-card/activity-alert-card-content.md) and would need
      // reconsidering, not blind reuse, if another activity type is ever mapped here.
      blocks: buildActivityResolvedBlocks(issue, body?.data?.activity, body?.data?.alert),
      url: issue.web_url,
      projectId,
      projectSlug,
      projectName,
    };
  }
  if (resource === 'error') {
    const err = body?.data?.error ?? {};
    const level = String(err.level ?? 'error').toLowerCase();
    const environment = err.environment ?? tagValue(err.tags, 'environment');
    return {
      titleKey: 'errorAlert',
      environment,
      color: levelColor(level),
      summary: err.title,
      blocks: buildErrorAlertBlocks(err),
      url: err.web_url,
      projectId: err.project != null ? String(err.project) : undefined,
      // error payload only has a numeric project ID, no name; fall back to the detail URL's /projects/<org>/<slug>/ for display
      projectSlug: projectSlugFromUrl(err.url),
    };
  }
  // Resource types without dedicated parsing: log the raw payload so parsing can be extended later
  return buildFallback(resource, body);
}
