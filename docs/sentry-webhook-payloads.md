# Sentry Webhook 数据格式（实测记录）

记录于 2026-09-09，来源是 `sentry.sensetime-ksa.top`（自建 Sentry）这套部署的**真实 webhook 流量**，不是纯粹照搬官方文档——官方文档在这次排查里被证实好几处滞后于实际行为（比如 `activity_alert` 的官方文档只列了 Seer 相关的 activity type，完全没提 `status_resolved` 这种 issue 状态变化）。

每个类型标注了数据来源可信度：
- **【实测完整】**：本次会话里从这套部署真实抓到过完整 payload
- **【实测部分】**：抓到过，但只验证了部分字段
- **【文档/推断】**：目前 parser 按官方文档 + 早期测试实现，本部署未见过真实样本，字段是否完全一致未 100% 确认

## 通用外层结构

```
Headers:
  Content-Type: application/json
  Sentry-Hook-Resource: event_alert | issue | error | metric_alert | activity_alert | installation | uninstall | ...
  Sentry-Hook-Signature: <hex HMAC-SHA256(body, Internal Integration 的 Client Secret)>

Body: { action: string, data: { ... }, actor?: {...}, installation?: {...} }
```

验签：`hex(HMAC_SHA256(原始请求体, Client Secret))`，必须用**原始字节**算，不能用 JSON.stringify 后的字符串（可能因为空格/字段顺序不一致导致签名对不上）。

**Sentry webhook 客户端读超时只有 1 秒，不可配置**（[官方 issue #107141](https://github.com/getsentry/sentry/issues/107141) 还是 open 状态）。接收端必须在 1 秒内返回响应，不能等自己内部处理完（比如转发到飞书的网络往返）再回，否则会被判定超时失败且不重试；累计 24 小时内超时 1000 次，webhook 会被自动取消订阅。

---

## 1. `event_alert`（Alert Rule 命中）【文档/推断，字段名在本部署实测中确认过】

来自你在 Sentry 手动配置的 **Alert Rule**（Issue Alert），命中规则条件时触发。`action` 恒为 `"triggered"`。

```json
{
  "action": "triggered",
  "data": {
    "triggered_rule": "Production error alert",
    "event": {
      "title": "TypeError: Cannot read properties of undefined (reading 'x')",
      "message": "...",
      "culprit": "app.handler in process",
      "level": "error",
      "project": 4,
      "environment": "production",
      "tags": [["environment", "production"], ["server_name", "web-1"]],
      "url": "https://sentry.example.com/api/0/projects/org/my-project/events/1/",
      "web_url": "https://sentry.example.com/issues/123/"
    }
  }
}
```

要点：
- `environment` 有时是 `event.environment` 直接给，有时只在 `event.tags` 里以 `["environment","production"]` 或 `{"key":"environment","value":"production"}` 形式出现，两种都要兼容。
- `event.project` 只是数字 ID，没有项目名；`event.url`（API URL）里能正则出 slug：`/projects/<org>/<slug>/`。
- **链接必须用 `event.web_url`**，`event.url` 是 API 地址，不是给人看的详情页，不能当按钮链接。

---

## 2. `issue`（问题生命周期）【文档/推断，本部署实测中从未真正收到过这个 resource】

对应 Internal Integration 设置里 **"Issue" 复选框**（Created/Resolved/Assigned/Archived/Unresolved 可以分别勾选），跟 Alert Rule 无关，是问题状态变化的原始事件流。

```json
{
  "action": "resolved",
  "data": {
    "issue": {
      "title": "...",
      "culprit": "...",
      "level": "warning",
      "web_url": "...",
      "project": { "id": 4, "slug": "my-project", "name": "My Project" }
    }
  }
}
```

`action` 取值：`created` | `resolved` | `assigned` | `archived` | `unresolved`。

**重要提醒**：这次实测里，即使 Integration 设置页面 Issue 相关复选框全部勾上了，这套部署也从没真正发过 `resource=issue` 的 webhook——所有问题状态变化实际走的是下面第 5 种 `activity_alert`。不确定是这套 Sentry 版本的行为差异还是其他原因，如果你的环境也遇到"勾了但收不到"，直接认 `activity_alert`。

---

## 3. `error`（单条 error 事件）【实测部分，早期测试中确认过】

没有关联到 Alert Rule 时，单条 error 事件产生的通知。

```json
{
  "action": "created",
  "data": {
    "error": {
      "title": "ReferenceError: x is not defined",
      "level": "error",
      "culprit": "poll(views.js)",
      "project": 4,
      "environment": "production",
      "url": "https://sentry.example.com/api/0/projects/org/my-project/events/1/",
      "web_url": "https://sentry.example.com/organizations/org/issues/1/events/1/"
    }
  }
}
```

结构和 `event_alert` 的 `event` 对象几乎一样，只是外层 key 叫 `error`。同样只用 `web_url` 做链接。

---

## 4. `metric_alert`（指标告警）【文档/推断，本部署未实测过】

```json
{
  "action": "critical",
  "data": {
    "metric_alert": {
      "title": "API error rate",
      "alert_rule": { "environment": "production", "projects": ["my-project"] }
    },
    "description_text": "Error events exceeded the configured threshold.",
    "web_url": "https://sentry.example.com/alerts/1/"
  }
}
```

`action` 取值：`critical` | `warning` | `resolved`（对应严重/警告/已恢复三种状态，颜色分别是红/橙/绿）。

要点：
- `web_url` 在 `data` **顶层**，不在 `metric_alert` 对象里面——之前代码有个 bug 写错位置，已修。
- 没有数字 project ID，只有 `alert_rule.projects` 里的 slug 数组，取第一个当项目名，没法按 ID 精确路由。
- 说明文字优先用 `description_text`（假定已经是纯文本）；如果只有 `description` 字段（无 `_text` 后缀），可能带 HTML，要先去标签。

---

## 5. `activity_alert`（Sentry 新版 Workflow 通知）【实测完整，真实生产数据】

这是这次排查中最大的意外发现——官方公开文档（[Activity Alerts](https://docs.sentry.io/integrations/integration-platform/webhooks/activity-alerts/)）只写了 Seer（AI 自动修复）相关的 activity type，完全没提 issue 状态变化。但实测这套部署的问题状态变化（resolved/regressed 等）走的就是这个 resource，来自 Sentry 较新的 **Workflow / Notification Action** 机制（跟 Internal Integration 的 "Issue" 复选框是两条独立的路径）。

以下是真实捕获的完整 payload（issue resolved 场景，敏感信息已保留原样因为是内部测试数据）：

```json
{
  "action": "triggered",
  "installation": { "uuid": "19bfdda7-80b5-4613-9134-c181a9eb7460" },
  "data": {
    "issue": {
      "url": "https://sentry.sensetime-ksa.top/api/0/organizations/sentry/issues/22/",
      "web_url": "https://sentry.sensetime-ksa.top/organizations/sentry/issues/22/",
      "project_url": "https://sentry.sensetime-ksa.top/organizations/sentry/issues/?project=4",
      "id": "22",
      "shareId": null,
      "shortId": "STD-SMART-OFFICE-DASHBOARD-7",
      "title": "TypeError: Cannot read properties of undefined (reading 'x')",
      "culprit": "Screen",
      "permalink": "https://sentry.sensetime-ksa.top/organizations/sentry/issues/22/",
      "logger": null,
      "level": "error",
      "status": "resolved",
      "statusDetails": {},
      "substatus": null,
      "isPublic": false,
      "platform": "javascript",
      "project": {
        "id": "4",
        "name": "std-smart-office-dashboard",
        "slug": "std-smart-office-dashboard",
        "platform": "javascript-vue"
      },
      "type": "error",
      "metadata": {
        "value": "Cannot read properties of undefined (reading 'x')",
        "type": "TypeError",
        "filename": "<anonymous>",
        "function": "Array.forEach",
        "in_app_frame_mix": "in-app-only",
        "sdk": { "name": "sentry.javascript.vue", "name_normalized": "sentry.javascript.vue" },
        "initial_priority": 75,
        "title": null
      },
      "numComments": 0,
      "assignedTo": null,
      "isBookmarked": false,
      "isSubscribed": false,
      "subscriptionDetails": null,
      "hasSeen": false,
      "annotations": [],
      "issueType": "error",
      "issueCategory": "error",
      "priority": "high",
      "priorityLockedAt": null,
      "seerFixabilityScore": null,
      "seerAutofixLastTriggered": null,
      "seerExplorerAutofixLastTriggered": null,
      "isUnhandled": false,
      "count": "96",
      "userCount": 1,
      "firstSeen": "2026-09-06T12:52:30.299000Z",
      "lastSeen": "2026-09-09T08:12:48.299000Z"
    },
    "activity": {
      "type": "status_resolved",
      "details": { "user": { "id": 1, "name": "liaowentao@sensetime.com", "username": "liaowentao@sensetime.com" } }
    },
    "alert": {
      "id": 8,
      "title": "Smart Office Monitor",
      "sentry_app_id": 1,
      "url": "https://sentry.sensetime-ksa.top/api/0/organizations/sentry/workflows/8/",
      "web_url": "https://sentry.sensetime-ksa.top/organizations/sentry/monitors/alerts/8/"
    }
  },
  "actor": { "type": "application", "id": "sentry", "name": "Sentry" }
}
```

要点：
- **`action` 恒为 `"triggered"`**，跟 `event_alert` 一样，没有意义——真正的状态变化在 **`data.activity.type`**。
- 目前确认过的 `data.activity.type` 取值只有 `"status_resolved"`。issue 重新出现（regressed）**没有**产生 `activity_alert`——即使 Workflow 的 WHEN 条件列表里已经勾了 "A resolved issue regresses"，实测多次这个条件都没有触发通知，原因不明（可能是这套 Sentry 版本的 bug，也可能是这个条件需要单独挂一个 THEN 动作块，跟 resolved 共享的动作组不生效）。issue 重新出现目前是靠 Alert Rule 命中新事件、走 `event_alert` 顺带覆盖的。
- **`data.issue` 里自带了一批很有用的字段**，不需要额外调 Sentry REST API：`shortId`（问题编号）、`status`、`count`/`userCount`（累计事件数/受影响用户数，注意是**累计总数**不是滚动窗口）、`assignedTo`、`priority`、`firstSeen`/`lastSeen`、`culprit`、`level`。
- `data.alert` 是触发这条通知的 Workflow 本身的信息（id/title/web_url），不是 issue 详情链接。
- `data.issue.project` 结构稳定（`{id, name, slug, platform}`），比 `event_alert`/`error` 只给数字 ID 丰富得多，路由和展示都可以直接用。

---

## 网关侧的踩坑记录

1. **签名必须对原始请求体字节算 HMAC**，不能对解析/重新序列化后的 JSON 算。
2. **详情链接只能用 `web_url`**，绝不能 fallback 到 `url`（API 地址）或 `request.url`。
3. **响应必须在 1 秒内返回**，飞书发送要放到响应之后异步做，否则 Sentry 侧会判定超时失败（`error_type='readtimeout'`），且不重试。
4. **`environment` 大部分情况不是顶层字段**，要么在 `tags` 数组里（两种格式：`[key,value]` 数组对 或 `{key,value}` 对象），要么（metric_alert）在 `alert_rule.environment`。
5. **自建 Sentry 有 SSRF 防护**，默认屏蔽向私有 IP 段发 webhook，需要在 `sentry.conf.py` 加 `SENTRY_ALLOWED_IPS` 白名单 + 重启 web/taskworker 容器才生效。
6. **同一个"问题状态变化"可能会通过不止一种 resource 到达**（这次是 `event_alert` + `activity_alert` 同时命中），如果都配置了对应的 Feishu 群，要注意会不会重复发消息。
