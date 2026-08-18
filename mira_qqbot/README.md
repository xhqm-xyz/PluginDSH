# mira_qqbot · DSH 接管本机 QQ 插件

通过 **OneBot v11** 协议连接本机 **NapCat**（跑在你的 QQ 客户端里），把「你本人的 QQ」交给 DSH agent 接管：收发消息、好友、群、群成员、频道等，全部以 MCP 风格工具（前缀 `qq_`）形式暴露给模型调用。

> 插件仅依赖 Node 内置能力（`fetch` / `WebSocket` / `fs` / `path` / `url`），以 link 方式装入 profile 时无需解析任何第三方依赖。

## 目录结构

```
mira_qqbot/
├── lib/
│   └── index.js            # 插件本体（DSU 风格：name + inject + apply，纯 Node 跨平台）
├── scripts/
│   ├── setup-napcat.sh     # NapCat 一键部署（macOS + Linux 自动检测）：配 OneBot WS 等
│   ├── setup-napcat.ps1    # NapCat 一键部署（Windows / PowerShell）：配 OneBot WS（可选自动重启）
│   └── restart-dsh-web.sh  # 重启 dsh web，使插件配置生效（macOS / Linux）
├── package.json
└── README.md
```

## 平台兼容性

| 组件 | macOS | Linux | Windows |
|---|---|---|---|
| 插件本体 `lib/index.js` | ✅ | ✅ | ✅ |
| `scripts/setup-napcat.sh` | ✅ | ✅（自动检测平台） | ❌（请用 ps1） |
| `scripts/setup-napcat.ps1` | ❌ | ❌ | ✅ |
| `scripts/restart-dsh-web.sh` | ✅ | ✅（需安装 `lsof`） | ⚠️ 需 Git Bash/WSL |

- **插件本体完全跨平台**：只依赖 Node 内置能力，无任何平台特定代码，DSH 能跑的地方它就能跑；
- NapCat 的 OneBot 配置格式（`onebot11_<uin>.json` 的 `websocketServers`）三平台一致，**只要 OneBot WebSocket 服务配好，插件连接部分无缝可用**；
- NapCat 官方配置目录：Windows 在 `%APPDATA%\QQ\NapCat\config`，Linux 在 `~/.config/QQ/NapCat/config`，macOS 在 `~/Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ/NapCat/config`。

## 工作原理

```
QQ 客户端（你的账号，带 --no-sandbox 启动，加载 NapCat.Shell）
        │  内部 OneBot v11 正向 WebSocket（默认 ws://127.0.0.1:3001）
        ▼
mira_qqbot 插件（连接 WS + 自动重连 + 心跳保活）
        │  ctx.tools 注册 qq_* 工具
        ▼
DSH agent（模型）——调用工具接管 QQ
```

## 前置条件

1. 已安装 **QQ 客户端**（macOS / Windows / Linux 任一），并能正常登录；
2. 已安装 **NapCat**（NapCat.Shell 或对应平台的 NapCat 运行环境）；
3. 已安装 **DSH** 及 `dsh web` profile；
4. 可选：`setup-napcat.sh` 需要 `python3` 与 `openssl`（macOS/Linux 一般自带或易安装）。

## 快速开始

### 第 1 步：部署 NapCat（可选，有现成环境可跳过）

按平台选择部署方式（最终效果一致：NapCat 开启 OneBot v11 正向 WebSocket）：

**macOS / Linux** —— 同一个脚本自动检测平台：
- **macOS**：校验 NapCat 文件 → 给 QQ 打入口补丁（需管理员密码）→ 以 `--no-sandbox` 启动 QQ → 打开 WebUI 等扫码 → 写入 OneBot v11 WebSocket 配置 → 重启生效；
- **Linux**：探测 NapCat 配置目录（默认 `~/.config/QQ/NapCat/config`，可用 `NAPCAT_CONFIG_DIR` 覆盖，Docker 版请映射出 config 目录）→ 写入 OneBot v11 WebSocket 配置 → 读取 WebUI 令牌（NapCat 启动请按你的安装方式，脚本不代为启动）。

```bash
bash scripts/setup-napcat.sh
```

**Windows** —— PowerShell 一键脚本：探测 NapCat 配置目录 → 写入 OneBot v11 WebSocket 配置 → （可选）自动重启 NapCat：

```powershell
# 仅配置（推荐先跑这个）
powershell -ExecutionPolicy Bypass -File scripts\setup-napcat.ps1
# 配置并自动重启 NapCat
powershell -ExecutionPolicy Bypass -File scripts\setup-napcat.ps1 -Restart
```

**Linux** —— 上一段已包含：直接用 `bash scripts/setup-napcat.sh`（自动检测到 Linux 后走 Linux 分支）；NapCat 本体建议用 [NapCat-Docker](https://github.com/NapNeko/NapCat-Docker) 或官方 Linux 版部署，`NAPCAT_CONFIG_DIR` 指向映射出来的 config 目录即可。重启 dsh web 用 `bash scripts/restart-dsh-web.sh`（需安装 `lsof`）。

`setup-napcat.sh`（macOS + Linux）支持的环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `WS_TOKEN` | 自动生成随机值 | OneBot WebSocket access_token；**不写死在脚本里**，可多次运行复用同一值 |
| `WS_PORT` | `3001` | OneBot WebSocket 端口 |
| `QQ_APP` | `/Applications/QQ.app` | （macOS）QQ.app 路径 |
| `NAPCAT_CONFIG_DIR` | `~/.config/QQ/NapCat/config` | （Linux）NapCat 配置目录 |

`setup-napcat.ps1`（Windows）支持的参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `-Token` | 自动生成随机值（或读 `$env:WS_TOKEN`） | OneBot WebSocket access_token |
| `-Port` | `3001` | OneBot WebSocket 端口 |
| `-ConfigDir` | 自动探测（`%APPDATA%\QQ\NapCat\config` 等） | NapCat 配置目录 |
| `-Restart` | 关 | 写入后自动结束 QQ 进程并以 `--no-sandbox` 重启 NapCat |

也可以手动配置（等价操作）：

1. 用 `--no-sandbox` 启动 QQ，扫码登录；
2. 打开 NapCat WebUI（默认 `http://127.0.0.1:6099`）；
3. 在「网络配置」里新增一个 **WebSocket 服务**（正向），地址 `ws://127.0.0.1:3001`，按需设置 access_token；
4. 记下 `wsUrl` 与 `accessToken`，下一步填入插件配置。

> ⚠️ **App Store 版 QQ 需要「App 管理」权限才能打入口补丁**：App Store 下载的 QQ 包体带 `com.apple.macl` 保护，root 也无法直接改其 `package.json`（会报 `Operation not permitted`）。请先在「系统设置 → 隐私与安全性 → App 管理」里授权你的终端（或直接运行官方安装器 `~/Downloads/NapCatInstaller.app` 完成补丁）。一键脚本会检测该错误并提示。

### 第 2 步：把插件链接进 web profile

```bash
cd ~/.dsh/profiles/web
pnpm add mira_qqbot@link:<本插件所在目录的绝对路径>
```

> 提示：如果之前链接过，先 `pnpm remove mira_qqbot` 再重新 add。

### 第 3 步：在 patch 配置里启用插件

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，在顶层数组里追加（或修改已有的同名条目）：

```yaml
- insert:
    - id: mira_qqbot
      name: mira_qqbot
      config:
        enabled: true
        wsUrl: ws://127.0.0.1:3001      # 与 NapCat 里配的地址一致
        accessToken: ""                  # 与 NapCat 里配的 token 一致，无鉴权则留空
```

### 第 4 步：重启 dsh web 并验证

方式 A（推荐，用脚本）：

```bash
bash scripts/restart-dsh-web.sh
```

方式 B（手动）：先停掉当前 dsh web 进程，再运行 `dsh web --port 3080`。

重启后刷新浏览器页面，让 AI 调用 `qq_status` 工具验收：

```json
{
  "connected": true,
  "selfId": 10001,
  "nickname": "你的QQ昵称",
  "lastError": null,
  "bufferedMessages": 0,
  "wsUrl": "ws://127.0.0.1:3001"
}
```

`connected: true` 即表示插件已连上 NapCat，可以开始接管 QQ。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关；置 `false` 后插件启动即返回，不再连接 |
| `wsUrl` | `ws://127.0.0.1:3001` | OneBot v11 正向 WebSocket 地址 |
| `accessToken` | `''` | OneBot access_token（与 NapCat 一致，无鉴权留空） |
| `reconnectMinMs` / `reconnectMaxMs` | `2000` / `60000` | 断线重连退避区间（毫秒） |
| `callTimeoutMs` | `8000` | OneBot API 调用超时（毫秒） |
| `bufferSize` | `500` | 收到的消息环形缓冲上限（条） |
| `autoReply.enabled` | `false` | 自动应答模式总开关（见下节） |
| `autoReply.personaPrompt` | `''`（内置蝶清梦人设） | 人设提示词，留空用预设自带人设 |
| `autoReply.rulesPrompt` | `[]`（内置聊天规则） | 聊天规则提示词（数组或字符串），留空用内置默认规则 |
| `autoReply.securityPrompt` | `[]`（内置安全规则） | 安全规则提示词，留空用内置默认安全规则 |
| `autoReply.systemPrompt` | `''`（已废弃，兼容） | 旧字段；若配置且未配 `personaPrompt`，则当作人设使用 |
| `autoReply.trustedUsers` | `[]` | 识别名单（可信任人员）：`['QQ号:昵称', ...]` |
| `autoReply.agentProvider` / `agentModel` | 空 | 可选的 provider / model 覆盖；留空用宿主默认（如 sylvia 预设） |
| `autoReply.agentPreset` | `sylvia` | agent 加入的预设 id（决定人设/工具/分组；必须指定存在的预设，否则装配报错） |
| `autoReply.agentCwd` | `''` | agent 会话工作目录（cwd），应指向你的 DSH 工作空间；插件数据（`meta.json`/`files/`）统一存其下 `data/` 子目录 |
| `autoReply.agentTimeoutMs` | `180000` | 等待 agent 生成回复的超时（毫秒） |
| `autoReply.replyToGroup` | `false` | 是否应答群消息（默认关，避免打扰群聊） |
| `autoReply.groupWhitelist` | `[]` | 群聊白名单：仅列表中的群号自动应答（`replyToGroup: true` 时生效） |
| `autoReply.newCommand` | `/new` | 重置会话命令（精确匹配整条消息） |
| `autoReply.mergeWindowMs` | `3000` | 合并窗口（毫秒）：同一对象在此窗口内的多条消息合并处理 |

## 自动应答模式（每个聊天对象独立会话）

开启后，插件收到 QQ 消息会**事件驱动自动唤醒**并回复，无需 AI 手动拉取：

- **每聊天对象一个独立会话**：私聊按 QQ 号、群聊按群号各自维护上下文，互不干扰；
- **`/new` 重置会话**：向该对象发送配置的 `newCommand`（默认 `/new`），会清空与该对象的聊天历史并回复确认，相当于开一个新会话重新认识；
- **自动唤醒**：新消息到达即自动处理（唤醒 DSH agent → 回复），无需轮询；
- **不回复自己**：自己账号发的消息不会被触发。

**提示词**：每次回复的 system 消息由「聊天规则」+「人设」两块组成（`rulesPrompt` 与 `personaPrompt` 均留空时使用内置默认）。例如规则可写「你应当多次简短的回复而非一次复杂的回复」，人设留空即默认蝶清梦。

**会话持久化**：agent 会话由 DSH 自身的 session 机制落盘，`agentCwd/data` 存放 chatId→sessionId 映射（`meta.json`）与下载的附件（`files/`）；即使 dsh web 重启，按映射自动恢复会话，效果与单独的一个 dsh 会话一致；`/new` 会释放该 agent 并删除映射。

## DSH agent 机制模式

每个聊天对象都会**真正起一个独立的 DSH agent 会话**，延用宿主 agent 机制：

- 每个私聊对象 / 群 = 一个独立的 **DSH 会话**（sessionId 记录在 `<agentCwd>/data/meta.json`），拥有完整 agent 能力：预设人设、全部工具、多轮推理；
- 消息到达 → 插件通过 `ctx.agents` **创建（create）或恢复（resume）**该对象的 agent → `followup()` 注入消息并唤醒 → agent 推理产出回复 → 原路发回 QQ；
- 新 agent 会**挂载到 `agentPreset` 指定的预设**（默认 `sylvia`）——没有预设的 agent 工具/提示词为空层且装配报错，这是必须配置的原因；会话标题自动设为「用户名(QQ号)」/「群名(群号)」，在 DSH 界面按预设正常分组显示；
- 会话由 DSH 自身的 session 持久化机制落盘，**重启 dsh web 后按 `meta.json` 映射自动恢复**，和独立 dsh 会话效果一致；
- `agentProvider` / `agentModel` 留空时使用宿主默认模型与预设（例如 sylvia 预设即蝶清梦人设）；`/new` 会释放该 agent 并删除映射，下次消息重建全新会话。

> ⚠️ **安全提醒**：agent 模式下，QQ 上的聊天对象能触发完整 agent（含 bash 等工具）。请确认你的 QQ 好友/群可信，或配合宿主权限预设（preset）限制；不建议把此模式暴露给陌生人群聊。

```yaml
autoReply:
  enabled: true
  agentCwd: /path/to/workspace    # agent 会话工作目录（数据存其下 data/）
  agentProvider: ""               # 可选覆盖
  agentModel: ""                  # 可选覆盖
  replyToGroup: false
  newCommand: /new
```

配置示例（`cordis.patch.yml`）：

```yaml
- insert:
    - id: mira_qqbot
      name: mira_qqbot
      config:
        enabled: true
        wsUrl: ws://127.0.0.1:3001
        accessToken: ""
        autoReply:
          enabled: true
          agentPreset: sylvia                  # agent 加入的预设（决定人设/工具/分组）
          agentCwd: /path/to/workspace         # agent 会话工作目录，指向你的 DSH 工作空间
          personaPrompt: ""                    # 人设：留空使用预设自带人设
          rulesPrompt: "你应当多次简短的回复而非一次复杂的回复"  # 规则：留空使用内置默认规则
          replyToGroup: false
          newCommand: /new
```

> ⚠️ **模式关系**：`autoReply.enabled: true` 时，收到的消息会被自动应答消费（同时仍写入 `qq_recv_messages` 缓冲，AI 仍可拉取查看）；同一消息可能"机器人已回、AI 又回"，请按需只开一种主动回复路径。

## MCP 工具（模型可调用，前缀 `qq_`）

| 工具 | 说明 |
|---|---|
| `qq_status` | 连接状态、登录 QQ 号/昵称、待读消息数、最近错误 |
| `qq_get_login_info` | 当前登录账号信息 |
| `qq_get_friend_list` | 好友列表 |
| `qq_get_group_list` | 群列表 |
| `qq_get_group_member_list` | 群成员列表 |
| `qq_get_stranger_info` | 按 QQ 号查用户资料 |
| `qq_send_private_msg` | 发私聊 |
| `qq_send_group_msg` | 发群消息（支持 `[CQ:at,qq=...]`） |
| `qq_send_msg` | 统一发消息（纯 QQ 号=私聊，`group:群号`=群聊） |
| `qq_recv_messages` | 增量拉取收到的消息（私聊/群/频道），据此应答 |
| `qq_get_msg` | 按 message_id 查消息 |
| `qq_get_group_msg_history` | 群近期消息历史（NapCat 扩展） |
| `qq_delete_msg` | 撤回消息 |
| `qq_set_group_ban` | 群禁言 / 解禁 |
| `qq_set_group_kick` | 移出群聊 |
| `qq_set_group_whole_ban` | 全员禁言开关 |
| `qq_handle_friend_request` | 同意/拒绝好友申请 |
| `qq_handle_group_request` | 同意/拒绝加群申请 |
| `qq_api` | 通用 OneBot action 调用（逃生舱） |

## 常用操作示例

- **查看接管状态**：调用 `qq_status`；
- **应答新消息**：先 `qq_recv_messages`（`since` 传上次最大 seq）拉增量，再按来源用 `qq_send_private_msg` / `qq_send_group_msg` 回复；
- **管理群**：`qq_set_group_ban`（禁言/解禁）、`qq_set_group_kick`（移出）、`qq_set_group_whole_ban`（全员禁言）；
- **审批申请**：好友申请用 `qq_handle_friend_request`，加群申请用 `qq_handle_group_request`。

## 安全建议

1. **不要在代码或文档里硬编码 access_token / WebUI 令牌**：部署脚本默认自动生成随机 token，需要复用时通过环境变量 `WS_TOKEN` 传入；
2. 插件配置 `cordis.patch.yml` 属于本机私密配置（含 token），不要随仓库分发；
3. `ws://127.0.0.1:3001` 只监听回环地址，请勿把 NapCat 的 WebSocket 服务暴露到局域网/公网；
4. 发布/分发插件时，注意清理其中的本机路径、用户名、域名、IP 与令牌（可参照本 README 的写法）。

## 故障排查

| 现象 | 处理 |
|---|---|
| `qq_status` 返回 `connected: false` | 确认 QQ 已以 `--no-sandbox` 启动且 NapCat 已加载；检查 3001 端口是否监听（macOS/Linux：`lsof -iTCP:3001 -sTCP:LISTEN`，Windows：`netstat -ano | findstr :3001`）；核对 `wsUrl` / `accessToken` 与 NapCat 配置一致 |
| `qq_status` 一直 `lastError` 非空 | 查看 `/tmp/napcat-qq.log`（QQ/NapCat）与 `/tmp/dsh-web.log`（dsh web）定位错误 |
| 插件未出现在工具列表 | 确认 `cordis.patch.yml` 的 `insert` 条目 id 为 `mira_qqbot` 且 `enabled: true`，然后重启 dsh web |
| NapCat 打补丁报 `Operation not permitted` | 见上文「App 管理」权限说明 |
| 收到消息乱码或 CQ 码 | 插件会自动清洗 CQ 码（图片→`[图片]`、@→`@qq号` 等）；`messagePostFormat` 建议保持 `array` |

## 许可证

MIT
