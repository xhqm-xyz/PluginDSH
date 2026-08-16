# mira-live2d · DSH 看板娘插件

把 xhqm-live2d（WordPress 插件）移植为 DSH 原生插件：看板娘作为对话界面浮层出现，模型可通过 MCP 工具说话、切表情、切模型、切动作，并随「思考 / 等待确认 / 空闲」自动切换表情。

## 安装（已装好）

本插件以链接方式装入 `web` profile：

- 源码目录：`DeepSeek\WorkSpace\dsh-live2d`
- 链接：`C:\Users\xhqm\.dsh\profiles\node_modules\mira-live2d` → `DeepSeek\WorkSpace\dsh-live2d`（junction）
- 行配置：`C:\Users\xhqm\.dsh\profiles\web\cordis.patch.yml` 中的 `mira-live2d` 行

改动源码后重启 `dsh web` 生效。

## 模型

模型放 `model/` 目录，每个模型一个子目录，目录内必须含 `*.model3.json`（见 `model/README.md`）。`mira_list_models` 自动扫描。

## 前端交互

- 鼠标拖拽：移动位置（位置记忆到 localStorage）
- 滚轮：缩放大小（0.25× ~ 3×，缩放记忆）
- 右键：呼出表情 / 动作菜单
- 气泡：`mira_speak` / `mira_bubble` / 思考等待提示在此显示

## MCP 工具（模型可调用，前缀 `mira_`）

| 工具 | 说明 |
|---|---|
| `mira_get_state` | 在线与否、显隐、当前模型/表情/动作/语句、表情/动作列表、开关、思考等待配置、可切换模型 |
| `mira_list_models` | 列出 model 文件夹所有模型 |
| `mira_get_model_capabilities` | 解析 model3.json 返回表情/动作清单 |
| `mira_switch_model` | 切换展出模型 |
| `mira_set_expression` | 切换表情（空串恢复默认） |
| `mira_play_motion` | 播放动作组 |
| `mira_speak` | TTS 合成语音 + 气泡（让模型说话） |
| `mira_bubble` | 只显示气泡不朗读 |
| `mira_show` / `mira_hide` | 显示 / 隐藏 |
| `mira_set_expressions_enabled` | 开/关表情系统 |
| `mira_set_animations_enabled` | 开/关动作播放 |
| `mira_set_mood` | 手动设置 thinking / awaiting / idle |
| `mira_set_persona` | 设置思考/等待表情、气泡与空闲清除延迟 |
| `mira_get_config` | 读取当前配置（TTS key 不回传明文） |

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
