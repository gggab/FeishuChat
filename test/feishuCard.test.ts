import { describe, expect, it } from 'vitest';
import { buildFeishuCard } from '../src/feishuCard.js';

describe('buildFeishuCard', () => {
  it('renders environment · type-text in the header, and project/summary/blocks/button in the body', () => {
    const card = buildFeishuCard({
      titleKey: 'errorAlert',
      environment: 'development',
      color: 'red',
      projectSlug: 'std-smart-office-dashboard',
      summary: "TypeError: Cannot read properties of undefined (reading 'x')",
      blocks: [
        { kind: 'short', fields: [{ labelKey: 'level', value: 'error' }] },
        { kind: 'full', field: { labelKey: 'locationHint', value: 'Screen' } },
      ],
      url: 'https://sentry.example.com/issues/1/',
    });
    expect((card.header as any).template).toBe('red');
    // environment is shown raw (untranslated) in both locales; only the type text is translated
    expect((card.header as any).title.i18n.en_us).toBe('development · Error alert');
    expect((card.header as any).title.i18n.zh_cn).toBe('development · 错误告警');
    expect((card.header as any).title).not.toHaveProperty('content');

    const zh = (card.i18n_elements as any).zh_cn;
    const en = (card.i18n_elements as any).en_us;
    // body order: project (no label) -> summary (no label) -> short block -> full block -> hr -> button
    expect(zh[0]).toEqual({ tag: 'div', text: { tag: 'plain_text', content: 'std-smart-office-dashboard' } });
    expect(zh[1]).toEqual({ tag: 'div', text: { tag: 'plain_text', content: "TypeError: Cannot read properties of undefined (reading 'x')" } });
    expect(zh[2]).toEqual({
      tag: 'div',
      fields: [{ is_short: true, text: { tag: 'plain_text', content: '级别\nerror' } }],
    });
    expect(zh[3]).toEqual({ tag: 'div', text: { tag: 'plain_text', content: '定位线索\nScreen' } });
    expect(zh[4]).toEqual({ tag: 'hr' });
    expect(zh[5]).toEqual({
      tag: 'action',
      actions: [{ tag: 'button', text: { tag: 'plain_text', content: '查看详情' }, type: 'default', url: 'https://sentry.example.com/issues/1/' }],
    });
    expect(en[2].fields[0].text.content).toBe('Level\nerror');
    expect(en[3].text.content).toBe('Location hint\nScreen');
    expect(en[5].actions[0].text.content).toBe('View details');
    // no leftover single-language shape
    expect(card).not.toHaveProperty('elements');
  });

  it('truncates a very long summary in the body instead of stuffing it into the (single-line) header', () => {
    const longSummary = 'E'.repeat(500);
    const card = buildFeishuCard({
      titleKey: 'errorAlert',
      color: 'red',
      summary: longSummary,
      blocks: [{ kind: 'short', fields: [{ labelKey: 'level', value: 'error' }] }],
    });
    expect((card.header as any).title.i18n.en_us).toBe('Error alert');
    const json = JSON.stringify(card);
    expect(json).not.toContain(longSummary);
    expect(json).toContain(`${'E'.repeat(200)}…`);
  });

  it('missing summary falls back to a translated "(untitled)" placeholder, not an empty line', () => {
    const card = buildFeishuCard({ titleKey: 'errorAlert', color: 'red', blocks: [] });
    expect((card.i18n_elements as any).zh_cn[0]).toEqual({ tag: 'div', text: { tag: 'plain_text', content: '(无标题)' } });
    expect((card.i18n_elements as any).en_us[0]).toEqual({ tag: 'div', text: { tag: 'plain_text', content: '(untitled)' } });
  });

  it('project display prefers name, then slug, then "#id"; omitted entirely when all are unknown', () => {
    const withName = buildFeishuCard({ titleKey: 'errorAlert', color: 'red', blocks: [], projectId: '4', projectSlug: 'p', projectName: 'P' });
    expect((withName.i18n_elements as any).zh_cn[0].text.content).toBe('P');

    const withSlug = buildFeishuCard({ titleKey: 'errorAlert', color: 'red', blocks: [], projectId: '4', projectSlug: 'p' });
    expect((withSlug.i18n_elements as any).zh_cn[0].text.content).toBe('p');

    const withIdOnly = buildFeishuCard({ titleKey: 'errorAlert', color: 'red', blocks: [], projectId: '4' });
    expect((withIdOnly.i18n_elements as any).zh_cn[0].text.content).toBe('#4');

    const withoutProject = buildFeishuCard({ titleKey: 'errorAlert', color: 'red', blocks: [] });
    // first element is then the summary placeholder, not a project line
    expect((withoutProject.i18n_elements as any).zh_cn[0].text.content).toBe('(无标题)');
  });

  it('no environment: header title is just the type text, no leading separator', () => {
    const card = buildFeishuCard({ titleKey: 'issueCreated', color: 'red', blocks: [] });
    expect((card.header as any).title.i18n.en_us).toBe('New issue');
    expect((card.header as any).title.i18n.zh_cn).toBe('新问题');
  });

  it('action/status field values are translated when recognized; unrecognized ones pass through raw', () => {
    const known = buildFeishuCard({
      titleKey: 'issueCreated',
      color: 'red',
      blocks: [{ kind: 'short', fields: [{ labelKey: 'action', value: 'created' }] }],
    });
    expect((known.i18n_elements as any).zh_cn.at(-1).fields[0].text.content).toBe('动作\n已创建');
    expect((known.i18n_elements as any).en_us.at(-1).fields[0].text.content).toBe('Action\nCreated');

    const unknown = buildFeishuCard({
      titleKey: 'notification',
      color: 'grey',
      blocks: [{ kind: 'short', fields: [{ labelKey: 'action', value: 'some_weird_action' }] }],
    });
    expect((unknown.i18n_elements as any).zh_cn.at(-1).fields[0].text.content).toBe('动作\nsome_weird_action');
  });

  it('a "full" block before a "short" block renders as its own line ahead of the fields grid', () => {
    const card = buildFeishuCard({
      titleKey: 'errorAlert',
      color: 'red',
      summary: 'x',
      blocks: [
        { kind: 'full', field: { labelKey: 'triggeredRule', value: 'Production error alert' } },
        { kind: 'short', fields: [{ labelKey: 'level', value: 'error' }] },
      ],
    });
    const zh = (card.i18n_elements as any).zh_cn;
    // project omitted (no project data) -> summary -> triggeredRule (full) -> fields grid
    expect(zh[1]).toEqual({ tag: 'div', text: { tag: 'plain_text', content: '触发规则\nProduction error alert' } });
    expect(zh[2].fields).toBeDefined();
  });

  it('a "note" block renders as a plain unlabeled caption line', () => {
    const card = buildFeishuCard({
      titleKey: 'issueResolved',
      color: 'green',
      summary: 'x',
      blocks: [{ kind: 'note', noteKey: 'cumulativeStats' }],
    });
    expect((card.i18n_elements as any).zh_cn[1]).toEqual({ tag: 'div', text: { tag: 'plain_text', content: '统计为该 Issue 的累计值。' } });
    expect((card.i18n_elements as any).en_us[1]).toEqual({ tag: 'div', text: { tag: 'plain_text', content: 'Cumulative totals for this issue.' } });
  });

  it('no blocks -> no extra rows; no url -> no hr, no button (fallback/notification shape)', () => {
    const card = buildFeishuCard({
      titleKey: 'notification',
      color: 'grey',
      blocks: [
        {
          kind: 'short',
          fields: [
            { labelKey: 'resourceType', value: 'comment' },
            { labelKey: 'action', value: 'created' },
          ],
        },
      ],
    });
    const zh = (card.i18n_elements as any).zh_cn;
    expect(zh).toHaveLength(1);
    expect(zh[0]).toEqual({
      tag: 'div',
      fields: [
        { is_short: true, text: { tag: 'plain_text', content: '资源类型\ncomment' } },
        { is_short: true, text: { tag: 'plain_text', content: '动作\n已创建' } },
      ],
    });
    expect(zh.some((e: any) => e.tag === 'hr')).toBe(false);
    expect(zh.some((e: any) => e.tag === 'action')).toBe(false);
  });

  it('button label follows the alert category (issue/metric share one label across their action variants)', () => {
    const issueResolved = buildFeishuCard({ titleKey: 'issueResolved', color: 'green', blocks: [], url: 'https://x/1' });
    const issueArchived = buildFeishuCard({ titleKey: 'issueArchived', color: 'grey', blocks: [], url: 'https://x/1' });
    expect((issueResolved.i18n_elements as any).zh_cn.at(-1).actions[0].text.content).toBe('查看问题');
    expect((issueArchived.i18n_elements as any).zh_cn.at(-1).actions[0].text.content).toBe('查看问题');

    const metricWarning = buildFeishuCard({ titleKey: 'metricWarning', color: 'orange', blocks: [], url: 'https://x/1' });
    expect((metricWarning.i18n_elements as any).zh_cn.at(-1).actions[0].text.content).toBe('查看指标告警');

    const notification = buildFeishuCard({ titleKey: 'notification', color: 'grey', blocks: [], url: 'https://x/1' });
    expect((notification.i18n_elements as any).zh_cn.at(-1).actions[0].text.content).toBe('查看详情');

    const errorAlert = buildFeishuCard({ titleKey: 'errorAlert', color: 'red', blocks: [], url: 'https://x/1' });
    expect((errorAlert.i18n_elements as any).zh_cn.at(-1).actions[0].text.content).toBe('查看详情');
  });
});
