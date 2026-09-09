import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseSentryAlert, verifySentrySignature } from '../src/sentryAlert.js';

const SENTRY_SECRET = 'sentry-client-secret';

function sign(body: string, secret = SENTRY_SECRET): string {
  return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

describe('verifySentrySignature', () => {
  it('签名正确返回 true', () => {
    const body = Buffer.from('{"a":1}');
    expect(verifySentrySignature(body, sign('{"a":1}'), SENTRY_SECRET)).toBe(true);
  });

  it('签名错误 / 为空返回 false', () => {
    const body = Buffer.from('{"a":1}');
    expect(verifySentrySignature(body, sign('{"a":2}'), SENTRY_SECRET)).toBe(false);
    expect(verifySentrySignature(body, '', SENTRY_SECRET)).toBe(false);
  });
});

describe('parseSentryAlert', () => {
  it('event_alert: extracts summary, level, triggered rule (standalone) and web_url as the link', () => {
    const msg = parseSentryAlert('event_alert', {
      action: 'triggered',
      data: {
        triggered_rule: 'Production error alert',
        event: {
          title: 'TypeError: Cannot read properties of undefined',
          culprit: 'app.handler in process',
          level: 'error',
          url: 'https://sentry.example.com/api/0/projects/org/my-project/events/1/',
          web_url: 'https://sentry.example.com/issues/123/',
        },
      },
    });
    expect(msg.titleKey).toBe('ruleAlert');
    expect(msg.summary).toContain('TypeError');
    expect(msg.color).toBe('red');
    expect(msg.fields).toContainEqual({ labelKey: 'level', value: 'error' });
    expect(msg.standaloneFieldsBefore).toContainEqual({ labelKey: 'triggeredRule', value: 'Production error alert' });
    expect(msg.trailingField).toEqual({ labelKey: 'locationHint', value: 'app.handler in process' });
    // must use web_url (user-facing), never the API url even though both are present
    expect(msg.url).toBe('https://sentry.example.com/issues/123/');
  });

  it('event_alert: missing triggered_rule is omitted entirely, not shown as a placeholder', () => {
    const msg = parseSentryAlert('event_alert', {
      action: 'triggered',
      data: { event: { title: 'x', level: 'error' } },
    });
    expect(msg.standaloneFieldsBefore).toEqual([]);
  });

  it('event_alert: extracts environment from the event tags (array-pair form) for the header only', () => {
    const msg = parseSentryAlert('event_alert', {
      action: 'triggered',
      data: {
        event: {
          title: 'x',
          level: 'error',
          tags: [
            ['environment', 'production'],
            ['server_name', 'web-1'],
          ],
        },
      },
    });
    expect(msg.environment).toBe('production');
  });

  it('event_alert: extracts environment from tags in object-pair form', () => {
    const msg = parseSentryAlert('event_alert', {
      action: 'triggered',
      data: {
        event: { title: 'x', level: 'error', tags: [{ key: 'environment', value: 'staging' }] },
      },
    });
    expect(msg.environment).toBe('staging');
  });

  it('event_alert: no environment tag present -> header has no environment', () => {
    const msg = parseSentryAlert('event_alert', {
      action: 'triggered',
      data: { event: { title: 'x', level: 'error' } },
    });
    expect(msg.environment).toBeUndefined();
  });

  it('metric_alert: critical is red, warning is orange, resolved is green; unrecognized action falls back', () => {
    const critical = parseSentryAlert('metric_alert', {
      action: 'critical',
      data: { metric_alert: { title: 'API error rate' }, web_url: 'https://sentry.example.com/alerts/1/' },
    });
    expect(critical.color).toBe('red');
    expect(critical.titleKey).toBe('metricCritical');
    expect(critical.summary).toBe('API error rate');
    expect(critical.fields).toContainEqual({ labelKey: 'status', value: 'critical' });
    expect(critical.url).toBe('https://sentry.example.com/alerts/1/');

    const warning = parseSentryAlert('metric_alert', {
      action: 'warning',
      data: { metric_alert: { title: 'API error rate' } },
    });
    expect(warning.color).toBe('orange');
    expect(warning.titleKey).toBe('metricWarning');

    const resolved = parseSentryAlert('metric_alert', {
      action: 'resolved',
      data: { metric_alert: { title: 'API error rate' } },
    });
    expect(resolved.color).toBe('green');
    expect(resolved.titleKey).toBe('metricResolved');

    const unknownAction = parseSentryAlert('metric_alert', {
      action: 'something_else',
      data: { metric_alert: { title: 'API error rate' } },
    });
    expect(unknownAction.titleKey).toBe('notification');
    expect(unknownAction.fields).toContainEqual({ labelKey: 'resourceType', value: 'metric_alert' });
    expect(unknownAction.fields).toContainEqual({ labelKey: 'action', value: 'something_else' });
  });

  it('metric_alert: extracts environment from the alert rule scope when set', () => {
    const msg = parseSentryAlert('metric_alert', {
      action: 'critical',
      data: { metric_alert: { title: 'API error rate', alert_rule: { environment: 'production' } } },
    });
    expect(msg.environment).toBe('production');
  });

  it('metric_alert: prefers description_text, strips HTML from the description fallback', () => {
    const withText = parseSentryAlert('metric_alert', {
      action: 'critical',
      data: { metric_alert: { title: 'x' }, description_text: 'plain description' },
    });
    expect(withText.trailingField).toEqual({ labelKey: 'alertDescription', value: 'plain description' });

    const htmlFallback = parseSentryAlert('metric_alert', {
      action: 'critical',
      data: { metric_alert: { title: 'x' }, description: '<p>rich <b>description</b></p>' },
    });
    expect(htmlFallback.trailingField).toEqual({ labelKey: 'alertDescription', value: 'rich description' });
  });

  it('unknown resource falls back to a generic structure with the raw resource/action preserved', () => {
    const msg = parseSentryAlert('comment', { action: 'created' });
    expect(msg.titleKey).toBe('notification');
    expect(msg.color).toBe('grey');
    expect(msg.fields).toContainEqual({ labelKey: 'resourceType', value: 'comment' });
    expect(msg.fields).toContainEqual({ labelKey: 'action', value: 'created' });
    expect(msg.summary).toBeUndefined();
  });

  it('error: extracts summary, level, culprit, web_url, and falls back to the URL for a project slug', () => {
    const msg = parseSentryAlert('error', {
      action: 'created',
      data: {
        error: {
          title: 'ReferenceError: x is not defined',
          level: 'error',
          culprit: 'poll(views.js)',
          project: 4,
          url: 'https://sentry.example.com/api/0/projects/org/my-project/events/1/',
          web_url: 'https://sentry.example.com/organizations/org/issues/1/events/1/',
        },
      },
    });
    expect(msg.titleKey).toBe('error');
    expect(msg.summary).toContain('ReferenceError');
    expect(msg.color).toBe('red');
    expect(msg.trailingField).toEqual({ labelKey: 'locationHint', value: 'poll(views.js)' });
    expect(msg.projectId).toBe('4');
    expect(msg.projectSlug).toBe('my-project');
    expect(msg.url).toBe('https://sentry.example.com/organizations/org/issues/1/events/1/');
  });

  it('issue: created/unresolved follow the level color, resolved/assigned/archived use a fixed color', () => {
    const created = parseSentryAlert('issue', {
      action: 'created',
      data: { issue: { title: 'x', level: 'error', culprit: 'app.handler in process', project: { id: 4, slug: 'p', name: 'P' } } },
    });
    expect(created.titleKey).toBe('issueCreated');
    expect(created.color).toBe('red');
    expect(created.fields).toContainEqual({ labelKey: 'action', value: 'created' });
    expect(created.fields).toContainEqual({ labelKey: 'level', value: 'error' });
    expect(created.projectId).toBe('4');
    expect(created.projectSlug).toBe('p');
    expect(created.projectName).toBe('P');

    const resolved = parseSentryAlert('issue', {
      action: 'resolved',
      data: { issue: { title: 'x', level: 'error' } },
    });
    expect(resolved.titleKey).toBe('issueResolved');
    expect(resolved.color).toBe('green');
    // resolved relabels the level field to avoid implying it's still that severity
    expect(resolved.fields).toContainEqual({ labelKey: 'originalLevel', value: 'error' });
    expect(resolved.fields.some((f) => f.labelKey === 'level')).toBe(false);

    const assigned = parseSentryAlert('issue', { action: 'assigned', data: { issue: { title: 'x', level: 'warning' } } });
    expect(assigned.titleKey).toBe('issueAssigned');
    expect(assigned.color).toBe('blue');

    const archived = parseSentryAlert('issue', { action: 'archived', data: { issue: { title: 'x', level: 'warning' } } });
    expect(archived.titleKey).toBe('issueArchived');
    expect(archived.color).toBe('grey');

    const unresolved = parseSentryAlert('issue', { action: 'unresolved', data: { issue: { title: 'x', level: 'warning' } } });
    expect(unresolved.titleKey).toBe('issueUnresolved');
    expect(unresolved.color).toBe('orange');
  });

  it('issue: unrecognized action falls back to the generic structure', () => {
    const msg = parseSentryAlert('issue', { action: 'ignored', data: { issue: { title: 'x' } } });
    expect(msg.titleKey).toBe('notification');
    expect(msg.fields).toContainEqual({ labelKey: 'resourceType', value: 'issue' });
    expect(msg.fields).toContainEqual({ labelKey: 'action', value: 'ignored' });
  });

  it('activity_alert: status_resolved renders like a resolved issue and still extracts project for routing', () => {
    const msg = parseSentryAlert('activity_alert', {
      action: 'triggered',
      data: {
        issue: {
          title: "TypeError: Cannot read properties of undefined (reading 'x')",
          culprit: 'Screen',
          level: 'error',
          web_url: 'https://sentry.example.com/organizations/org/issues/22/',
          project: { id: '4', name: 'std-smart-office-dashboard', slug: 'std-smart-office-dashboard' },
        },
        activity: { type: 'status_resolved', details: { user: { id: 1, name: 'a@b.com' } } },
        alert: { id: 8, title: 'Smart Office Monitor' },
      },
    });
    expect(msg.titleKey).toBe('issueResolved');
    expect(msg.color).toBe('green');
    expect(msg.fields).toContainEqual({ labelKey: 'action', value: 'resolved' });
    expect(msg.fields).toContainEqual({ labelKey: 'originalLevel', value: 'error' });
    expect(msg.trailingField).toEqual({ labelKey: 'locationHint', value: 'Screen' });
    expect(msg.url).toBe('https://sentry.example.com/organizations/org/issues/22/');
    // this is the routing-critical part: project must be extracted even though this resource
    // type isn't the classic 'issue' one, otherwise per-project chat routing silently breaks
    expect(msg.projectId).toBe('4');
    expect(msg.projectSlug).toBe('std-smart-office-dashboard');
    expect(msg.projectName).toBe('std-smart-office-dashboard');
  });

  it('activity_alert: an unrecognized activity.type (e.g. a regression we have not observed yet) falls back generically, but still extracts project', () => {
    const msg = parseSentryAlert('activity_alert', {
      action: 'triggered',
      data: {
        issue: {
          title: 'x',
          project: { id: '4', name: 'std-smart-office-dashboard', slug: 'std-smart-office-dashboard' },
          web_url: 'https://sentry.example.com/organizations/org/issues/22/',
        },
        activity: { type: 'status_regressed_or_whatever_it_actually_is' },
      },
    });
    expect(msg.titleKey).toBe('notification');
    expect(msg.color).toBe('grey');
    expect(msg.fields).toContainEqual({
      labelKey: 'resourceType',
      value: 'activity_alert:status_regressed_or_whatever_it_actually_is',
    });
    // routing must still work even when we don't recognize the specific activity type
    expect(msg.projectId).toBe('4');
    expect(msg.projectSlug).toBe('std-smart-office-dashboard');
    expect(msg.projectName).toBe('std-smart-office-dashboard');
  });

  it('issue: extracts environment from the issue tags', () => {
    const msg = parseSentryAlert('issue', {
      action: 'created',
      data: {
        issue: { title: 'x', level: 'error', tags: [['environment', 'production']], project: { id: 4 } },
      },
    });
    expect(msg.environment).toBe('production');
  });
});
