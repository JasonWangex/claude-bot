# Skills 代码化重构计划

## 设计决策

| 决策 | 选择 |
|------|------|
| MCP Server 进程模型 | 常驻服务 + SSE transport |
| MCP ↔ Bot 交互 | HTTP 调 Bot API (127.0.0.1:3456) |
| Discord /qdev slash command | 保留（只删 SKILL.md） |
| Bot 端改造范围 | 只改 CLI 端（Bot 端暂不动） |

## 架构总览

```
Claude Code CLI ──(SSE)──→ MCP Server (常驻, :3457) ──(HTTP)──→ Bot API (:3456)
                                                                      │
Discord 用户 ──→ Slash Commands ──→ Bot 直接处理 / 读 SKILL.md       │
                                                                      ▼
                                                                   SQLite DB
```

## 阶段划分

### 阶段 1：创建 MCP Server 基础架构

**目标**：搭建常驻 MCP Server，能被 Claude Code 发现并调用

**新建文件**：

1. `mcp/server.ts` — MCP Server 入口
   - 使用 `@modelcontextprotocol/sdk` 的 `SSEServerTransport`
   - 监听 `127.0.0.1:3457`（与 Bot API 3456 错开）
   - 注册所有工具
   - 健康检查：启动时 ping Bot API `/api/health`

2. `mcp/api-client.ts` — Bot API HTTP 客户端
   - 封装对 `http://127.0.0.1:3456/api/*` 的调用
   - 统一错误处理
   - 类型安全的请求/响应

3. `mcp/tools/index.ts` — 工具注册中心

4. `mcp/tools/tasks.ts` — Task 工具（5 个）
   - `bot_list_tasks` — 列出所有 Task
   - `bot_get_task(task_id)` — Task 详情
   - `bot_send_message(task_id, text)` — 发消息给 Discord Claude
   - `bot_fork_task(task_id, branch)` — Fork Task（创建 worktree）
   - `bot_qdev(task_id, description)` — 快速创建开发子任务

5. `mcp/tools/goals.ts` — Goal 工具（4 个）
   - `bot_list_goals(status?, project?, q?)` — 列出 Goals
   - `bot_get_goal(goal_id)` — Goal 详情（含子任务）
   - `bot_create_goal({name, project, ...})` — 创建 Goal
   - `bot_update_goal(goal_id, {...})` — 更新 Goal

6. `mcp/tools/data.ts` — DevLog + Idea 工具（4 个）
   - `bot_list_devlogs(project?, date?, start?, end?)` — 列出 DevLog
   - `bot_create_devlog({name, date, project, ...})` — 创建 DevLog
   - `bot_list_ideas(project?, status?)` — 列出 Ideas
   - `bot_create_idea(name, project)` — 创建 Idea

7. `mcp/tools/system.ts` — 系统工具（2 个）
   - `bot_status` — 全局状态
   - `bot_list_models` — 可用模型列表

**修改文件**：

1. `package.json` — 添加依赖和脚本
   ```
   + "@modelcontextprotocol/sdk": "^latest"
   + scripts.mcp: "tsx mcp/server.ts"
   ```

2. `tsconfig.json` — include 添加 `mcp/**/*`

**MCP 配置**（用户手动或 deploy.sh 自动）：

`~/.claude/settings.json` 添加：
```json
{
  "mcpServers": {
    "claude-bot": {
      "url": "http://127.0.0.1:3457/sse"
    }
  }
}
```

**共 15 个 MCP 工具**，全部通过 HTTP 调 Bot API 实现。

---

### 阶段 2：删除冗余 Skills

**目标**：删除不再需要的 skill 文件

**删除文件**：
- `skills/dc/` — 整个目录（功能由 MCP 工具替代）
- `skills/qdev/` — 整个目录（Discord 端已代码化，CLI 端改用 MCP `bot_qdev`）

**修改文件**：
- `scripts/install-skills.sh` — 移除 dc、qdev 的安装（如果有硬编码的话）

---

### 阶段 3：精简 Idea Skill

**目标**：idea 记录模式改为直接调 MCP 工具，不再启动 Claude 进程

**修改文件**：
- `skills/idea/SKILL.md` — 精简
  - 记录模式：指示 AI 调用 `bot_create_idea` MCP 工具（一步完成）
  - 列表模式：调用 `bot_list_ideas` MCP 工具获取列表，展示后走 `bot_qdev` 推进
  - 移除所有 `curl` 命令和 API 文档

---

### 阶段 4：精简 DevLog / Review Skills

**目标**：将 API 调用替换为 MCP 工具调用

**修改文件**：

1. `skills/devlog/SKILL.md` — 精简
   - 数据收集：仍用 git 命令（AI 在本地执行）
   - 写入：改为调用 `bot_create_devlog` MCP 工具
   - 查询 Goals：改为 `bot_list_goals` MCP 工具
   - 移除所有 `curl` 命令和 API 文档

2. `skills/review/SKILL.md` — 精简
   - 数据收集：改为 `bot_list_devlogs` + `bot_list_goals` MCP 工具
   - Git 补充：仍用 git 命令
   - 移除所有 `curl` 命令和 API 文档

---

### 阶段 5：精简 Merge / Goal / Commit Skills

**目标**：将确定性的 API 调用替换为 MCP 工具

**修改文件**：

1. `skills/merge/SKILL.md` — 精简
   - Git 操作脚本保留（merge/cleanup 仍用 bash）
   - API 调用替换：
     - `DELETE /api/tasks/$TASK_ID` → `bot_send_message` 通知 + 说明手动关闭
     - Ideas 查询/更新 → `bot_list_ideas` + MCP 工具
   - DevLog 写入 → 调用 `/devlog` skill（已精简）
   - 移除 API 文档和 curl 示例

2. `skills/goal/SKILL.md` — 精简
   - CRUD 操作：全部改用 MCP 工具
     - `bot_list_goals`, `bot_get_goal`, `bot_create_goal`, `bot_update_goal`
   - Ideas 查询：`bot_list_ideas`
   - Drive 启动：保留 curl（MCP 不暴露 drive API，因为是 orchestrator 内部功能）
   - 移除 API 文档

3. `skills/commit/SKILL.md` — 微调
   - 基本不变（核心是 code-audit + git commit）
   - 如果有 API 调用则替换为 MCP 工具

---

### 阶段 6：部署集成

**目标**：MCP Server 作为 systemd 服务部署

**新建文件**：
- `systemd/claude-mcp.service` — systemd user service 文件

**修改文件**：

1. `deploy.sh` — 添加 MCP Server 部署
   - 安装 `claude-mcp.service`
   - 启动/重启 MCP Server
   - 自动配置 `~/.claude/settings.json` 的 mcpServers

2. `docs/CLAUDE.md` — 更新项目文档
   - 添加 MCP Server 章节
   - 更新 Skills 列表
   - 更新架构图

---

## MCP 工具详细 Schema

### Task 工具

```
bot_list_tasks()
  → GET /api/tasks
  返回：Task 树形列表

bot_get_task(task_id: string)
  → GET /api/tasks/:threadId
  返回：Task 详情（名称、cwd、模型、分支、消息历史）

bot_send_message(task_id: string, text: string)
  → POST /api/tasks/:threadId/message
  说明：发消息到 Discord Thread，触发 Claude 执行

bot_fork_task(task_id: string, branch: string)
  → POST /api/tasks/:threadId/fork
  返回：新 Task 的 threadId、分支名、cwd

bot_qdev(task_id: string, description: string)
  → POST /api/tasks/:threadId/qdev
  说明：快速创建开发子任务（生成分支 + fork + 发送描述）
```

### Goal 工具

```
bot_list_goals(status?: string, project?: string, q?: string)
  → GET /api/goals
  返回：Goal 摘要列表

bot_get_goal(goal_id: string)
  → GET /api/goals/:id
  返回：Goal 详情（含子任务列表）

bot_create_goal(name: string, project: string, type?: string,
                status?: string, completion?: string, body?: string)
  → POST /api/goals
  返回：创建的 Goal

bot_update_goal(goal_id: string, ...fields)
  → PATCH /api/goals/:id
  返回：更新后的 Goal
```

### Data 工具

```
bot_list_devlogs(project?: string, date?: string, start?: string, end?: string)
  → GET /api/devlogs
  返回：DevLog 列表

bot_create_devlog(name: string, date: string, project: string,
                  branch?: string, summary?: string, commits?: number,
                  lines_changed?: string, goal?: string, content?: string)
  → POST /api/devlogs
  返回：创建的 DevLog

bot_list_ideas(project?: string, status?: string)
  → GET /api/ideas
  返回：Idea 列表

bot_create_idea(name: string, project: string)
  → POST /api/ideas
  返回：创建的 Idea
```

### System 工具

```
bot_status()
  → GET /api/status
  返回：全局状态（Task 列表、默认 cwd/model）

bot_list_models()
  → GET /api/models
  返回：可用模型列表 + 当前默认
```

## 风险与缓解

| 风险 | 缓解措施 |
|------|---------|
| Bot API 未启动时 MCP 工具失败 | 工具返回清晰错误信息："Bot API unavailable, is the Discord Bot running?" |
| MCP Server 端口冲突 | 可通过环境变量 `MCP_PORT` 配置，默认 3457 |
| Skill 精简后 Bot 端找不到 curl 命令 | Bot 端不改，继续读原 SKILL.md（但 SKILL.md 内容变了，AI 会用 MCP 工具） |
| 多个 Claude Code 实例并发调用 | Bot API 已有并发处理，MCP Server 无状态 |

## 验证清单

每阶段完成后验证：

- [ ] 阶段 1：`curl http://127.0.0.1:3457/sse` 能连接；Claude Code 能发现 15 个工具
- [ ] 阶段 2：`ls ~/.claude/skills/` 不再包含 dc、qdev
- [ ] 阶段 3：CLI 中 `/idea 测试想法` 不再启动 curl，而是调用 MCP 工具
- [ ] 阶段 4：CLI 中 `/devlog` 和 `/review` 使用 MCP 工具读写数据
- [ ] 阶段 5：CLI 中 `/merge`、`/goal`、`/commit` 正常工作
- [ ] 阶段 6：`deploy.sh deploy` 能启动 MCP Server；`systemctl --user status claude-mcp` 正常
