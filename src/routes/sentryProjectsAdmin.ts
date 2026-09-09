import express, { Express } from 'express';
import { AppConfig } from '../config.js';
import { page } from '../htmlPage.js';
import { DEFAULT_TIMEZONE, SentryProjectStore } from '../sentryProjectStore.js';

export interface SentryProjectsAdminDeps {
  config: AppConfig;
  sentryProjectStore: SentryProjectStore;
}

/**
 * Admin page + JSON API for the Sentry project -> Feishu group mapping
 * (used by the /webhooks/sentry handler to route alerts per project).
 * Auth: query ?token= or X-Admin-Token header, either matching ADMIN_TOKEN.
 * Disabled entirely (503/401) when ADMIN_TOKEN isn't configured.
 *
 * UI follows the Figma "Alert routing settings" design
 * (https://www.figma.com/design/3pg9cagKXQp0iUsTZEpTLP/Feishu-Card, node-id 96-2 / 98-2 / 95-2),
 * English copy only.
 */
export function registerSentryProjectsAdminRoutes(app: Express, deps: SentryProjectsAdminDeps): void {
  const { config, sentryProjectStore } = deps;

  function checkAdminToken(req: express.Request): boolean {
    if (!config.adminToken) return false;
    const token = (req.query.token as string | undefined) ?? req.get('X-Admin-Token') ?? '';
    return token === config.adminToken;
  }

  app.get('/admin/sentry-projects', (req, res) => {
    if (!config.adminToken) {
      res.status(503).send(page('Unavailable', '<h1>Unavailable</h1><p class="warn">ADMIN_TOKEN is not configured, this page is disabled.</p>'));
      return;
    }
    if (!checkAdminToken(req)) {
      res
        .status(401)
        .send(page('Token required', '<h1>Access token required</h1><p>Append <code>?token=your-ADMIN_TOKEN</code> to the URL and reload.</p>'));
      return;
    }
    const token = req.query.token as string;
    res.send(
      page(
        'Alert routing settings',
        `<style>
  body { max-width: none; margin: 0; padding: 0; background: #f5f6f7; font-family: -apple-system, "Segoe UI", "Noto Sans", "Microsoft YaHei", sans-serif; color: #1f2329; }
  .topbar { background: #fff; padding: 24px; display: flex; align-items: center; gap: 6px; border-bottom: 1px solid #eceef0; }
  .topbar-title { font-weight: 700; font-size: 15px; }
  .topbar-sep { color: #646a73; font-size: 14px; }
  .page { padding: 40px; display: flex; flex-direction: column; gap: 24px; max-width: 1200px; margin: 0 auto; box-sizing: border-box; }
  .page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; }
  .page-head h1 { font-size: 28px; margin: 0 0 8px; }
  .muted { color: #646a73; font-size: 14px; margin: 0; }
  .btn-primary { background: #3370ff; color: #fff; border: none; border-radius: 6px; padding: 10px 16px; font-size: 14px; font-weight: 500; cursor: pointer; white-space: nowrap; }
  .btn-outline { background: #fff; border: 1px solid #dee0e3; border-radius: 6px; padding: 10px 16px; font-size: 14px; font-weight: 500; cursor: pointer; color: #1f2329; }
  .btn-outline.danger { color: #b42328; }
  .panel { background: #fff; border: 1px solid #dee0e3; border-radius: 10px; overflow: hidden; }
  .panel-intro { padding: 24px; display: flex; flex-direction: column; gap: 6px; border-bottom: 1px solid #eceef0; }
  .panel-title { font-size: 16px; font-weight: 700; margin: 0; }
  .table-wrap { overflow-x: auto; }
  .table-head { display: flex; gap: 24px; padding: 12px 24px; background: #f8f9fa; font-size: 13px; font-weight: 500; color: #646a73; min-width: 760px; box-sizing: border-box; }
  .row { display: flex; gap: 24px; align-items: center; padding: 20px 24px; border-top: 1px solid #eceef0; min-width: 760px; box-sizing: border-box; }
  .col-project { flex: 1 1 200px; min-width: 160px; }
  .col-chat { flex: 1 1 220px; min-width: 160px; overflow-wrap: anywhere; font-size: 12px; }
  .col-tz { flex: 1 1 180px; min-width: 150px; }
  .col-actions { display: flex; gap: 12px; flex: 0 0 164px; }
  .project-name { font-size: 14px; font-weight: 500; }
  .project-id { font-size: 12px; color: #646a73; }
  .tz-city { font-size: 14px; font-weight: 500; }
  .tz-name { font-size: 12px; color: #646a73; }
  .empty-row { padding: 24px; color: #8f959e; font-size: 13px; }
  .hint-box { background: #edf3ff; border-radius: 8px; padding: 20px; display: flex; flex-direction: column; gap: 6px; box-sizing: border-box; }
  .hint-title { color: #245bdb; font-size: 14px; font-weight: 500; margin: 0; }
  .hint-text { color: #344054; font-size: 13px; margin: 0; }
  .overlay { position: fixed; inset: 0; background: rgba(31, 35, 41, 0.45); display: flex; align-items: center; justify-content: center; z-index: 10; padding: 24px; box-sizing: border-box; }
  .modal { background: #fff; border: 1px solid #dee0e3; border-radius: 12px; width: 560px; max-width: 100%; max-height: 90vh; overflow-y: auto; }
  .modal-head { display: flex; justify-content: space-between; align-items: flex-start; padding: 24px; border-bottom: 1px solid #eceef0; gap: 12px; }
  .modal-title { font-size: 20px; font-weight: 700; margin: 0 0 4px; }
  .modal-body { padding: 24px; display: flex; flex-direction: column; gap: 16px; }
  .modal-foot { padding: 24px; display: flex; justify-content: flex-end; gap: 12px; border-top: 1px solid #eceef0; }
  .icon-btn { background: none; border: none; font-size: 24px; color: #646a73; cursor: pointer; line-height: 1; padding: 0; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field label { font-size: 13px; font-weight: 500; color: #646a73; }
  .field input, .static-input { border: 1px solid #bbbfc4; border-radius: 6px; padding: 12px; font-size: 14px; color: #1f2329; box-sizing: border-box; width: 100%; font-family: inherit; }
  .static-input { background: #f5f6f7; border-color: #d6d9de; color: #646a73; }
  .hint { font-size: 12px; color: #8f959e; margin: 0; }
  .tz-select { border: 1px solid #bbbfc4; border-radius: 6px; padding: 12px; font-size: 14px; display: flex; justify-content: space-between; align-items: center; cursor: pointer; gap: 8px; }
  .tz-select.open { border-color: #3370ff; }
  .chevron { color: #646a73; }
  .tz-panel { border: 1px solid #dee0e3; border-radius: 6px; overflow: hidden; margin-top: 4px; }
  .tz-search { width: 100%; border: none; border-bottom: 1px solid #eceef0; padding: 12px; font-size: 14px; box-sizing: border-box; font-family: inherit; }
  .tz-search:focus { outline: none; }
  .tz-options { max-height: 220px; overflow-y: auto; }
  .tz-option { display: flex; gap: 12px; align-items: center; padding: 10px 12px; cursor: pointer; }
  .tz-option:hover { background: #f5f6f7; }
  .tz-option.selected { background: #edf3ff; }
  .tz-option-name { font-size: 14px; font-weight: 500; }
  .tz-option-sub { font-size: 12px; color: #646a73; }
  .tz-option-check { color: #3370ff; font-weight: 700; margin-left: auto; }
  .preview-box { background: #edf3ff; border-radius: 8px; padding: 16px; display: flex; flex-direction: column; gap: 6px; }
  .preview-title { color: #245bdb; font-size: 13px; font-weight: 500; margin: 0; }
  .preview-text { color: #344054; font-size: 13px; margin: 0; }
  [hidden] { display: none !important; }
</style>

<div class="topbar">
  <span class="topbar-title">Feishu notifications</span>
  <span class="topbar-sep">/&nbsp;&nbsp;Sentry</span>
</div>

<div class="page">
  <div class="page-head">
    <div>
      <h1>Alert routing settings</h1>
      <p class="muted">Send Sentry projects to Feishu groups and set the timezone used for alert timestamps.</p>
    </div>
    <button id="openAdd" class="btn-primary">+&nbsp; Add configuration</button>
  </div>

  <div class="panel">
    <div class="panel-intro">
      <p class="panel-title" id="panelTitle">Project mappings</p>
      <p class="muted">Project name is filled after the first real alert; when adding, enter only the project ID, Feishu chat ID, and timezone.</p>
    </div>
    <div class="table-wrap">
      <div class="table-head">
        <span class="col-project">Sentry project</span>
        <span class="col-chat">Feishu chat ID</span>
        <span class="col-tz">Timezone</span>
        <span class="col-actions">Actions</span>
      </div>
      <div id="rows"></div>
    </div>
  </div>

  <div class="hint-box">
    <p class="hint-title">Timezone is set per mapping</p>
    <p class="hint-text">Alert timestamps sent through this mapping use its selected timezone. The same message does not change with the viewer's device timezone. Unmapped projects continue to use the default group.</p>
  </div>
</div>

<div id="overlay" class="overlay" hidden>
  <div class="modal">
    <div class="modal-head">
      <div>
        <p class="modal-title" id="modalTitle">Add alert route</p>
        <p class="muted" id="modalDesc">Set the Feishu group and timestamp timezone for one Sentry project.</p>
      </div>
      <button id="closeModal" class="icon-btn" aria-label="Close">&times;</button>
    </div>
    <div class="modal-body">
      <div class="field">
        <label>Sentry project ID</label>
        <input id="fPid" placeholder="e.g. 4">
        <div id="fPidStatic" class="static-input" hidden></div>
        <p class="hint" id="fPidHint">Numeric project ID; the project name is filled after the first real alert.</p>
      </div>
      <div class="field">
        <label>Feishu chat ID</label>
        <input id="fCid" placeholder="oc_...">
        <p class="hint">Chat ID must start with oc_.</p>
      </div>
      <div class="field">
        <label>Alert timestamp timezone</label>
        <div class="tz-select" id="tzSelect">
          <span id="tzSelectLabel"></span>
          <span class="chevron" id="tzChevron">&#8964;</span>
        </div>
        <div class="tz-panel" id="tzPanel" hidden>
          <input id="tzSearch" class="tz-search" placeholder="Search city or IANA timezone name">
          <div id="tzOptions" class="tz-options"></div>
        </div>
        <p class="hint">Alerts sent through this mapping use this timezone for timestamps.</p>
      </div>
      <div class="preview-box">
        <p class="preview-title">Timestamp preview</p>
        <p class="preview-text" id="previewText"></p>
        <p class="hint">This applies to alert cards sent after saving.</p>
      </div>
    </div>
    <div class="modal-foot">
      <button id="cancelModal" class="btn-outline">Cancel</button>
      <button id="saveModal" class="btn-primary">Save configuration</button>
    </div>
  </div>
</div>

<script>
var TOKEN = ${JSON.stringify(token)};
var DEFAULT_TZ = ${JSON.stringify(DEFAULT_TIMEZONE)};
var TZ_OPTIONS = [
  { city: 'Riyadh', tz: 'Asia/Riyadh' },
  { city: 'Dubai', tz: 'Asia/Dubai' },
  { city: 'Shanghai', tz: 'Asia/Shanghai' },
  { city: 'Singapore', tz: 'Asia/Singapore' },
  { city: 'Tokyo', tz: 'Asia/Tokyo' },
  { city: 'Kolkata', tz: 'Asia/Kolkata' },
  { city: 'London', tz: 'Europe/London' },
  { city: 'Paris', tz: 'Europe/Paris' },
  { city: 'New York', tz: 'America/New_York' },
  { city: 'Los Angeles', tz: 'America/Los_Angeles' },
  { city: 'UTC', tz: 'UTC' }
];

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

async function api(path, opts) {
  const resp = await fetch(path, { ...opts, headers: { ...(opts && opts.headers), 'X-Admin-Token': TOKEN, 'Content-Type': 'application/json' } });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(body.message || ('Request failed: ' + resp.status));
  return body;
}

function cityLabelFor(tz) {
  var found = TZ_OPTIONS.filter(function (o) { return o.tz.toLowerCase() === String(tz).toLowerCase(); })[0];
  if (found) return found.city;
  var last = String(tz).split('/').pop() || tz;
  return last.replace(/_/g, ' ');
}

function offsetLabel(tz) {
  try {
    var parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', timeZoneName: 'longOffset' }).formatToParts(new Date());
    var off = '';
    for (var i = 0; i < parts.length; i++) { if (parts[i].type === 'timeZoneName') off = parts[i].value; }
    off = (off || 'GMT').replace('GMT', 'UTC');
    if (off === 'UTC') off = 'UTC+00:00';
    return off;
  } catch (e) {
    return '';
  }
}

function shortDateTime(tz) {
  try {
    var parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    var get = function (type) { var f = parts.filter(function (p) { return p.type === type; })[0]; return f ? f.value : ''; };
    return get('year') + '-' + get('month') + '-' + get('day') + ' ' + get('hour') + ':' + get('minute');
  } catch (e) {
    return '';
  }
}

var currentList = [];
var editingProjectId = null;
var selectedTz = DEFAULT_TZ;

function renderRows() {
  var rowsEl = document.getElementById('rows');
  document.getElementById('panelTitle').textContent = 'Project mappings  \\u00b7  ' + currentList.length + ' configuration' + (currentList.length === 1 ? '' : 's');
  if (currentList.length === 0) {
    rowsEl.innerHTML = '<div class="empty-row">No mappings yet \\u2014 unmapped projects go to the default group.</div>';
    return;
  }
  rowsEl.innerHTML = currentList.map(function (r) {
    var tz = r.timezone || DEFAULT_TZ;
    var tzLine2 = r.timezone ? esc(r.timezone) : (esc(DEFAULT_TZ) + ' (default)');
    var nameLine = r.name || r.slug || '<span style="color:#8f959e">(waiting for first alert)</span>';
    return '<div class="row" data-id="' + esc(r.projectId) + '">' +
      '<div class="col-project"><div class="project-name">' + nameLine + '</div><div class="project-id">Project ID: ' + esc(r.projectId) + '</div></div>' +
      '<div class="col-chat">' + esc(r.chatId) + '</div>' +
      '<div class="col-tz"><div class="tz-city">' + esc(cityLabelFor(tz)) + '  \\u00b7  ' + esc(offsetLabel(tz)) + '</div><div class="tz-name">' + tzLine2 + '</div></div>' +
      '<div class="col-actions"><button class="btn-outline edit" data-id="' + esc(r.projectId) + '">Edit</button><button class="btn-outline danger del" data-id="' + esc(r.projectId) + '">Delete</button></div>' +
      '</div>';
  }).join('');
  Array.prototype.forEach.call(rowsEl.querySelectorAll('.edit'), function (btn) {
    btn.onclick = function () {
      var record = currentList.filter(function (r) { return r.projectId === btn.dataset.id; })[0];
      if (record) openEdit(record);
    };
  });
  Array.prototype.forEach.call(rowsEl.querySelectorAll('.del'), function (btn) {
    btn.onclick = async function () {
      if (!confirm('Delete the mapping for project ' + btn.dataset.id + '?')) return;
      await api('/admin/sentry-projects/api/' + encodeURIComponent(btn.dataset.id), { method: 'DELETE' });
      refresh();
    };
  });
}

async function refresh() {
  currentList = await api('/admin/sentry-projects/api');
  renderRows();
}

function renderTzOptions(filterText) {
  var q = (filterText || '').trim().toLowerCase();
  var matches = TZ_OPTIONS.filter(function (o) {
    return !q || o.city.toLowerCase().indexOf(q) !== -1 || o.tz.toLowerCase().indexOf(q) !== -1;
  });
  var html = matches.map(function (o) {
    var isSelected = o.tz.toLowerCase() === selectedTz.toLowerCase();
    return '<div class="tz-option' + (isSelected ? ' selected' : '') + '" data-tz="' + esc(o.tz) + '">' +
      '<div><div class="tz-option-name">' + esc(o.city) + '</div><div class="tz-option-sub">' + esc(o.tz) + '  \\u00b7  ' + esc(offsetLabel(o.tz)) + '</div></div>' +
      (isSelected ? '<span class="tz-option-check">\\u2713</span>' : '') +
      '</div>';
  }).join('');
  var trimmed = (filterText || '').trim();
  var exact = TZ_OPTIONS.some(function (o) { return o.tz.toLowerCase() === trimmed.toLowerCase(); });
  if (trimmed && !exact) {
    html += '<div class="tz-option" data-tz="' + esc(trimmed) + '">' +
      '<div><div class="tz-option-name">Use &quot;' + esc(trimmed) + '&quot;</div><div class="tz-option-sub">Any IANA timezone name</div></div>' +
      '</div>';
  }
  var optionsEl = document.getElementById('tzOptions');
  optionsEl.innerHTML = html || '<div class="empty-row">No match</div>';
  Array.prototype.forEach.call(optionsEl.querySelectorAll('.tz-option'), function (el) {
    el.onclick = function () {
      selectedTz = el.dataset.tz;
      closeTzPanel();
      updateTzLabel();
      updatePreview();
    };
  });
}

function updateTzLabel() {
  document.getElementById('tzSelectLabel').textContent = cityLabelFor(selectedTz) + '  \\u00b7  ' + selectedTz + '  \\u00b7  ' + offsetLabel(selectedTz);
}

function updatePreview() {
  document.getElementById('previewText').textContent =
    'Sentry source time ' + shortDateTime('UTC') + ' UTC  \\u2192  ' + shortDateTime(selectedTz) + ' (' + cityLabelFor(selectedTz) + ')';
}

function openTzPanel() {
  document.getElementById('tzPanel').hidden = false;
  document.getElementById('tzSelect').classList.add('open');
  document.getElementById('tzChevron').innerHTML = '&#8963;';
  document.getElementById('tzSearch').value = '';
  renderTzOptions('');
  document.getElementById('tzSearch').focus();
}

function closeTzPanel() {
  document.getElementById('tzPanel').hidden = true;
  document.getElementById('tzSelect').classList.remove('open');
  document.getElementById('tzChevron').innerHTML = '&#8964;';
}

document.getElementById('tzSelect').onclick = function () {
  if (document.getElementById('tzPanel').hidden) openTzPanel();
  else closeTzPanel();
};
document.getElementById('tzSearch').oninput = function (e) { renderTzOptions(e.target.value); };
document.addEventListener('click', function (e) {
  var select = document.getElementById('tzSelect');
  var panel = document.getElementById('tzPanel');
  if (!select.contains(e.target) && !panel.contains(e.target)) closeTzPanel();
});

function showModal() { document.getElementById('overlay').hidden = false; }
function hideModal() { document.getElementById('overlay').hidden = true; closeTzPanel(); }

function openAdd() {
  editingProjectId = null;
  document.getElementById('modalTitle').textContent = 'Add alert route';
  document.getElementById('modalDesc').textContent = 'Set the Feishu group and timestamp timezone for one Sentry project.';
  document.getElementById('fPid').hidden = false;
  document.getElementById('fPid').value = '';
  document.getElementById('fPidStatic').hidden = true;
  document.getElementById('fPidHint').textContent = 'Numeric project ID; the project name is filled after the first real alert.';
  document.getElementById('fCid').value = '';
  selectedTz = DEFAULT_TZ;
  updateTzLabel();
  updatePreview();
  document.getElementById('saveModal').textContent = 'Save configuration';
  showModal();
}

function openEdit(record) {
  editingProjectId = record.projectId;
  document.getElementById('modalTitle').textContent = 'Edit alert route';
  document.getElementById('modalDesc').textContent = 'Update the Feishu group or alert timestamp timezone for project ' + record.projectId + '.';
  document.getElementById('fPid').hidden = true;
  document.getElementById('fPidStatic').hidden = false;
  document.getElementById('fPidStatic').textContent = record.projectId + '  \\u00b7  ' + (record.name || record.slug || 'awaiting first alert');
  document.getElementById('fPidHint').textContent = 'Project ID cannot be changed; the project name comes from Sentry.';
  document.getElementById('fCid').value = record.chatId;
  selectedTz = record.timezone || DEFAULT_TZ;
  updateTzLabel();
  updatePreview();
  document.getElementById('saveModal').textContent = 'Save changes';
  showModal();
}

document.getElementById('openAdd').onclick = openAdd;
document.getElementById('closeModal').onclick = hideModal;
document.getElementById('cancelModal').onclick = hideModal;
document.getElementById('overlay').onclick = function (e) { if (e.target.id === 'overlay') hideModal(); };

document.getElementById('saveModal').onclick = async function () {
  var projectId = editingProjectId || document.getElementById('fPid').value.trim();
  var chatId = document.getElementById('fCid').value.trim();
  if (!projectId || !chatId) { alert('Project ID and Feishu chat ID are both required'); return; }
  try {
    await api('/admin/sentry-projects/api', { method: 'POST', body: JSON.stringify({ projectId: projectId, chatId: chatId, timezone: selectedTz }) });
  } catch (err) {
    alert(err.message);
    return;
  }
  hideModal();
  refresh();
};

refresh();
</script>`,
      ),
    );
  });

  app.get('/admin/sentry-projects/api', (req, res) => {
    if (!checkAdminToken(req)) {
      res.status(401).json({ ok: false, message: 'Invalid token or ADMIN_TOKEN not configured' });
      return;
    }
    res.json(sentryProjectStore.list());
  });

  app.post('/admin/sentry-projects/api', (req, res) => {
    if (!checkAdminToken(req)) {
      res.status(401).json({ ok: false, message: 'Invalid token or ADMIN_TOKEN not configured' });
      return;
    }
    const { projectId, chatId, timezone } = req.body ?? {};
    if (!projectId || !chatId || typeof projectId !== 'string' || typeof chatId !== 'string') {
      res.status(400).json({ ok: false, message: 'projectId and chatId are both required (as strings)' });
      return;
    }
    if (timezone !== undefined && typeof timezone !== 'string') {
      res.status(400).json({ ok: false, message: 'timezone must be a string if provided' });
      return;
    }
    try {
      res.json({ ok: true, record: sentryProjectStore.upsert(projectId.trim(), chatId.trim(), timezone) });
    } catch (err) {
      res.status(400).json({ ok: false, message: (err as Error).message });
    }
  });

  app.delete('/admin/sentry-projects/api/:projectId', (req, res) => {
    if (!checkAdminToken(req)) {
      res.status(401).json({ ok: false, message: 'Invalid token or ADMIN_TOKEN not configured' });
      return;
    }
    res.json({ ok: sentryProjectStore.remove(req.params.projectId) });
  });
}
