/** Shared HTML page shell for the gateway's plain web pages (home, OAuth flow, admin pages). */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} - 飞书 MCP 网关</title>
<style>
  body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; max-width: 720px; margin: 48px auto; padding: 0 16px; color: #1f2329; }
  h1 { font-size: 22px; }
  .card { border: 1px solid #dee0e3; border-radius: 8px; padding: 20px; margin: 16px 0; }
  .btn { display: inline-block; background: #3370ff; color: #fff; padding: 10px 24px; border-radius: 6px; text-decoration: none; }
  code, pre { background: #f5f6f7; border-radius: 4px; }
  code { padding: 2px 6px; word-break: break-all; }
  pre { padding: 12px; overflow-x: auto; }
  .warn { color: #b71c1c; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}
