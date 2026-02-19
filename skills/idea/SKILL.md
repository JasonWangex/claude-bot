---
name: idea
description: >
  快速记录想法或推进已有想法到开发。有参数时直接记录到 SQLite（Status=Idea）；
  无参数时列出当前项目的未开发 Ideas，选中后标记 Processing 并走 qdev 流程。
---

# Idea - 想法管理

## 模式判断

根据 `$ARGUMENTS` 决定模式：

- **不为空** → 记录模式（写入新 Idea）
- **为空** → 列表模式（查看并推进已有 Idea）

---

## 记录模式（有参数）

将一句话想法直接写入 SQLite，Status 设为 Idea。

**不讨论、不确认、不追问**，直接调用 MCP 工具：

```
bot_create_idea(name="$ARGUMENTS", project="<项目名>")
```

写入成功后，简短确认：`已记录: <想法标题>`

---

## 列表模式（无参数）

### 1. 查询未开发的 Ideas

```
bot_list_ideas(project="<项目名>", status="Idea")
```

只显示当前项目的 Ideas（根据 cwd 判断 Project）。

### 2. 展示列表

```
未开发的 Ideas (项目: <Project>)

1. <Idea Name>
2. <Idea Name>
...

输入编号选择要开发的 Idea，或 0 退出
```

如果没有任何 Idea，提示：`当前项目没有未开发的 Idea。用 /idea <描述> 记录一个新想法。`

### 3. 用户选择后推进

#### 3.1 更新 Idea 状态

```
bot_update_idea(idea_id="<id>", status="Processing")
```

#### 3.2 执行 qdev 流程

**查找当前 task：**

```
bot_list_tasks()
```

从返回的 task 列表中：
1. 用当前工作目录 (`pwd`) 匹配 task 的 `cwd` 字段
2. 沿 parent 链向上查找 root task（没有 `parent_thread_id` 的 task）

**快速创建开发子任务：**

```
bot_qdev(task_id="<ROOT_TASK_ID>", description="<Idea Name>")
```

#### 3.3 输出确认

```
Idea 已推进到开发

- Idea: <Idea Name>
- 状态: Processing

已创建开发任务，Claude 正在处理！
```

## 项目名判断

根据当前工作目录判断项目：
- 路径包含 `claude-bot` → `claude-bot`
- 路径包含 `LearnFlashy` → `LearnFlashy`
- 其他 → 用目录名作为项目名

## 重要提示

- **记录模式**: 不讨论、不确认，直接写入
- **列表模式**: 列出后等待用户选择，选择后不再确认，直接推进
- **所有操作通过 MCP 工具完成**（bot_create_idea, bot_list_ideas, bot_update_idea, bot_list_tasks, bot_qdev）
- **如果 MCP 工具不可用**: 提示用户检查 Bot 和 MCP Server 是否运行

