---
name: devlog
description: >
  记录开发日志到 SQLite 数据库（通过 MCP 工具）。可独立调用，也可被 /merge 等 skill 调用。
  自动收集 git 信息，生成功能摘要，写入数据库。用 git tag 追踪进度，避免重复记录。
version: 4.0.0
---

# Dev Log - 开发日志记录

将开发成果记录到本地 SQLite 数据库（通过 MCP 工具）。

## 信息收集

根据调用场景，收集以下信息：

### 场景 A：从 /merge 调用（已有信息）

如果上下文中已有 `DEVLOG_` 开头的信息（来自 merge 脚本输出），直接使用：
- `DEVLOG_COMMIT_COUNT` → commit 数量
- `DEVLOG_COMMIT_MESSAGES` → commit 消息列表
- `DEVLOG_DIFF_STAT` → diff 统计

此场景下跳过书签检查（merge 已经明确了范围）。写入成功后仍需更新书签。

### 场景 B：独立调用

用 `devlog/last` tag 作为书签，只收集上次记录之后的新 commit。

```bash
BRANCH=$(git rev-parse --abbrev-ref HEAD)

# 确定起点：有书签用书签，没有则取最近 20 条
if git rev-parse devlog/last >/dev/null 2>&1; then
  BASE="devlog/last"
else
  echo "DEVLOG_NO_BOOKMARK=true"
  BASE="HEAD~20"  # 首次使用，回溯 20 条作为候选范围
fi

if [ "$BRANCH" != "main" ]; then
  BASE="main"
fi

COMMIT_COUNT=$(git log ${BASE}..HEAD --oneline | wc -l | tr -d ' ')
COMMIT_MESSAGES=$(git log ${BASE}..HEAD --pretty=format:"- %s")
DIFF_STAT=$(git diff --shortstat ${BASE}..HEAD)
```

**如果 COMMIT_COUNT 为 0**：告知用户"没有新的提交需要记录"，不执行写入。

**如果 DEVLOG_NO_BOOKMARK=true**（首次使用）：向用户展示收集到的 commit 列表，确认范围是否正确后再写入。

### 额外信息收集

```bash
git diff --stat ${BASE}..HEAD
git diff --name-status ${BASE}..HEAD
git log ${BASE}..HEAD --pretty=format:"%h %s (%ai)"
```

### 项目名判断

根据当前工作目录判断项目：
- 路径包含 `claude-bot` → `claude-bot`
- 路径包含 `LearnFlashy` → `LearnFlashy`
- 其他 → 用目录名作为项目名

### Goal 关联

如果当前上下文中能明确判断关联的 Goal（例如分支名包含 goal 关键词），填写 Goal 名称；否则留空。

如果需要查询 Active Goals：

```
bot_list_goals(status="Active")
```

## 写入 SQLite

通过 MCP 工具写入 DevLog：

```
bot_create_devlog(
  name="<功能标题（中文，10字以内）>",
  date="<今天日期 yyyy-MM-dd>",
  project="<项目名>",
  branch="<分支名>",
  summary="<用一两句自然语言概括做了什么>",
  commits=<commit数量>,
  lines_changed="<diff stat 原文>",
  goal="<关联的 Active Goal 名称，可选>",
  content="<Markdown 格式的详细内容>"
)
```

### Content 格式

用 Markdown 生成详细内容，结构如下：

```markdown
## 背景与动机
（2-3 句话说明为什么做这次变更，体现工程思维。）

## 主要变更
- **变更点 1 标题**：具体说明
- **变更点 2 标题**：具体说明

## Commits
<hash> <message> (<date>)

## 文件变更
| 文件 | 变更 | 说明 |
|------|------|------|
| path/to/file | +20 -5 | 简要说明变更内容 |
```

**Content 生成要求：**
1. 语言使用中文
2. "背景与动机"要解释"为什么改"而非"改了什么"
3. "主要变更"应归纳整理，合并相关 commit
4. "文件变更"表格的"说明"列应简要说明变更目的

## 更新书签

**写入成功后**，更新 git tag 书签：

```bash
git tag -f devlog/last HEAD
```

写入成功后，输出确认信息。
