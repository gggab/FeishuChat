# event_alert 卡片内容设计

不区分新问题/旧问题复现，统一叫“错误告警”。以下定义内容，以及评审确认的中英文文案和紧凑排版。

## 标题

中文：`{环境} · 错误告警`，没有环境就只写“错误告警”。

英文：`{environment} · Error alert`，没有环境就只写“Error alert”。环境原值保留。

## 正文内容

下表编号表示内容项，不要求每项独占一行。实际布局采用后文的并列规则。

| 行 | 内容 | 数据来源 | 没有就不显示 |
|---|---|---|---|
| 1 | 项目名 | `event.project`（数字ID，配合 URL 正则出 slug）→ 展示 slug，没有就展示 `#id` | 是 |
| 2 | 错误摘要 | `event.title` 或 `event.message` | 是 |
| 3 | 级别 | `event.level` | 是 |
| 4 | 触发规则 | `data.triggered_rule` | 是 |
| 5 | 定位线索 | `event.culprit` | 是 |
| 6 | 时间 | `event.datetime`，事件发生时间，不是收到时间 | 是 |
| 7 | 版本 | `event.release`（Sentry release 字符串，如 `std-smart-office-dashboard@1.9.1+local`） | 是 |
| 8 | 崩溃模块（仅 Flutter） | `contexts.module_crash`：`module` + `function` + `crash_location` | 是 |
| 9 | 设备（仅 Flutter） | `contexts.device.model` + `contexts.os.os` | 是 |
| 10 | App 版本（仅 Flutter） | `contexts.app.app_version` + `contexts.app.app_build` | 是 |

按钮：中文“查看详情”，英文“View details”，链接 `event.web_url`，没有就不出按钮。

第 7 行"版本"（`release`）和第 10 行"App 版本"（`app_version`+`app_build`）不是一回事，两个都存在时都保留：`release` 是 Sentry 发布标识字符串，Web/Flutter 都可能有；`app_version` 是移动端展示给用户的版本号，只有 Flutter 才有。

## Flutter 专属三行怎么拼

- 崩溃模块：`{module} · {function}（{crash_location}）`，缺哪部分就去掉哪部分
- 设备：`{model} · {os}`，如 `Pixel 4 · Android 13`
- App 版本：`{app_version} ({app_build})`，如 `2.9.2 (260901001)`

判断是不是 Flutter：看 `contexts.device`/`contexts.app`/`contexts.module_crash` 有没有，有就加这三行，没有就没有这三行，不用 `platform` 字段判断。

## 排版与中英文

- 项目名、错误摘要位于正文顶部；错误摘要独占整行并自动换行。
- 级别与时间并列，触发规则与定位线索并列。
- 版本（release）和崩溃模块保留整行，长文本自动换行。
- Flutter 的设备与 App 版本并列；release 与 App 版本分别保留。
- 缺失内容不生成空字段或占位符；并列行只剩一项时收起空列，整行无内容时删除该行。
- 卡片宽度不足以清晰显示双列内容时可改为单列；短字段优先并列。
- 中英文分别展示相同内容结构，固定标签翻译，上游错误原文、规则名、定位信息、项目和版本标识不翻译。

| 中文标签 | English |
|---|---|
| 级别 | Level |
| 时间 | Event time |
| 触发规则 | Triggered rule |
| 定位线索 | Location hint |
| 版本 | Release |
| 崩溃模块 | Crash module |
| 设备 | Device |
| App 版本 | App version |

## Figma 设计

[错误告警设计稿](https://www.figma.com/design/3pg9cagKXQp0iUsTZEpTLP/Feishu-Card?node-id=24-2)

包含 Web、Flutter、字段缺失窄屏三个场景，各有中文和英文版本，共六张卡片。旧设计、旧说明、HTML 预览、JSON 样例和同步脚本已移除。

画布中的数据为合成示例；示例时间带 UTC 偏移，来源语义为事件发生时间。设计稿未连接真实详情地址，也不代表网关已按新规格实现；飞书客户端实际渲染另行验证。
