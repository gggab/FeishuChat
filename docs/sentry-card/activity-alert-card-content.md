# activity_alert：问题已解决通知卡片

依据：`../activity_alert.json` 中提供的实际 webhook 样本。

[Figma 中英文设计](https://www.figma.com/design/3pg9cagKXQp0iUsTZEpTLP/Feishu-Card?node-id=69-2)

## 通知语义

- 该样本顶层 `action` 是 `triggered`；已解决通知由 `data.activity.type = status_resolved` 确定，`data.issue.status = resolved` 与其一致。
- 标题：**问题已解决 / Issue resolved**，绿色标题栏。不区分首次解决与再次解决。
- 表达 Sentry 问题被标记为已解决，不承诺业务恢复或故障根因已修复。生成一张新通知，不假设原错误告警卡片会同步更新。
- 样本没有环境、解决时间、release 或 Flutter 上下文，因此不展示这些字段。
- `firstSeen`、`lastSeen` 不是解决时间；顶层 `actor.name = Sentry` 不是执行解决操作的用户；`assignedTo = null` 也不能代替操作人。

## 内容与数据来源

| 内容 | English | 来源 | 样本值 |
|---|---|---|---|
| 项目名 | Project | `data.issue.project.name`，缺失时使用 slug，再缺失时使用 `#id` | std-smart-office-dashboard |
| 错误摘要 | Summary | `data.issue.title`，保留原文 | TypeError: Cannot read properties of undefined (reading 'x') |
| 问题编号 | Issue ID | `data.issue.shortId`，缺失时使用 `#id` | STD-SMART-OFFICE-DASHBOARD-7 |
| 操作人 | Changed by | `data.activity.details.user.name`，缺失时使用 username | liaowentao@sensetime.com |
| 原问题级别 | Original issue level | `data.issue.level`，保留原值 | error |
| 定位线索 | Location hint | `data.issue.culprit` | Screen |
| 告警名称 | Alert name | `data.alert.title`，不解释为阈值或触发规则条件 | Smart Office Monitor |
| 累计事件数 | Total events | `data.issue.count` | 104 |
| 累计用户数 | Total users | `data.issue.userCount` | 1 |
| 首次出现 | First seen | `data.issue.firstSeen` | 2026-09-06T12:52:30.299Z |
| 最近出现 | Last seen | `data.issue.lastSeen` | 2026-09-09T10:01:27.786Z |

缺失字段直接隐藏，合法的数字 0 保留。累计数是该 Issue 的累计值，不代表最近一段时间或当前环境的统计，也不代表仍有多少用户受影响。

## 排版

- 项目名、错误摘要、问题编号依次展示；摘要和编号保留整行。
- 双列排列：操作人 / 原问题级别、定位线索 / 告警名称、累计事件数 / 累计用户数、首次出现 / 最近出现。
- 每个字段的标签与值放在同一文本层，保证内容完整；长文本换行，窄屏可改为单列。
- 统计说明：**统计为该 Issue 的累计值。 / Cumulative totals for this issue.**
- 示例时间采用 UTC+03:00：首次出现为 `2026-09-06 15:52:30`，最近出现为 `2026-09-09 13:01:27`。偏移单独换行显示；原始 UTC 时间保留在源数据中。此处沿用卡片示例的群时区显示方式，不表示现有解析器已支持群时区。
- 中英文固定标签分别翻译；项目名、错误摘要、规则名称、定位信息、用户名称及编号保留原文。

## 按钮

**查看问题 / View issue**，使用 `data.issue.web_url`。

该样本目标为问题 22 的 Web 页面；不能替换为 `issue.url` 的 API 地址，也不能误用 `data.alert.web_url` 的告警配置页面。无有效问题详情链接时隐藏按钮。Figma 两个语言版本均已设置打开样本问题页面的原型链接。

## 交付范围

本次新增 Figma 中英文卡片和此内容文档。现有解析器已有 activity 类型到 resolved 通知的映射，但操作人、问题编号、统计和时间等丰富字段仍需后续实现核对；本次没有修改网关逻辑、发送飞书消息、提交或部署。
