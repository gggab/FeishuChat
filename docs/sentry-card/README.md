# Sentry 飞书告警卡修订规格

【中文】

本目录是设计及交接产物，不是已上线的网关实现。2026-09-08 对照 `src/sentryAlert.ts`、`src/feishuCard.ts`、相关测试及官方文档修订。所有预览值均为合成样例，不是捕获的生产 webhook。HTML 只模拟布局和语言选择，不是飞书渲染器。

## 已确定的范围

- 沿用 Schema 1.0（与当前生成器一样省略 `schema`），保留 `header.title.i18n` 和顶层 `i18n_elements`；每张卡同时发送 `zh_cn`、`en_us`。
- 不接入 Sentry REST API，不新增 Token，不增加 webhook 热路径的外部请求。
- 时区按接收群配置：示例提供沙特群 `Asia/Riyadh`（UTC+03:00）、中国群 `Asia/Shanghai`（UTC+08:00），未配置群回退 UTC。原始时间仍按 UTC 保存，卡片渲染时只按群时区格式化；查看者设备时区不会改写卡片内容。
- 标题为“原始环境值 · 通知类型／状态”；没有环境就只写通知类型，不猜 production 或 development。环境原值不翻译，避免丢失 staging/jv26 等部署标识。
- 项目只展示一次，移入正文；取 name → slug → `#id`，均缺失则隐藏。未知资源不冒充错误告警。
- 正文按项目、摘要、规则／状态、可用上下文、主按钮排列；动态错误原文保留，不通过拆冒号强行推导异常类型。基础版以普通文本输出，避免把上游内容解释为 Markdown 指令。
- 使用旧版 `div`、`div.fields`、`hr`、`note`、`action.actions[].button`。按钮沿用 `primary` 和 `url`，无有效详情链接时删除整个操作区。
- Schema 2.0 迁移是独立事项，不是此次布局改版的前提。

## Schema 和原生多语言核对

飞书官方文档明确：**Card JSON 2.0 不支持全局多语言**。旧版的顶层 `i18n_elements` 和 `header.title.i18n` 不能直接复制到 Card 2.0。2.0 需要在组件文本的对应位置使用 `i18n_content`，不是把 `i18n_elements` 挪进 `body`。

本稿继续采用已经使用的旧版全局多语言机制。官方说明配置中英文而客户端为日文时会回退为英文。预览中的日语选项模拟该行为；真实客户端回退仍需试发确认。

固定标题、字段标签、已知动作／状态和按钮均配中英文。项目、规则名、错误、culprit、描述等上游原文不做机器翻译。未知枚举原样显示，不能翻译成不匹配的已知状态。不要为未支持的语种生成空内容，也不要依赖飞书的“翻译消息”功能实现原生多语言。

## 数据来源与显示规则

| 内容 | 当前依据 | 本次规格 |
|---|---|---|
| 环境 | event/error/issue 的 environment 或 tags；metric 的 alert_rule.environment；当前 parser 已有 | 有值才进入标题；Issue 的环境值不代表累计数已按此环境筛选 |
| 项目 | projectName / projectSlug / projectId；当前 parser 已有 | 正文只显示一次；来自 URL 的项目 slug 与页面 URL 严格区分 |
| 错误／问题摘要 | 当前 parser 的 titleText | 显示原文，沿用 200 字符截断；无有效标题用中英文无标题提示 |
| 触发规则 | event_alert 的 data.triggered_rule；当前 parser 已有 | 标签为“触发规则 / Triggered rule”，只显示规则名，不解释为阈值条件 |
| 级别与动作 | level、body.action；当前 parser 已有 | 按资源上下文显示；原始 `error` 级别不是业务 P0/P1 |
| 定位线索 | culprit；当前 parser 已有 | 标签为“定位线索 / Location hint”，原样显示，不能给 `Screen` 补路径或行号 |
| 指标说明 | description_text，其次当前解析器的 description | 优先纯文本；若降级内容包含 HTML，先转为可读文本；不凭说明伪造结构化统计 |
| 累计事件／用户 | 仅当 issue payload 实际带 count/userCount | 独立可选项；标签明确“累计 / Total”和 Issue 范围，不写近 5 分钟或当前环境；当前 parser 尚未提取 |
| 状态／编号 | 仅当 issue 实际带 status/shortId | 独立可选项；当前 parser 尚未提取；缺字段不写“未解决” |
| 负责人 | issue.assignedTo | 仅对象有合法展示名时显示名称；显式 null 可显示未分配；字段缺失表示未知并隐藏；当前 parser 尚未提取 |
| 版本 | event/error.release 的有效字符串，或明确结构中的 version | 有有效值才显示；不从 firstRelease 推导本次事件版本；本稿用 `dashboard@1.8.3` 展示可用状态 |
| 页面／请求地址 | event/error.request.url 或已确认语义的 URL/路由 tag | 可选；需样本及解析；去除敏感查询参数；request.url 不一定是浏览器页面，无法确认时称“请求地址” |
| 精确位置 | 实际 exception stack frames | 可选；需样本、frame 选择和 source map 结果；没有 .vue 原文件证据就不展示 .vue 行号；基础版只显示 culprit |
| 时间 | 本次事件 datetime/timestamp、Issue firstSeen/lastSeen、metric 的 started/date_closed 等各自字段 | 按字段语义分别标为发生、首次出现、最近出现、开始或关闭；缺失就隐藏，不用收到时间冒充错误发生或恢复。展示值按接收群时区格式化并标出 UTC 偏移 |
| 群时区 | 网关按已解析的 chat_id 查群配置；本稿为设计样例 | 时区属于群，不属于项目；同一群内所有人看到同一时间。群未配置时使用 UTC，并在管理配置中明确显示回退状态 |
| 主按钮 | 类型对应的有效 web_url | event_alert/error → 事件详情；issue → 问题；metric → 指标告警；未知资源 → 查看详情。API URL 和 request.url 不能作为详情链接回退 |

`undefined`、空字符串和不可用占位符不生成字段或空分隔线；合法数字 0 可以展示，不能用 truthy 判断把它抹掉。缺失用户数不能显示 0；即使收到 0，也不能解释为业务上无人受影响。

官方 `event_alert` 示例**确实包含** request.url、exception.values[].stacktrace.frames、release 和 datetime。因此应说“本部署的样本尚未验证、当前 parser 尚未提取”，不能说这些字段必定不在所有 webhook 内。同样，规则告警的 triggered_rule 是名称，但 metric_alert 的 alert_rule 可以包含规则 ID、时间窗口和 triggers；不能把 event_alert 的数据限制套用到 metric_alert。

## 类型及状态覆盖

Sentry 官方的 **Issue Alerts 对应 resource=event_alert**，而 **resource=issue 对应问题生命周期通知**。按请求头区分，不混用这两个名称。

| 场景 | 标题／颜色 | 内容与操作 |
|---|---|---|
| error | 错误事件 / Error event；已知 error/fatal 红、warning 橙 | 摘要、级别、culprit、事件详情 |
| event_alert | 规则告警 / Rule alert；颜色按已知级别 | 摘要、规则名、级别、culprit、告警事件详情；不假装是首次出现 |
| issue created | 新问题 / New issue | action、level、摘要、culprit；可选字段逐个启用 |
| issue resolved | 问题已解决 / Issue resolved；绿 | 保留原摘要方便认出问题；level 改标“原问题级别”，绿色由 resolved 动作决定 |
| issue unresolved | 问题未解决 / Issue unresolved | 仅在 substatus=regressed 有证据时才写“再次出现”；不从 unresolved 自行推断复发 |
| issue assigned | 问题已分配 / Issue assigned；蓝 | 动作通知；没有 assignedTo 对象不编造接手人 |
| issue archived | 问题已归档 / Issue archived；灰 | 不叫恢复，不推断数据清除 |
| metric critical | 指标告警 · 严重 / Metric alert · Critical；红 | 指标／事件标题、原始说明、状态、指标告警详情；无 Issue 区域 |
| metric warning | 指标告警 · 警告 / Metric alert · Warning；橙 | 不沿用当前 parser 的统一红色；这是待落地的显示修正 |
| metric resolved | 指标告警 · 已恢复 / Metric alert · Resolved；绿 | 无有效 date_closed 就不写恢复时间／持续时长；不推断所有业务恢复 |
| 未知资源／动作 | Sentry 通知 / Sentry notification；未知资源灰 | 保留原始 resource/action，字段缺失则隐藏，无 URL 则无按钮 |

单条旧事件卡不假装实时状态页：解决／恢复通知按新的 webhook 生成新卡，不在没有后端更新能力时承诺原卡会变色。若动作与 payload 状态矛盾，标题忠实表达通知动作，正文如有状态则清楚标为上游状态，不自建更强结论。多个项目不得静默显示为只有一个项目；当前 metric parser 仅取 projects[0]，实现时需明确单项目契约或补充项目列表，设计不改变路由规则。

## 文件和验证

- `sentry-feishu-card.scenarios.json`：九个基础样例，每项包含依据说明和完整原生双语 `card`；同步脚本把三个群时区的 `cardsByGroup` 变体写入 HTML 预览数据，供评审切换。
- `sentry-feishu-card.example.json`：默认以沙特群 UTC+03:00 格式化的 error 样例，完整可解析的旧版 card；所有 example.invalid 链接都必须替换。
- `sentry-feishu-card.html`：内嵌同一份 JSON 的交互预览片段；支持场景、中文、英文、日语回退和群时区切换。
- `preview.html`：可独立打开的同源预览。
- `sync-preview.mjs`：仅同步设计文件，运行 `node docs/sentry-card/sync-preview.mjs`。验证九个样例的原生双语结构、恢复／警告颜色、无链接降级及统计口径。

基础卡片布局使用现有 parser 已表达的字段；时间、版本和群时区是本轮设计的可选字段契约，落地时需要补充解析及 `chat_id → IANA 时区` 配置读取。可选累计数据样例依赖额外解析，不能直接说现有网关已经支持。当前源代码及测试的已有修改由原任务保留。

验收分为三层：本地 JSON/同步检查、HTML 排版及切换检查、飞书真实发送及多语言客户端检查。本次只做前两层；试发、网关变更和部署另行执行。

本次本地结果：同步脚本通过；9 个场景 × 3 种语言回退 × 3 个群时区的预览数据已生成；沙特、中国、UTC 三组时间使用同一 UTC 源值并分别格式化，跨日场景保留本地日期；日语模拟输出与英文一致；resolved 绿色、warning 橙色、无链接时无按钮均通过；360px 窄屏无横向溢出。四个已有修改的源码／测试文件 SHA-256 与本轮开始时一致。未向飞书发送消息，未验证真实客户端原生多语言。

## 官方依据（核对于 2026-09-08）

- [飞书多语言：1.0 全局多语言、2.0 局部多语言、英文回退](https://open.feishu.cn/document/feishu-cards/configure-multi-language-content)
- [飞书 JSON 2.0 结构](https://open.feishu.cn/document/feishu-cards/card-json-v2-structure)
- [Sentry Issue Alerts：event_alert 及含 request/stacktrace 的官方样例](https://docs.sentry.io/integrations/integration-platform/webhooks/issue-alerts/)
- [Sentry Issues：issue 生命周期、状态及可选累计信息](https://docs.sentry.io/integrations/integration-platform/webhooks/issues/)
- [Sentry Metric Alerts：critical/warning/resolved 与独立的数据结构](https://docs.sentry.io/integrations/integration-platform/webhooks/metric-alerts/)

【English】

These are revised design artifacts, not deployed gateway changes. All values are synthetic. Keep JSON 1.0 and the existing native `header.title.i18n` plus top-level `i18n_elements`, including both `zh_cn` and `en_us`. Feishu documents English fallback for a Japanese client when only Chinese and English are configured. JSON 2.0 does not support the old global language structure; a future migration must use component-level `i18n_content` and be verified separately.

The base design uses fields already extracted by the gateway: environment, project, title, level/action, triggered rule name, culprit, metric description, and detail URL. Optional event timestamps and releases are shown when their payload values are present. Move the environment into the header and show the project once in the body. Keep upstream text unchanged. Translate fixed labels and known states. Never infer thresholds from a rule name, manufacture a source filename/line, or treat missing data as zero/unassigned/unresolved.

Optional issue count/userCount are lifetime issue totals with the original payload scope, not rolling-window or environment-filtered metrics. An explicit assignedTo=null can mean unassigned; a missing property cannot. Release and timestamps are displayed only when the corresponding payload fields are parsed; the design does not invent values. The preview demonstrates a `chat_id` mapping to `Asia/Riyadh`, `Asia/Shanghai`, or UTC and keeps the offset visible in the card. Official event_alert examples contain request, stacktrace, release, and datetime data, so their absence is not universal. This design adds no Sentry API requests or credentials.

`event_alert` is the Issue Alert rule webhook; `issue` is the issue lifecycle webhook. Distinguish an issue being marked resolved from a metric alert becoming resolved. Metric critical is red, warning orange, and resolved green. A metric card has no issue statistics or issue action. Unknown resources retain their raw resource/action. Missing valid URLs remove the action area. Event API URLs and request URLs are not user-facing detail links.

The nine scenarios cover error, rule alert, new/resolved issue, critical/warning/resolved metric alert, an unknown resource with no URL, and an issue with optional fields. The Chinese tables define additional lifecycle, missing-data, multi-project, timestamp, and per-group-timezone rules. The preview renders the same card JSON in either language and simulates unsupported-locale fallback; its group selector changes only the presentation timezone, while the card itself displays the selected offset. Run `node docs/sentry-card/sync-preview.mjs` after editing the scenarios. Preview controls are outside the actual card; demo buttons do not contact Sentry. Local checks do not substitute for sending cards and verifying Chinese, English, and an unsupported language in real Feishu clients.
