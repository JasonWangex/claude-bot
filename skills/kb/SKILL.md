---
name: kb
description: >
  Knowledge base management. No arguments lists entries for current project;
  with arguments records new lessons/insights. Supports Markdown format for
  architecture decisions, troubleshooting, API design notes, etc.
---

# KB - Knowledge Base

## Mode selection

Based on `$ARGUMENTS`:

- **Empty** → List mode
- **Non-empty** → Record mode

---

## List mode (no arguments)

### 1. Query knowledge base entries for current project

```
bot_kb(action="list", project="<project name>")
```

### 2. Display list

Group by category:

```
Knowledge Base (project: <Project>)

Architecture
  1. <Title> — <first 50 chars of content>

Troubleshooting
  2. <Title> — <first 50 chars of content>

(Uncategorized)
  3. <Title> — <first 50 chars of content>

Total: N entries. Enter a number to view details, or use /kb <description> to record a new entry.
```

If no entries exist, show: `No knowledge base entries for this project. Use /kb <description> to record one.`

### 3. After user selects

Call `bot_kb(action="get", kb_id="<id>")` to fetch and display full content.

---

## Record mode (with arguments)

`$ARGUMENTS` serves as the initial description. Quickly confirm with user:

### 1. Collect information

Confirm with user:
- **Title**: Extract from arguments or ask user to refine (<=20 chars)
- **Category**: Suggest one — Architecture / Troubleshooting / API / Design / Convention / Other
- **Content**: Ask user for details (Markdown format), or auto-organize from conversation context
- **Tags**: Extract relevant technical keywords (e.g. SQLite, migration, Discord.js)
- **Source**: Auto-fill if an associated Goal or task can be identified

If the arguments are already detailed enough (more than one sentence), organize into structured content directly without asking.

### 2. Write to SQLite

```
bot_kb(action="create",
  title="<title>",
  content="<Markdown content>",
  project="<project name>",
  category="<category>",
  tags=["tag1", "tag2"],
  source="<source>"
)
```

### 3. Confirm

```
Recorded: <title>
Category: <category> | Tags: tag1, tag2
```

---

## Project name detection

Determine project from current working directory:
- Path contains `claude-bot` → `claude-bot`
- Path contains `LearnFlashy` → `LearnFlashy`
- Otherwise → use directory name

---

## Important notes

- All operations use MCP tool `bot_kb` (actions: list/get/create/update/delete)
- If MCP tools are unavailable, prompt user to check if Bot and MCP Server are running
