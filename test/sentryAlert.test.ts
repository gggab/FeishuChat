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
  it('event_alert: extracts title, level, rule and detail link', () => {
    const msg = parseSentryAlert('event_alert', {
      action: 'triggered',
      data: {
        triggered_rule: 'Production error alert',
        event: {
          title: 'TypeError: Cannot read properties of undefined',
          culprit: 'app.handler in process',
          level: 'error',
          web_url: 'https://sentry.example.com/issues/123/',
        },
      },
    });
    expect(msg.titlePrefixKey).toBe('alert');
    expect(msg.titleText).toContain('TypeError');
    expect(msg.color).toBe('red');
    expect(msg.fields).toContainEqual({ labelKey: 'level', value: 'error' });
    expect(msg.fields).toContainEqual({ labelKey: 'triggeredRule', value: 'Production error alert' });
    expect(msg.detail).toBe('app.handler in process');
    expect(msg.url).toBe('https://sentry.example.com/issues/123/');
  });

  it('metric_alert: triggered is red, resolved is green', () => {
    const triggered = parseSentryAlert('metric_alert', {
      action: 'critical',
      data: { metric_alert: { title: 'API error rate' }, web_url: 'https://sentry.example.com/alerts/1/' },
    });
    expect(triggered.color).toBe('red');
    expect(triggered.titlePrefixKey).toBe('metricAlert');
    expect(triggered.titleText).toBe('API error rate');
    expect(triggered.url).toBe('https://sentry.example.com/alerts/1/');

    const resolved = parseSentryAlert('metric_alert', {
      action: 'resolved',
      data: { metric_alert: { title: 'API error rate' } },
    });
    expect(resolved.color).toBe('green');
    expect(resolved.titlePrefixKey).toBe('metricAlertResolved');
  });

  it('unknown resource falls back to a generic structure', () => {
    const msg = parseSentryAlert('comment', { action: 'created' });
    expect(msg.titlePrefixKey).toBe('notification');
    expect(msg.titleText).toBe('comment');
    expect(msg.color).toBe('grey');
  });

  it('error: extracts title, level, detail link, and falls back to the URL for a project slug', () => {
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
    expect(msg.titlePrefixKey).toBe('error');
    expect(msg.titleText).toContain('ReferenceError');
    expect(msg.color).toBe('red');
    expect(msg.projectId).toBe('4');
    expect(msg.projectSlug).toBe('my-project');
    expect(msg.url).toBe('https://sentry.example.com/organizations/org/issues/1/events/1/');
  });
});
