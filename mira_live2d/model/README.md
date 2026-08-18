# 看板娘模型目录

把 Live2D 模型原样放到本目录，每个模型一个子目录，目录内必须包含一个 `*.model3.json`。

```
model/
└── StellaMira/                  ← 模型名 = 目录名
    ├── StellaMira.model3.json   ← 入口（必须）
    ├── StellaMira.moc3
    ├── StellaMira.2048/texture_00.png
    ├── 动作-待机.motion3.json
    ├── 表情-惊喜.exp3.json
    └── …（整个模型文件夹原样放入）
```

- 本插件内置 Cubism 5（cubism4）运行时，仅支持 Cubism 4/5 模型，Cubism 2/3 老模型不支持。
- `mira_list_models` 工具会扫描本目录，自动发现所有含 `.model3.json` 的子目录。
- 切换模型用 `mira_switch_model(model="目录名")`，或前端右键菜单（切表情/动作）。
- 模型文件经 `/live2d/models/` 由主机端代理输出，不会暴露为独立静态目录。

> 注：当前工作区未附带模型文件（原模型在 NAS `/volume1/web/live2d-models/` 上）。请把模型目录复制到这里后，在
> `C:\Users\xhqm\.dsh\profiles\web\cordis.patch.yml` 的 `mira_live2d` 配置里把 `model` 改成目录名（例如 `StellaMira`）。
