import crypto from 'node:crypto';
import { AlertField, AlertMessage, TitleKey } from './feishuCard.js';

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
 * Field/layout decisions follow docs/sentry-card/README.md.
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

/** Unknown resource, or a known resource with an action we don't have a dedicated layout for: keep the raw values, invent nothing. */
function buildFallback(resource: string, body: any): AlertMessage {
  console.log(`[sentry] unrecognized resource/action=${resource}/${body?.action}, raw payload: ${JSON.stringify(body)}`);
  const fields: AlertField[] = [{ labelKey: 'resourceType', value: resource }];
  if (body?.action) fields.push({ labelKey: 'action', value: String(body.action) });
  return {
    titleKey: 'notification',
    color: 'grey',
    fields,
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
    const triggeredRule = body?.data?.triggered_rule;
    const culprit = ev.culprit ?? ev.message;
    return {
      titleKey: 'ruleAlert',
      environment,
      color: levelColor(level),
      summary: ev.title ?? ev.message,
      standaloneFieldsBefore: triggeredRule ? [{ labelKey: 'triggeredRule', value: String(triggeredRule) }] : [],
      fields: [{ labelKey: 'level', value: level }],
      trailingField: culprit ? { labelKey: 'locationHint', value: culprit } : undefined,
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
      fields: [{ labelKey: 'status', value: action }],
      trailingField: description ? { labelKey: 'alertDescription', value: description } : undefined,
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
      fields: [
        { labelKey: 'action', value: action },
        // a resolved issue's level describes what it *was*, not its current state — label it accordingly
        { labelKey: action === 'resolved' ? 'originalLevel' : 'level', value: level },
      ],
      trailingField: issue.culprit ? { labelKey: 'locationHint', value: issue.culprit } : undefined,
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
        fields: [{ labelKey: 'resourceType', value: `activity_alert:${activityType || 'unknown'}` }],
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
      fields: [
        { labelKey: 'action', value: action },
        { labelKey: action === 'resolved' ? 'originalLevel' : 'level', value: level },
      ],
      trailingField: issue.culprit ? { labelKey: 'locationHint', value: issue.culprit } : undefined,
      url: issue.web_url,
      projectId,
      projectSlug,
      projectName,
    };
  }
  if (resource === 'error') {
    const err = body?.data?.error ?? {};
    const level = String(err.level ?? 'error').toLowerCase();
    // error payload only has a numeric project ID, no name; fall back to the detail URL's /projects/<org>/<slug>/ for display
    const projectSlug = projectSlugFromUrl(err.url);
    const environment = err.environment ?? tagValue(err.tags, 'environment');
    return {
      titleKey: 'error',
      environment,
      color: levelColor(level),
      summary: err.title,
      fields: [{ labelKey: 'level', value: level }],
      trailingField: err.culprit ? { labelKey: 'locationHint', value: err.culprit } : undefined,
      url: err.web_url,
      projectId: err.project != null ? String(err.project) : undefined,
      projectSlug,
    };
  }
  // Resource types without dedicated parsing: log the raw payload so parsing can be extended later
  return buildFallback(resource, body);
}
