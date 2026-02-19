# MCP Tools 合并迁移指南

## 概述

MCP tools 从 **21 个**合并为 **8 个**，通过 `action` 字段区分 CRUD 操作。所有 REST API 端点不变，仅 MCP tool 名称和调用方式变更。

## 工具映射表

### bot_tasks（合并 bot_list_tasks + bot_get_task）

| 旧调用 | 新调用 |
|--------|--------|
| `bot_list_tasks()` | `bot_tasks()` |
| `bot_get_task(task_id="xxx")` | `bot_tasks(task_id="xxx")` |

### bot_send_message（不变）

调用方式完全不变。

### bot_qdev（不变）

调用方式完全不变。

### bot_goals（合并 bot_list_goals + bot_get_goal + bot_create_goal + bot_update_goal）

| 旧调用 | 新调用 |
|--------|--------|
| `bot_list_goals()` | `bot_goals(action="list")` |
| `bot_list_goals(status="Processing")` | `bot_goals(action="list", status="Processing")` |
| `bot_list_goals(q="关键词")` | `bot_goals(action="list", q="关键词")` |
| `bot_get_goal(goal_id="xxx")` | `bot_goals(action="get", goal_id="xxx")` |
| `bot_create_goal(name="...", project="...")` | `bot_goals(action="create", name="...", project="...")` |
| `bot_update_goal(goal_id="xxx", status="Planned")` | `bot_goals(action="update", goal_id="xxx", status="Planned")` |
| `bot_update_goal(goal_id="xxx", body="...", progress="...")` | `bot_goals(action="update", goal_id="xxx", body="...", progress="...")` |

### bot_devlogs（合并 bot_list_devlogs + bot_create_devlog）

| 旧调用 | 新调用 |
|--------|--------|
| `bot_list_devlogs(date="2026-02-19")` | `bot_devlogs(action="list", date="2026-02-19")` |
| `bot_list_devlogs(start="...", end="...")` | `bot_devlogs(action="list", start="...", end="...")` |
| `bot_create_devlog(name="...", date="...", project="...")` | `bot_devlogs(action="create", name="...", date="...", project="...")` |

### bot_ideas（合并 bot_list_ideas + bot_create_idea + bot_update_idea）

| 旧调用 | 新调用 |
|--------|--------|
| `bot_list_ideas(project="xxx", status="Idea")` | `bot_ideas(action="list", project="xxx", status="Idea")` |
| `bot_create_idea(name="...", project="...")` | `bot_ideas(action="create", name="...", project="...")` |
| `bot_update_idea(idea_id="xxx", status="Done")` | `bot_ideas(action="update", idea_id="xxx", status="Done")` |

### bot_kb（合并 bot_list_kb + bot_get_kb + bot_create_kb + bot_update_kb + bot_delete_kb）

| 旧调用 | 新调用 |
|--------|--------|
| `bot_list_kb(project="xxx")` | `bot_kb(action="list", project="xxx")` |
| `bot_get_kb(kb_id="xxx")` | `bot_kb(action="get", kb_id="xxx")` |
| `bot_create_kb(title="...", content="...", project="...")` | `bot_kb(action="create", title="...", content="...", project="...")` |
| `bot_update_kb(kb_id="xxx", title="...")` | `bot_kb(action="update", kb_id="xxx", title="...")` |
| `bot_delete_kb(kb_id="xxx")` | `bot_kb(action="delete", kb_id="xxx")` |

### bot_status（合并 bot_status + bot_list_models）

| 旧调用 | 新调用 |
|--------|--------|
| `bot_status()` | `bot_status()` — 返回值现在包含 `models` 字段 |
| `bot_list_models()` | `bot_status()` — 从返回值的 `models` 字段获取 |

## 已删除的工具

| 工具 | 原因 |
|------|------|
| `bot_fork_task` | `bot_qdev` 已覆盖其场景（自动分支命名 + worktree + channel） |
| `bot_list_models` | 合并到 `bot_status` 返回值中 |

## 迁移规则总结

1. **所有 `bot_list_xxx` / `bot_get_xxx`** → 对应的合并工具 + `action="list"` 或 `action="get"`
2. **所有 `bot_create_xxx`** → 对应的合并工具 + `action="create"`
3. **所有 `bot_update_xxx`** → 对应的合并工具 + `action="update"`
4. **`bot_delete_kb`** → `bot_kb(action="delete", ...)`
5. **其余参数原样传递**，无需修改
