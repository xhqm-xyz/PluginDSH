# PluginDSH

DSH（DeepSeek Harness）客户端插件集。每个插件都是零第三方运行时依赖的纯 ESM 包，以链接方式装入 DSH `web` profile 即可使用。

## 插件清单

| 目录 | 说明 |
|---|---|
| [mira_live2d](mira_live2d/) | Live2D 看板娘插件：会话界面浮层（拖拽 / 滚轮与双指缩放 / 右键与长按表情菜单 + 表情叠加）+ TTS 说话 + `mira_` MCP 工具集 |
| [mira_tavern](mira_tavern/) | 酒馆插件：悬浮面板式剧本演绎（剧情）框架 + 通用剧本 JSON 加载 + OpenAI 兼容 TTS 配音 + `tavern_` MCP 工具集 |
| [mira_qqbot](mira_qqbot/) | QQ 接管插件：OneBot v11 连接本机 NapCat，把个人 QQ 交给 DSH agent（收发消息 / 好友 / 群 / 频道，`qq_` 工具集 + 自动应答） |

## 安装与配置

各插件目录内的 `README.md` 含完整说明：安装（链接进 profile + 在 `cordis.patch.yml` 登记）、配置项、MCP 工具清单。

## 资产边界

- `mira_live2d/model/`：Live2D 模型（`.moc3` / 贴图 / `.exp3.json` / `.motion3.json`）为私有资产，不入 git 库（`.gitignore` 排除），请自行获取放入对应目录。
- `mira_tavern/scripts/`：剧本 `*.script.json` 随库分发（`_example` 为样例），私有剧本自行放置或忽略。
- `mira_qqbot`：连接凭据（`accessToken`）只写本机 `cordis.patch.yml`，切勿提交到仓库。
