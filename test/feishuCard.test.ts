import { describe, expect, it } from 'vitest';
import { buildFeishuCard } from '../src/feishuCard.js';

describe('buildFeishuCard', () => {
  it('builds an interactive card with native i18n (zh_cn + en_us) for title, fields, detail and button', () => {
    const card = buildFeishuCard({
      titlePrefixKey: 'alert',
      titleText: 'x',
      color: 'red',
      fields: [{ labelKey: 'level', value: 'error' }],
      detail: 'culprit info',
      url: 'https://sentry.example.com/issues/1/',
    });
    const json = JSON.stringify(card);
    expect(json).toContain('"template":"red"');
    // header title carries both locales, not a single hardcoded language
    expect(json).toContain('Sentry Alert: x');
    expect(json).toContain('Sentry 告警: x');
    // field labels are translated per locale, the raw value is shared
    expect(json).toContain('Level');
    expect(json).toContain('级别');
    expect(json).toContain('culprit info');
    expect(json).toContain('https://sentry.example.com/issues/1/');
    expect(json).toContain('View details');
    expect(json).toContain('查看详情');
    // no single-language elements/title fields left over
    expect(card).not.toHaveProperty('elements');
    expect((card.header as any).title).not.toHaveProperty('content');
  });

  it('notification fallback title uses "(resource)" format instead of the standard prefix: text', () => {
    const card = buildFeishuCard({
      titlePrefixKey: 'notification',
      titleText: 'comment',
      color: 'grey',
      fields: [{ labelKey: 'action', value: 'created' }],
    });
    const json = JSON.stringify(card);
    expect(json).toContain('Sentry Notification (comment)');
    expect(json).toContain('Sentry 通知 (comment)');
  });
});
