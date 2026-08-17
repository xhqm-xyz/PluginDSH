# 酒馆 · 剧本目录

把剧本 JSON 文件放进本目录（任意子目录均可），文件名以 `.script.json` 结尾，插件会自动扫描并列出。

## 格式（schema `tavern.script/1`）

```json
{
  "schema": "tavern.script/1",
  "id": "唯一 id（英文短横线）",
  "title": "剧本标题",
  "subtitle": "副标题（可选）",
  "description": "简介（可选）",
  "narrator": { "name": "旁白", "voice": "" },
  "characters": [
    {
      "id": "角色 id（台词 speaker 引用它）",
      "name": "显示名",
      "color": "#e0a458",
      "voice": "该角色 TTS 音色（可选，覆盖全局默认）",
      "avatar": "头像相对路径（可选，如 characters/a.png）",
      "description": "角色简介（可选）"
    }
  ],
  "scenes": [
    {
      "id": "s1",
      "title": "幕标题",
      "stage": "场景 / 氛围描述（可选）",
      "narration": "旁白文字（可选）",
      "lines": [
        { "speaker": "keeper", "text": "台词", "action": "动作 / 神态（可选）" }
      ]
    }
  ]
}
```

## 约定

- `scenes` 为线性有序数组，前端按顺序逐幕演绎。
- `lines[].speaker`：填 `characters[].id`；填 `"narrator"` 表示旁白；填其它字符串则原样当作「说话人名」显示（默认色）。
- `voice` 留空时回退到插件配置的 `tts.voice`（再回退到服务商默认）。
- `avatar` / 封面等相对路径以**该剧本文件所在目录**为基准解析，并经 `/tavern/data/` 提供；也支持 `http(s)://` 绝对地址。
- 自由对话（分支 / 玩家行动）为后续扩展，当前版本只做线性演绎。
