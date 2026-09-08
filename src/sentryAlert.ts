import crypto from 'node:crypto';
import { AlertMessage } from './feishuCard.js';

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

/** Parse a Sentry webhook payload into a generic alert structure (unknown resources fall back to a generic card) */
export function parseSentryAlert(resource: string, body: any): AlertMessage {
  if (resource === 'event_alert') {
    const ev = body?.data?.event ?? {};
    const level = String(ev.level ?? 'error').toLowerCase();
    return {
      titlePrefixKey: 'alert',
      titleText: ev.title ?? ev.message,
      color: level === 'fatal' || level === 'error' ? 'red' : level === 'warning' ? 'orange' : 'blue',
      fields: [
        { labelKey: 'level', value: level },
        { labelKey: 'triggeredRule', value: String(body?.data?.triggered_rule ?? '-') },
      ],
      detail: ev.culprit ?? ev.message,
      url: ev.web_url ?? ev.url,
      // event_alert payload only has a numeric project ID, no name; fall back to the API URL for a slug
      projectId: ev.project != null ? String(ev.project) : undefined,
      projectSlug: projectSlugFromUrl(ev.url),
    };
  }
  if (resource === 'metric_alert') {
    const ma = body?.data?.metric_alert ?? {};
    const resolved = body?.action === 'resolved';
    return {
      titlePrefixKey: resolved ? 'metricAlertResolved' : 'metricAlert',
      titleText: ma.title,
      color: resolved ? 'green' : 'red',
      fields: [{ labelKey: 'status', value: String(body?.action ?? '-') }],
      detail: body?.data?.description_text ?? body?.data?.description,
      url: body?.data?.web_url,
      // metric_alert payload has no numeric project ID (only a slug array), so it can't be routed by ID
      projectSlug: ma.alert_rule?.projects?.[0],
    };
  }
  if (resource === 'issue') {
    const issue = body?.data?.issue ?? {};
    const action = String(body?.action ?? '-');
    return {
      titlePrefixKey: 'issue',
      titleText: issue.title,
      color: action === 'resolved' ? 'green' : issue.level === 'warning' ? 'orange' : 'red',
      fields: [
        { labelKey: 'action', value: action },
        { labelKey: 'level', value: String(issue.level ?? '-') },
        { labelKey: 'project', value: String(issue.project?.name ?? '-') },
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
    // error payload only has a numeric project ID, no name; fall back to the detail URL's /projects/<org>/<slug>/ for display
    const projectSlug = projectSlugFromUrl(err.url);
    return {
      titlePrefixKey: 'error',
      titleText: err.title,
      color: level === 'fatal' || level === 'error' ? 'red' : level === 'warning' ? 'orange' : 'blue',
      fields: [
        { labelKey: 'level', value: level },
        { labelKey: 'project', value: projectSlug ?? String(err.project ?? '-') },
      ],
      detail: err.culprit,
      url: err.web_url,
      projectId: err.project != null ? String(err.project) : undefined,
      projectSlug,
    };
  }
  // Resource types without dedicated parsing: log the raw payload so parsing can be extended later
  console.log(`[sentry] unrecognized resource=${resource}, raw payload: ${JSON.stringify(body)}`);
  return {
    titlePrefixKey: 'notification',
    titleText: resource,
    color: 'grey',
    fields: [{ labelKey: 'action', value: String(body?.action ?? '-') }],
    url: body?.data?.web_url,
  };
}
