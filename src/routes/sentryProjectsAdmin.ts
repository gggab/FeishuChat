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
        'Sentry project routing',
        `<h1>Sentry project &rarr; Feishu group mapping</h1>
<div class="card">
  <p>Project ID is Sentry's numeric project ID; name / slug are auto-filled after the project's first real alert arrives, no need to fill them in when adding.
  Timezone is optional — it's the display timezone for that project's alert cards (event time / first-last seen), since Feishu cards have no per-viewer timezone
  and different groups can serve different regions (e.g. a China group on <code>Asia/Shanghai</code>, a Riyadh group on <code>Asia/Riyadh</code>). IANA name;
  left blank it falls back to <code>${DEFAULT_TIMEZONE}</code>.</p>
  <table id="tbl" style="width:100%; border-collapse: collapse;">
    <thead><tr>
      <th style="text-align:left; border-bottom:1px solid #dee0e3; padding:6px;">Project ID</th>
      <th style="text-align:left; border-bottom:1px solid #dee0e3; padding:6px;">Name / slug</th>
      <th style="text-align:left; border-bottom:1px solid #dee0e3; padding:6px;">Feishu chat_id</th>
      <th style="text-align:left; border-bottom:1px solid #dee0e3; padding:6px;">Timezone</th>
      <th style="border-bottom:1px solid #dee0e3; padding:6px;"></th>
    </tr></thead>
    <tbody id="rows"></tbody>
  </table>
</div>
<div class="card">
  <p>Add a mapping (posting again with the same Project ID overwrites chat_id/timezone for that mapping):</p>
  <p>
    <input id="pid" placeholder="Sentry project ID, e.g. 4" style="padding:6px; margin-right:8px;">
    <input id="cid" placeholder="Feishu chat_id, starts with oc_" style="padding:6px; width:280px; margin-right:8px;">
    <input id="tz" placeholder="Timezone, e.g. Asia/Shanghai (optional)" style="padding:6px; width:220px; margin-right:8px;">
    <button id="add" class="btn" style="padding:8px 20px;">Add / Update</button>
  </p>
</div>
<script>
const TOKEN = ${JSON.stringify(token)};
async function api(path, opts) {
  const resp = await fetch(path, { ...opts, headers: { ...(opts && opts.headers), 'X-Admin-Token': TOKEN, 'Content-Type': 'application/json' } });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(body.message || ('Request failed: ' + resp.status));
  return body;
}
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
async function refresh() {
  const list = await api('/admin/sentry-projects/api');
  document.getElementById('rows').innerHTML = list.map(r =>
    '<tr>' +
    '<td style="padding:6px; border-bottom:1px solid #f0f0f0;">' + esc(r.projectId) + '</td>' +
    '<td style="padding:6px; border-bottom:1px solid #f0f0f0;">' + (esc(r.name) || esc(r.slug) || '<span style="color:#999">(waiting for first alert)</span>') + '</td>' +
    '<td style="padding:6px; border-bottom:1px solid #f0f0f0;"><code>' + esc(r.chatId) + '</code></td>' +
    '<td style="padding:6px; border-bottom:1px solid #f0f0f0;">' + (esc(r.timezone) || '<span style="color:#999">(default: ${DEFAULT_TIMEZONE})</span>') + '</td>' +
    '<td style="padding:6px; border-bottom:1px solid #f0f0f0;"><button data-id="' + esc(r.projectId) + '" class="del">Delete</button></td>' +
    '</tr>'
  ).join('') || '<tr><td colspan="5" style="padding:12px; color:#999;">No mappings yet, unmapped projects go to the default group</td></tr>';
  document.querySelectorAll('.del').forEach(btn => btn.onclick = async () => {
    if (!confirm('Delete the mapping for project ' + btn.dataset.id + '?')) return;
    await api('/admin/sentry-projects/api/' + encodeURIComponent(btn.dataset.id), { method: 'DELETE' });
    refresh();
  });
}
document.getElementById('add').onclick = async () => {
  const projectId = document.getElementById('pid').value.trim();
  const chatId = document.getElementById('cid').value.trim();
  const timezone = document.getElementById('tz').value.trim();
  if (!projectId || !chatId) { alert('Project ID and chat_id are both required'); return; }
  try {
    await api('/admin/sentry-projects/api', { method: 'POST', body: JSON.stringify({ projectId, chatId, timezone }) });
  } catch (err) {
    alert(err.message);
    return;
  }
  document.getElementById('pid').value = '';
  document.getElementById('cid').value = '';
  document.getElementById('tz').value = '';
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
