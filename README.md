# PluginDSH

DSH（DeepSeek Harness）客户端插件集。

## 插件清单

| 目录 | 说明 |
|---|---|
| [mira-live2d](mira-live2d/) | Live2D 看板娘插件：会话界面浮层（拖拽/缩放/右键菜单）+ TTS 说话 + MCP 工具集 |

## 资产边界

各插件目录下的 `model/` 为模型数据存放位，**模型数据属于私有资产，不入库**。各插件通过自身 `.gitignore` 强制执行该边界（仅保留 `model/README.md` 说明文档）。模型文件请另行获取并放入对应目录。
