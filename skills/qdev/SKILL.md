---
name: qdev
description: >
  Quick Dev - 快速创建开发分支和任务。通过 tg API fork 当前 topic 的 root topic，
  然后发送任务描述。例如: /qdev 修复统计负数 → fork root topic + 发送消息
version: 2.0.0
---

# Quick Dev - 快速开发任务初始化

通过 Telegram Bot 的本地 API 自动 fork 当前 topic 的 root topic 并发送任务。

**前置条件**: Telegram Bot 必须正在运行且 API 可用 (`http://127.0.0.1:3456`)。

## 流程

### 1. 生成分支名

根据用户描述生成分支名（格式: `<type>/<kebab-case>`）：

- **type**: `feat`(新功能), `fix`(修复), `refactor`(重构), `perf`(性能), `docs`(文档), `test`(测试), `chore`(工程化)
- **kebab-case**: 小写字母+连字符，2-4 个单词

示例:
| 输入 | 分支名 |
|------|--------|
| 修复统计负数 | `fix/stats-negative-value` |
| 添加日志功能 | `feat/logging-system` |
| 优化查询性能 | `perf/query-optimization` |

### 2. 通过 API 查找 root topic

```bash
API="http://127.0.0.1:3456"

# 获取所有 topic
curl -s $API/api/topics
```

从返回的 topic 列表中：
1. 用当前工作目录 (`pwd`) 匹配 topic 的 `cwd` 字段，找到**当前 topic**
2. 如果当前 topic 有 `parent_topic_id`，沿着 parent 链向上查找，直到找到没有 `parent_topic_id` 的 topic — 这就是 **root topic**
3. 如果当前 topic 没有 `parent_topic_id`，它自己就是 root topic

### 3. Fork root topic

```bash
curl -s -X POST $API/api/topics/<ROOT_TOPIC_ID>/fork \
  -H 'Content-Type: application/json' \
  -d '{"branch": "<生成的分支名>"}'
```

从响应中获取 `data.topic_id` 作为新 fork 的 topic ID。

### 4. 发送任务描述

```bash
curl -s -X POST $API/api/topics/<FORK_TOPIC_ID>/message \
  -H 'Content-Type: application/json' \
  -d '{"text": "<用户的原始描述>"}'
```

### 5. 输出确认

```
✅ 开发任务已初始化

📋 **任务信息**
- Root Topic: <root topic name>
- Fork Topic: <fork topic name>
- 分支: `<branch>`
- 任务: <用户描述>

🚀 已在 fork topic 中发送任务，Claude 正在处理！
```

## 重要提示

- **不要询问用户确认**: 直接根据描述生成并执行
- **所有操作通过 curl 调用 API**: 不直接执行 git 命令
- **如果 API 不可用**: 提示用户检查 Bot 是否运行
- **如果找不到匹配的 topic**: 提示用户当前目录不在任何 topic 的工作目录中
- **如果用户没有提供描述**: 提示 `用法: /qdev <任务描述>`

---

**现在请立即执行上述流程。用户提供的描述：{{SKILL_ARGS}}**
