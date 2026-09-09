// Design artifacts only. Does not import, send through, or modify the gateway.
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const here = new URL('./', import.meta.url);
const sourceScenes = JSON.parse(await readFile(new URL('sentry-feishu-card.scenarios.json', here), 'utf8'));
const groups = [
  { id: 'saudi', label: '沙特群 / Saudi group', zone: 'Asia/Riyadh', offset: 'UTC+03:00' },
  { id: 'china', label: '中国群 / China group', zone: 'Asia/Shanghai', offset: 'UTC+08:00' },
  { id: 'default', label: '未配置群 / Default', zone: 'UTC', offset: 'UTC' }
];
const timeSamples = {
  error: { fields: [{ zh: '发生时间', en: 'Event time', iso: '2026-09-08T08:32:08Z' }], release: 'dashboard@1.8.3' },
  event_alert: { fields: [{ zh: '发生时间', en: 'Event time', iso: '2026-09-08T20:32:08Z' }], release: 'dashboard@1.8.3' },
  issue_created: { fields: [{ zh: '最近出现', en: 'Last seen', iso: '2026-09-08T09:10:00Z' }], release: 'dashboard@1.8.3' },
  issue_resolved: { fields: [{ zh: '最近出现', en: 'Last seen', iso: '2026-09-07T18:45:00Z' }], release: 'dashboard@1.8.2' },
  metric_critical: { fields: [{ zh: '开始时间', en: 'Started', iso: '2026-09-08T07:55:00Z' }] },
  metric_warning: { fields: [{ zh: '开始时间', en: 'Started', iso: '2026-09-08T10:15:00Z' }] },
  metric_resolved: { fields: [{ zh: '开始时间', en: 'Started', iso: '2026-09-08T05:40:00Z' }] },
  issue_optional: {
    fields: [
      { zh: '首次出现', en: 'First seen', iso: '2026-09-06T13:20:00Z' },
      { zh: '最近出现', en: 'Last seen', iso: '2026-09-08T09:10:00Z' }
    ],
    release: 'dashboard@1.8.3'
  }
};

function text(tag, content) {
  return { tag, content };
}

function formatInZone(iso, group) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: group.zone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date(iso));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second} (${group.offset})`;
}

function addTimeFields(card, sample, group) {
  if (!sample) return card;
  const copy = structuredClone(card);
  const fields = sample.fields.map(item => ({
    is_short: true,
    text: text('plain_text', `${item.zh}\n${formatInZone(item.iso, group)}`)
  }));
  if (sample.release) fields.push({ is_short: true, text: text('plain_text', `版本\n${sample.release}`) });
  const localizedFields = {
    zh_cn: fields,
    en_us: sample.fields.map(item => ({
      is_short: true,
      text: text('plain_text', `${item.en}\n${formatInZone(item.iso, group)}`)
    })).concat(sample.release ? [{ is_short: true, text: text('plain_text', `Release\n${sample.release}`) }] : [])
  };
  for (const language of ['zh_cn', 'en_us']) {
    const elements = copy.i18n_elements[language];
    const separatorIndex = elements.findIndex(item => item.tag === 'hr');
    const fieldsIndex = elements.findIndex(item => item.tag === 'div' && item.fields);
    if (fieldsIndex >= 0) elements[fieldsIndex].fields.push(...localizedFields[language]);
    else elements.splice(separatorIndex >= 0 ? separatorIndex : elements.length, 0, { tag: 'div', fields: localizedFields[language] });
  }
  return copy;
}

const scenes = sourceScenes.map(scene => ({
  ...scene,
  cardsByGroup: Object.fromEntries(groups.map(group => [group.id, addTimeFields(scene.card, timeSamples[scene.key], group)]))
}));
assert.equal(new Set(scenes.map(s => s.key)).size, scenes.length);
for (const { card } of scenes) {
  assert.equal(card.schema, undefined);
  assert.equal(card.body, undefined);
  assert.deepEqual(Object.keys(card.i18n_elements).sort(), ['en_us', 'zh_cn']);
  assert.deepEqual(Object.keys(card.header.title.i18n).sort(), ['en_us', 'zh_cn']);
  assert.equal(card.i18n_elements.zh_cn.length, card.i18n_elements.en_us.length);
}
const find = key => scenes.find(s => s.key === key).card;
assert.equal(find('issue_resolved').header.template, 'green');
assert.equal(find('metric_resolved').header.template, 'green');
assert.equal(find('metric_warning').header.template, 'orange');
assert.ok(!find('fallback').i18n_elements.en_us.some(e => e.tag === 'action'));
assert.ok(!JSON.stringify(find('event_alert')).includes('Total issue events'));
assert.ok(JSON.stringify(find('issue_optional')).includes('Total issue events'));
assert.ok(!JSON.stringify(scenes).includes('近 5 分钟'));
assert.equal(scenes.find(s => s.key === 'error').cardsByGroup.saudi.i18n_elements.zh_cn[2].fields.some(field => field.text.content.includes('UTC+03:00')), true);
assert.equal(scenes.find(s => s.key === 'error').cardsByGroup.china.i18n_elements.zh_cn[2].fields.some(field => field.text.content.includes('UTC+08:00')), true);
assert.equal(scenes.find(s => s.key === 'fallback').cardsByGroup.saudi.i18n_elements.zh_cn.length, find('fallback').i18n_elements.zh_cn.length);

const fragmentUrl = new URL('sentry-feishu-card.html', here);
const fragment = await readFile(fragmentUrl, 'utf8');
const marker = /(<script type="application\/json" id="sentry-card-scenarios">)[\s\S]*?(<\/script>)/;
assert.ok(marker.test(fragment));
const embedded = JSON.stringify({ groups, scenes }).replaceAll('<', '\\u003c');
const updated = fragment.replace(marker, (_, start, end) => start + embedded + end);
await writeFile(fragmentUrl, updated);
await writeFile(new URL('sentry-feishu-card.example.json', here), JSON.stringify(scenes[0].cardsByGroup.saudi, null, 2) + '\n');
// The standalone wrapper is intentionally small; the fragment owns all preview UI.
await writeFile(new URL('preview.html', here), '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sentry card review</title><style>body{margin:16px;background:#f5f6f7} @media(prefers-color-scheme:dark){body{background:#191a1c}}</style></head><body>' + updated + '</body></html>');
console.log(`Verified and synchronized ${scenes.length} bilingual card scenarios.`);
