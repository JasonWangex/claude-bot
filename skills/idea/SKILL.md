---
name: idea
description: >
  快速记录想法或推进已有想法到开发。有参数时直接记录到本地数据库（Status=Idea）；
  无参数时列出当前项目的未开发 Ideas，选中后标记 Processing 并走 qdev 流程。
version: 4.0.0
---

# Idea - 想法管理

## API 初始化

所有操作通过 Bot HTTP API 完成：

```bash
API="http://127.0.0.1:3456"
BOT_TOKEN=$(grep '^BOT_ACCESS_TOKEN=' /home/jason/projects/claude-bot/.env 2>/dev/null | cut -d= -f2-)
AUTH="Authorization: Bearer $BOT_TOKEN"
```

## 模式判断

根据 `{{SKILL_ARGS}}` 决定模式：

- **不为空** → 记录模式（写入新 Idea）
- **为空** → 列表模式（查看并推进已有 Idea）

---

## 记录模式（有参数）

将一句话想法直接写入本地数据库，Status 设为 Idea。

**不讨论、不确认、不追问**，直接调用 HTTP API 写入：

```bash
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{
    "name": "<用户的原始输入>",
    "project": "<项目名>",
    "status": "Idea",
    "date": "<今天日期 yyyy-MM-dd>"
  }' $API/api/ideas
```

写入成功后，简短确认：

```
已记录: <想法标题>
```

---

## 列表模式（无参数）

### 1. 查询未开发的 Ideas

```bash
curl -s -H "$AUTH" "$API/api/ideas?project=<项目名>&status=Idea"
```

### 2. 展示列表

从响应的 `data` 数组中提取列表：

```
未开发的 Ideas (项目: <Project>)

1. <Idea Name>
2. <Idea Name>
3. <Idea Name>
...

输入编号选择要开发的 Idea，或 0 退出
```

如果没有任何 Idea，提示：

```
当前项目没有未开发的 Idea。用 /idea <描述> 记录一个新想法。
```

### 3. 用户选择后推进

用户输入编号后：

#### 3.1 更新 Idea 状态

```bash
curl -s -X PATCH -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"status": "Processing"}' $API/api/ideas/<IDEA_ID>
```

#### 3.2 执行 qdev 流程

用选中 Idea 的 Name 作为任务描述，执行以下步骤：

**生成分支名：**

根据任务描述生成分支名（格式: `<type>/<kebab-case>`）：

- **type**: `feat`(新功能), `fix`(修复), `refactor`(重构), `perf`(性能), `docs`(文档), `test`(测试), `chore`(工程化)
- **kebab-case**: 小写字母+连字符，2-4 个单词

**查找 root task：**

```bash
curl -s -H "$AUTH" $API/api/tasks
```

从返回的 task 列表中：
1. 用当前工作目录 (`pwd`) 匹配 task 的 `cwd` 字段，找到**当前 task**
2. 如果当前 task 有 `parent_thread_id`，沿着 parent 链向上查找，直到找到没有 `parent_thread_id` 的 task — 这就是 **root task**
3. 如果当前 task 没有 `parent_thread_id`，它自己就是 root task

**Fork root task：**

```bash
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"branch": "<生成的分支名>"}' $API/api/tasks/<ROOT_TASK_ID>/fork
```

从响应中获取 `data.thread_id` 作为新 fork 的 task ID。

**发送任务描述：**

```bash
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"text": "<Idea 的 Name>"}' $API/api/tasks/<FORK_TASK_ID>/message
```

#### 3.3 输出确认

```
Idea 已推进到开发

任务信息
- Idea: <Idea Name>
- Root Task: <root task name>
- Fork Task: <fork task name>
- 分支: `<branch>`
- 状态: Processing

已在 fork task 中发送任务，Claude 正在处理！
```

## 重要提示

- **记录模式**: 不讨论、不确认，直接写入
- **列表模式**: 列出后等待用户选择，选择后不再确认，直接推进
- **所有操作通过 curl 调用 HTTP API**: 不使用 Notion MCP 工具，不直接执行 git 命令
- **如果 API 不可用**: 提示用户检查 Bot 是否运行
- **如果找不到匹配的 task**: 提示用户当前目录不在任何 task 的工作目录中

## 项目名判断

根据当前工作目录判断项目：
- 路径包含 `claude-bot` → `claude-bot`
- 路径包含 `LearnFlashy` → `LearnFlashy`
- 其他 → 用目录名作为项目名

---

**现在请立即执行。用户输入：{{SKILL_ARGS}}**
