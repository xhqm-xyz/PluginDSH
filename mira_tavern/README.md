# mira_tavern · DSH 酒馆插件

悬浮面板式**剧本演绎（剧情）框架**：把「酒馆」装进 DSH 对话界面，加载通用剧本 JSON，逐幕演绎，支持 OpenAI 兼容 TTS 配音；模型可通过 `tavern_*` 工具以「导演」身份驱动演绎。自由对话（分支 / 玩家行动）为后续扩展，当前版本只做线性剧情演绎。

## 特性

- 悬浮面板（标题栏拖拽 / 收起 / 关闭留小标签），默认右上
- 通用剧本 JSON 加载（`*.script.json`），自动扫描
- 逐幕演绎：场景（stage）+ 旁白 + 台词（角色着色 + 动作神态）
- OpenAI 兼容 TTS 配音，按角色 / 旁白指定音色
- 模型可调用工具 `tavern_*`（导演模式）
- 零第三方运行时依赖，纯 Node 内置模块，装到任意 DSH web profile 即可用

## 安装（任意 DSH web profile）

本插件是无依赖的纯 ESM 包，不绑定任何本机路径或密钥。

### 1. 让包可被 profile 解析

任选其一：

```sh
# A. 克隆仓库后链接 / 拷贝到 profile 的 node_modules
git clone https://github.com/xhqm-xyz/PluginDSH.git
# Windows 本地开发（junction）：
#   mklink /J %USERPROFILE%\.dsh\profiles\node_modules\mira_tavern <克隆路径>\mira_tavern
# Linux/macOS：
#   ln -s <克隆路径>/mira_tavern ~/.dsh/profiles/node_modules/mira_tavern
# 或直接把 mira_tavern 目录拷贝到 ~/.dsh/profiles/node_modules/

# B. 用 dsh 的插件命令安装（pnpm 装入 profile）
dsh plugin --profile web add <mira_tavern 目录路径>
```

### 2. 在 profile 里登记

在 `~/.dsh/profiles/web/cordis.patch.yml` 的 `insert` 列表追加：

```yaml
- id: mira_tavern
  name: 'mira_tavern'
  config:
    title: 酒馆
    position: right
    tts:
      enabled: true
      provider: openai        # 或 alibaba；base 可覆盖为任意 OpenAI 兼容端点
      base: 'https://api.openai.com/v1'
      keyEnv: 'OPENAI_API_KEY' # 建议用环境变量；或用 key 填字面量（仅本机私有配置）
      model: 'tts-1'
      voice: 'alloy'
```

> 密钥请走 `tts.keyEnv`（环境变量名）或 `tts.key`（仅本机私有配置文件），**切勿提交到仓库**。

### 3. 重启

```sh
dsh web
```

刷新页面后右上出现「酒馆」。

## 界面

- 悬浮面板（默认右上），**标题栏拖拽**移动（位置记忆到 localStorage）
- 右上 `—` 收起 / `×` 关闭；关闭后出现「🍺 酒馆」小标签，点击重新打开
- 未加载剧本时显示剧本选择列表；加载后进入幕视图：幕标题 + 场景（stage）+ 旁白 + 台词（说话人按角色着色 + 动作神态）
- 底部控制：⏮ 上一幕 / 🔊 朗读本幕 / ⏭ 下一幕 / 幕目录下拉跳转
- 旁白与每条台词右侧有 🔊，可单独朗读

## 剧本格式

见 [scripts/README.md](scripts/README.md)，样例 [scripts/_example.script.json](scripts/_example.script.json)。

## MCP 工具（模型可调用，前缀 `tavern_`）

| 工具 | 说明 |
|---|---|
| `tavern_list_scripts` | 列出 scripts 目录所有剧本 |
| `tavern_load_script` | 加载剧本，返回元信息 + 角色卡 + 幕 id 列表 |
| `tavern_get_scene` | 读取一幕全文（stage/narration/lines） |
| `tavern_show_scene` | 推送到前端显示，并可朗读旁白 |
| `tavern_speak` | 用指定音色朗读一句台词 |
| `tavern_next` / `tavern_prev` | 前进 / 回退一幕 |
| `tavern_get_state` | 在线与否、当前剧本/幕、TTS 就绪、可用剧本 |
| `tavern_show` / `tavern_hide` | 显示 / 隐藏面板 |
| `tavern_get_config` | 读取当前配置（TTS key 不回传明文） |

## 配置项

全部可选，默认值见 `lib/index.js` 的 `DEFAULTS`：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `title` | `酒馆` | 面板标题 |
| `scriptsDir` | 插件 `scripts/` | 剧本目录覆盖（绝对路径） |
| `panel.w/h` | `380/560` | 面板尺寸 |
| `position` | `right` | 初始 `left` / `right` |
| `pollIntervalMs` | `1200` | 指令轮询间隔 |
| `tts.enabled` | `false` | 前端自动朗读开关（模型调用以 key 是否配置为准） |
| `tts.provider` | `openai` | `openai` / `alibaba`（`base` 可覆盖为任意 OpenAI 兼容端点） |
| `tts.base` | provider 默认 | `/v1` 之前的基地址 |
| `tts.key` | `''` | API Key（字面量） |
| `tts.keyEnv` | `''` | 存 API Key 的环境变量名 |
| `tts.model` / `tts.voice` | provider 默认 | 全局默认模型 / 音色 |

音色优先级：**台词角色 `voice` > 旁白 `narrator.voice` > 插件 `tts.voice` > 服务商默认**。

TTS 走 OpenAI 兼容的 `POST {base}/audio/speech`（`response_format: mp3`），因此可复用 llama-server 暴露的兼容端点或任意服务商，只要端点实现该接口。
