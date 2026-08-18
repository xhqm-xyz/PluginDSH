# mira_live2d · DSH 看板娘插件

把 xhqm-live2d（WordPress 插件）移植为 DSH 原生插件：看板娘作为对话界面浮层出现，模型可通过 MCP 工具说话、切表情、切模型、切动作，并随「思考 / 等待确认 / 空闲」自动切换表情。

## 安装（任意 DSH web profile）

本插件是无依赖的纯 ESM 包：主机端仅用 Node 内置模块，浏览器端运行库已捆绑在 `assets/lib/`。

### 1. 让包可被 profile 解析

任选其一：

```sh
# A. 克隆仓库后链接 / 拷贝到 profile 的 node_modules
git clone https://github.com/xhqm-xyz/PluginDSH.git
# Windows（junction）：mklink /J %USERPROFILE%\.dsh\profiles\node_modules\mira_live2d <克隆路径>\mira_live2d
# Linux/macOS：ln -s <克隆路径>/mira_live2d ~/.dsh/profiles/node_modules/mira_live2d
# 或直接把 mira_live2d 目录拷贝到 ~/.dsh/profiles/node_modules/

# B. 用 dsh 的插件命令安装
dsh plugin --profile web add <mira_live2d 目录路径>
```

### 2. 在 profile 里登记

在 `~/.dsh/profiles/web/cordis.patch.yml` 的 `insert` 列表追加：

```yaml
- id: mira_live2d
  name: 'mira_live2d'
  config:
    model: StellaMira          # 初始模型（model 目录名）
    position: right
    tts:
      enabled: false
      provider: openai         # 或 alibaba；base 可覆盖为任意 OpenAI 兼容端点
      keyEnv: 'OPENAI_API_KEY' # 建议用环境变量；或用 key 填字面量（仅本机私有配置）
```

> 密钥请走 `tts.keyEnv`（环境变量名）或 `tts.key`（仅本机私有配置文件），**切勿提交到仓库**。

### 3. 重启

```sh
dsh web
```

刷新页面后看板娘出现在对话界面右下角。

## 模型

模型放 `model/` 目录，每个模型一个子目录，目录内必须含 `*.model3.json`（见 `model/README.md`）。`mira_list_models` 自动扫描。

## 前端交互

- **拖拽移动**：鼠标 / 单指拖动（位置记忆到 localStorage）
- **缩放**：滚轮（桌面）/ 双指捏合（移动端），0.25× ~ 3×（缩放记忆）；移动端默认按 `mobileScale` 缩放
- **菜单**：右键（桌面）/ 长按（移动端）呼出表情 / 动作菜单
- **表情叠加**：菜单里的表情项是叠加开关，点击开/关（活跃项标 `✓`）；「默认表情」清空全部表情与叠加
- **气泡**：`mira_speak` / `mira_bubble` / 思考等待提示在此显示

## MCP 工具（模型可调用，前缀 `mira_`）

| 工具 | 说明 |
|---|---|
| `mira_get_state` | 在线与否、显隐、当前模型/表情/动作/语句、表情/动作列表、开关、思考等待配置、可切换模型 |
| `mira_list_models` | 列出 model 文件夹所有模型 |
| `mira_get_model_capabilities` | 解析 model3.json 返回表情/动作清单 |
| `mira_switch_model` | 切换展出模型 |
| `mira_set_expression` | 切换/叠加表情（空串恢复默认；`stack=true` 叠加并存） |
| `mira_play_motion` | 播放动作组 |
| `mira_speak` | TTS 合成语音 + 气泡（让模型说话） |
| `mira_bubble` | 只显示气泡不朗读 |
| `mira_show` / `mira_hide` | 显示 / 隐藏 |
| `mira_set_expressions_enabled` | 开/关表情系统 |
| `mira_set_animations_enabled` | 开/关动作播放 |
| `mira_set_mood` | 手动设置 thinking / awaiting / idle |
| `mira_set_persona` | 设置思考/等待表情、气泡与空闲清除延迟 |
| `mira_get_config` | 读取当前配置（TTS key 不回传明文） |

## 表情：互斥与叠加

- 默认 `mira_set_expression(name)` 为**互斥替换**：新表情会淡出上一个表情。
- `mira_set_expression(name, stack=true)` 为**叠加开关**：把该表情加入叠加栈，可与当前互斥表情、其它叠加表情并存（依赖 exp3.json 的 `Blend:Add` 加算）。
- 右键 / 长按菜单里的表情项一律是叠加开关（`✓` 表示已开启），点一次开、再点一次关。
- `mira_set_expression("")`（空串）恢复默认：清空互斥表情 + 全部叠加表情。

## 配置项

全部可选，默认值见 `lib/index.js` 的 `DEFAULTS`：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `model` | `''` | 初始模型（model 目录名） |
| `modelsDir` | 插件 `model/` | 模型目录覆盖 |
| `canvas.w/h` | `480/630` | 画布内部分辨率 |
| `position` | `right` | 初始 `left` / `right` |
| `mobileScale` | `55` | 移动端缩放百分比 |
| `showHint` | `true` | 首次显示操作提示 |
| `pollIntervalMs` | `1500` | 指令轮询间隔 |
| `persona.thinking.{expression,bubble}` | `''` | 思考时表情/气泡（默认空） |
| `persona.awaiting.{expression,bubble}` | `''` | 等待确认时表情/气泡（默认空） |
| `persona.idleClearMs` | `3200` | 空闲后清除表情的延迟 |
| `tts.enabled` | `false` | TTS 开关 |
| `tts.provider` | `openai` | `openai` / `alibaba` |
| `tts.base` | provider 默认 | 接口基地址 |
| `tts.key` | `''` | API Key（字面量） |
| `tts.keyEnv` | `''` | 存 API Key 的环境变量名 |
| `tts.model` / `tts.voice` | provider 默认 | 模型 / 音色 |

## 思考 / 等待表情如何触发

- 模型开始生成（agent 进入 `running`）→ `mood: thinking`
- 模型调用 `ask_user_question` 后 → `mood: awaiting`
- 模型结束本轮（agent 回到 `idle`）→ `mood: idle`，`idleClearMs` 后恢复默认表情
- 也可用 `mira_set_mood` 手动设置

## 第三方组件

`assets/lib/` 捆绑了 PixiJS（MIT）、pixi-live2d-display（MIT）与 Live2D Cubism Core（专有，Live2D Software License Agreement）。各组件的版权与许可证全文见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
