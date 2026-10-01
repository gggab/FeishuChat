# 飞书多用户 MCP 网关

公司内部的飞书共享 MCP 服务：每位同事用自己的飞书账号 OAuth 授权一次，获得一个**个人专属 MCP URL**，配置到自己的 AI 客户端（Claude Code / Cursor / Kimi Code 等）后，AI 即可以该同事本人的飞书身份：

- 读取群聊列表与聊天消息
- 发送 / 回复飞书消息（工具描述中已要求 AI 先向你展示内容并确认）
- 读取飞书邮箱（文件夹、邮件列表、邮件详情）

> 为什么不用官方 `@larksuiteoapi/lark-mcp`？其 OAuth 模式只支持 localhost 单用户，本项目实现了多用户网关：一个内网部署实例，服务全组同事。

## 架构

```
GET  /              → 说明页 + 「飞书授权登录」入口
GET  /oauth/login   → 生成 state（内存，10 分钟过期），302 到飞书授权页
GET  /oauth/callback→ 校验 state，授权码换 user_access_token + refresh_token，
                      拉取用户信息，AES-256-GCM 加密落盘，生成 user_token，
                      返回成功页展示个人 MCP URL 和客户端配置 JSON
ANY  /mcp/:userToken→ MCP Streamable HTTP 端点（无状态模式），按 userToken 找到
                      用户令牌（距过期 <5 分钟自动用 refresh_token 刷新），以该用户身份调飞书 API
POST /webhooks/sentry→ Sentry Internal Integration webhook：验签后以应用身份把告警
                      卡片发到指定飞书群（tenant_access_token 自动缓存刷新）
GET  /healthz       → 健康检查
```

- 令牌存储：`DATA_DIR/tokens.json`，access_token / refresh_token 均以 AES-256-GCM 加密（密钥来自环境变量），原子写入（临时文件 + rename）。
- 审计日志：`logs/audit.log`，只记录时间、open_id、工具名、参数键名，绝不记录消息/邮件正文和 token。
- 限流：每 userToken 每分钟 60 次（内存滑动窗口）。

## 一、飞书开放平台配置清单

1. 登录 [飞书开放平台](https://open.feishu.cn/)，**开发者后台 → 创建企业自建应用**，记录 `App ID` / `App Secret`。
2. **安全设置 → 重定向 URL**，添加回调地址：
   `http://<内网服务器IP或域名>:3000/oauth/callback`（须与 `PUBLIC_BASE_URL` 拼出的地址完全一致）。
3. **权限管理**，为应用开通以下 scope：

   | scope | 用途 |
   |---|---|
   | `im:message` | 发送 / 回复消息 |
   | `im:message:readonly` | 读取消息 |
   | `im:chat:readonly` | 读取群列表（只读） |
   | `im:chat` | 群信息读写 |
   | `mail:user_mailbox.folder:read` | 读取邮箱文件夹 |
   | `mail:user_mailbox.message:readonly` | 读取邮件列表与详情 |
   | `mail:user_mailbox.message:modify` | 移动邮件到文件夹（batch_modify） |
   | `contact:user.id:readonly` | 读取用户 ID（获取用户信息） |
   | `calendar:calendar:readonly` | 读取用户主日历 |
   | `calendar:calendar.event:read` | 读取用户日程（list_calendar_events） |

   > 全部加在「**用户身份**」下。授权 URL 会显式携带 scope（不传时飞书只授予 `auth:user.id:read`），因此**新增权限后必须：创建版本并发布 → 用户重新授权**，否则工具调用报 99991679。

   > 建议同时开启「获取用户 user ID」类基础权限；若调用时返回 99991672/99991679 等权限错误，按报错提示补开对应权限并重新发布版本。
4. **版本管理与发布 → 创建版本并发布**（企业自建应用提交后由管理员审核通过即生效）。后续每次改权限都要重新发布。

## 二、部署步骤（内网服务器）

环境要求：Node.js ≥ 20（无原生编译依赖，无需 sqlite）。

```bash
# 1. 安装依赖并构建
npm install
npm run build

# 2. 配置环境变量
cp .env.example .env
# 生成加密密钥并填入 .env 的 TOKEN_ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# 填写 APP_ID / APP_SECRET，把 PUBLIC_BASE_URL 改成 http://<内网IP>:3000

# 3. 启动（三选一）
npm start                 # 直接运行
# 用 PM2：
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
# 或用 systemd（无需装 PM2，Ubuntu 自带）：
sudo cp deploy/feishu-mcp-gateway.service /etc/systemd/system/
# 按需修改 Unit 文件中的 WorkingDirectory / ExecStart（node 路径）/ User
sudo systemctl daemon-reload
sudo systemctl enable --now feishu-mcp-gateway
systemctl status feishu-mcp-gateway          # 查看状态
journalctl -u feishu-mcp-gateway -f          # 跟踪日志
```

Docker 方式：

```bash
docker build -t feishu-mcp-gateway .
docker run -d --name feishu-mcp-gateway \
  -p 3000:3000 \
  --env-file .env \
  -v $(pwd)/data:/app/data -v $(pwd)/logs:/app/logs \
  feishu-mcp-gateway
```

验证：`curl http://127.0.0.1:3000/healthz` 返回 `{"ok":true,...}`。

## 三、同事使用指南

1. 浏览器打开 `http://<内网IP>:3000/`，点击「飞书授权登录」，用飞书扫码/确认授权。
2. 授权成功页会展示你的**专属 MCP URL** 和配置 JSON，例如：

   ```json
   {
     "mcpServers": {
       "feishu": {
         "type": "http",
         "url": "http://192.168.x.x:3000/mcp/<你的userToken>"
       }
     }
   }
   ```

3. 把它加入自己 AI 客户端的 MCP 配置（Claude Code 的 `~/.claude.json` / Cursor 的 `mcp.json` / Kimi Code 的 MCP 配置），重启客户端即可。
4. **注意：该 URL 等同于你的飞书身份凭证，不要分享给他人。** 若泄露，联系管理员删除 `data/tokens.json` 中对应条目并重启（或直接编辑删除该 userToken 条目）。

## 四、Sentry 告警接入（可选）

把 Sentry 告警以**当前飞书应用（机器人）身份**推送到飞书群：

1. **飞书侧**：
   - 确认应用已开启**机器人能力**（开发者后台 → 应用能力 → 机器人），并把机器人拉进目标群；
   - `im:message` 权限需对**应用身份**生效（如权限只加在「用户身份」下，需在权限管理中补开并重新发布版本）；
   - 拿到目标群的 `chat_id`（`oc_` 开头，可通过 `list_chats` 工具或 `im/v1/chats` 接口查到），填入 `.env` 的 `FEISHU_ALERT_CHAT_ID`。
2. **Sentry 侧**：Settings → Developer Settings → New Internal Integration：
   - Webhook URL 填 `http://<内网IP>:3000/webhooks/sentry`；
   - 勾选 **Alert Rule Action**（issue 告警）或订阅 **Metric Alert** webhook；
   - 保存后复制集成的 **Client Secret**，填入 `.env` 的 `SENTRY_WEBHOOK_SECRET`。
3. 在 Sentry 告警规则（Alerts → Create Alert）的 action 中选择该内部集成即可。

网关用 `Sentry-Hook-Signature`（HMAC-SHA256）验签，伪造请求会被 401 拒绝；`SENTRY_WEBHOOK_SECRET` 缺失时端点整体返回 503，不影响其他功能。发送用的是 `tenant_access_token`（应用身份），网关内缓存、距过期 5 分钟自动重取。

### Sentry 项目配置页（Alert routing settings）

配置页用于管理「Sentry 项目 + 环境 → 飞书群」映射，并为每条映射设置告警卡片的时间显示时区。使用前先完成上面的机器人权限、入群和 Sentry webhook 配置；保存映射不会自动配置 Sentry 告警规则。

#### 启用与访问

在**服务器部署目录的 `.env`** 中设置以下配置（占位值需替换）：

```dotenv
# 配置页的管理员访问口令，设置为独立的随机长字符串
ADMIN_TOKEN=<管理员访问口令>
# 可选：未配置项目映射时使用的默认群，留空则跳过这些告警
FEISHU_ALERT_CHAT_ID=oc_xxx
```

修改 `.env` 后重启服务，使配置生效。systemd 部署执行 `sudo systemctl restart feishu-mcp-gateway`；PM2 部署执行 `pm2 restart feishu-mcp-gateway`；Docker 使用 `--env-file` 部署时需用原有端口和数据挂载重建容器，单纯重启容器不会重新读取 env 文件。

浏览器访问以下地址，替换为实际网关地址和管理员口令；有反向代理时使用对外域名：

```text
http://<网关地址>:3000/admin/sentry-projects?token=<ADMIN_TOKEN>
```

`ADMIN_TOKEN` 未配置时页面返回 **503**；访问口令缺失或错误时返回 **401**。此口令不是飞书 App Secret，也不是 Sentry Client Secret；含口令的管理页链接不要分享给普通用户。

#### 新增、编辑与删除

1. 点击 **Add configuration**，填写以下字段：

   | 字段 | 填写方式 |
   |---|---|
   | Sentry project ID | Sentry 项目的数字 ID，可在 Sentry 项目设置页查看；不要填项目名或 slug。 |
   | Environment (optional) | 填 Sentry 的环境原值，例如 `production`、`staging`，区分大小写，首尾空格会被去除。留空表示项目默认映射。 |
   | Feishu chat ID | 目标飞书群的 `chat_id`（`oc_` 开头），机器人必须已加入该群。可通过 `list_chats` 查询。 |
   | Timezone | 默认 `Asia/Riyadh`。可搜索城市或 IANA 时区名，选择 `Asia/Shanghai` 等时区；也支持输入其他有效 IANA 时区名。 |

2. 查看 **Timestamp preview** 的 UTC → 所选时区换算示例，点击 **Save configuration** 保存。预览使用当前时间，不会发送测试告警。
3. 首次收到新的「项目 ID + 环境」告警时，自动新增 **Pending configuration** 记录，接收群留空；重复告警不会重复新增。项目名 / slug 在告警提供这些信息后自动回填，不需要手动填写。点击 **Edit** 补充群和时区即可启用该映射。
4. 点击 **Edit** 可修改目标群和时区，再点击 **Save changes**。项目 ID 和环境不可编辑；如果填错，删除原映射后重新新增。同一项目可添加多条不同环境的映射，再次新增相同的「项目 ID + 环境」会更新该配置。
5. 点击 **Delete** 并确认后只删除所选映射，保留同项目其他环境的配置。删除环境映射后，该环境后续告警回退到项目默认映射，并重新生成待配置记录；再无匹配则使用全局默认群，全局默认群未配置则跳过发送。

#### 路由与时区规则

- 优先匹配「项目 ID + environment」；未匹配或告警未提供环境时，使用环境留空的项目默认映射；再未匹配时使用 `.env` 的 `FEISHU_ALERT_CHAT_ID`，全局默认群留空则不发送。已有的项目映射自动作为项目默认映射，无需手动迁移。
- 自动新增的待配置记录不参与路由或时区选择，继续使用上述回退逻辑；即使没有可用接收群，也会保存待配置记录。无环境的告警会新增环境留空的记录。验签失败和安装/卸载事件不会新增记录；没有项目 ID 的告警也无法新增项目映射。
- 例如同一项目 `4` 可以配置 `production → oc_prod`、`staging → oc_staging`，再加一条环境留空的映射用于接收其他环境或缺少环境的告警。环境取自 Sentry webhook 的 environment 字段或 environment 标签，而非网关自身的运行环境。
- `metric_alert` 类型的 payload 没有数字项目 ID，无法参与按项目路由，使用默认群。
- 时区按最终匹配的映射独立设置。例如同项目的生产环境群使用 `Asia/Riyadh`（UTC+3），测试环境群使用 `Asia/Shanghai`（UTC+8）。没有专属时区的映射和全局默认群均使用 `Asia/Riyadh`。
- 卡片时间是发送时生成的固定文本，不随查看者设备时区变化。修改配置只影响之后发送的卡片，不会更新已经发送的消息。
- 目标群不存在或机器人不在群里导致发送失败时，服务记录日志，不会转发到默认群，也不会作为 webhook 错误要求 Sentry 重试。

#### 生效与数据保存

配置页保存或删除成功后，**无需重启服务**，后续告警即使用新配置。映射保存在 `DATA_DIR/sentryProjects.json`（默认 `./data/sentryProjects.json`），不写入 `.env`。

重新部署时保留原来的数据目录；Docker 按部署示例挂载 `/app/data`，自定义 `DATA_DIR` 时挂载对应目录。服务运行用户需有数据目录写权限。验证配置时，检查列表中的项目 ID、环境、群 ID 和时区，再通过真实 Sentry 告警确认目标群收到卡片；保存成功只代表映射已保存，不代表消息已送达。

## 五、开发

```bash
npm run dev        # tsx 热启动
npm test           # vitest 单元测试（不依赖真实飞书凭证）
npm run typecheck  # 类型检查
npm run build      # 编译到 dist/
```

## 六、端到端联调步骤（需要真实飞书应用后执行）

1. 按第一节完成飞书应用配置并发布，`.env` 填入真实 `APP_ID` / `APP_SECRET`。
2. 启动服务后走一遍完整授权流程，确认成功页能拿到 MCP URL。
3. 用支持 MCP 的客户端配置该 URL，依次验证：
   - `list_chats` 能列出自己加入的群；
   - `list_messages` / `get_message` 能读到群消息；
   - `send_message` / `reply_message` 能发出消息（AI 应先展示内容并请你确认）；
   - `list_mail_folders` / `list_mail_messages` / `get_mail_message` 能读邮箱（需邮箱权限已发布；`get_mail_message` 默认 metadata 格式，需要主题/发件人/正文时传 `format: "full"`）；
   - `search_mail_messages` 能按关键词和 from/to/folder 等条件搜索邮件；
   - `move_mail_messages` 能把邮件批量移入指定文件夹（AI 应先展示并请你确认）。
4. 观察 `logs/audit.log` 是否按预期记录调用（无正文、无 token）。
5. 令牌过期场景：user_access_token 有效期约 2 小时，网关会在距过期 <5 分钟时自动刷新；refresh_token（约 30 天）过期后工具会返回错误，提示重新访问 `/oauth/login` 授权。

## 安全说明

- `TOKEN_ENCRYPTION_KEY` 只存在服务器 `.env` 中，请妥善保管；丢失后已加密令牌无法解密，所有人需重新授权。
- `data/` 与 `logs/` 已在 `.gitignore` 中排除，不要提交到仓库。
- 审计日志刻意只记参数键名，正文内容不落盘。
