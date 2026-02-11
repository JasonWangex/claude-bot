---
name: idea
description: >
  快速记录想法到 Notion Goals database（Status=Idea）。
  极简：一句话输入，直接写入，不讨论不确认。
version: 1.0.0
---

# Idea - 快速记录想法

将一句话想法直接写入 Notion Goals database，Status 设为 Idea。

## 前置检查

如果 `{{SKILL_ARGS}}` 为空，提示用法后结束：

```
用法: /idea <一句话描述>
示例: /idea 给 Bot 加语音消息支持
```

## 写入 Notion

**不讨论、不确认、不追问**，直接调用 `mcp__claude_ai_Notion__notion-create-pages` 写入：

- **data_source_id**: `d8cfb7d5-bf11-4ce3-bed4-37fabdec77e0`
- **Name**: 用户的原始输入（`{{SKILL_ARGS}}`）
- **Status**: `Idea`
- **Project**: 根据当前工作目录判断（`claude-bot` / `LearnFlashy` / 目录名）
- **date:Date:start**: 今天的日期（ISO-8601）
- **date:Date:is_datetime**: 0

示例：
```json
{
  "parent": {"data_source_id": "d8cfb7d5-bf11-4ce3-bed4-37fabdec77e0"},
  "pages": [{
    "properties": {
      "Name": "给 Bot 加语音消息支持",
      "Status": "Idea",
      "Project": "claude-bot",
      "date:Date:start": "2026-02-11",
      "date:Date:is_datetime": 0
    }
  }]
}
```

## 输出

写入成功后，简短确认：

```
💡 已记录: <想法标题>
```

---

**现在请立即执行。用户输入：{{SKILL_ARGS}}**
