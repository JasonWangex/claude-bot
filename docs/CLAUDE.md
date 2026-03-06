# Claude Bot 项目文档

生成时间: 2026-03-05

## 项目概述

**项目名称**: claude-bot
**项目位置**: `/home/jason/projects/claude-bot`
**项目类型**: Discord Bot + MCP Server + Web Dashboard + REST API
**主要功能**: 通过 Discord 和本地 API 与 Claude Code CLI 交互，支持多 Channel 并行开发、Goal 自动调度、MCP 工具集成、Web 可视化看板、SQLite 本地数据存储

## 技术栈

- **运行时**: Node.js 18+ (ESM, tsx 直接运行 TypeScript)
- **语言**: TypeScript 5.9 (strict mode)
- **Discord**: discord.js 14.x
- **Claude**: Claude Code CLI (stream-json 解析)
- **数据库**: SQLite (better-sqlite3, WAL mode)
- **MCP**: @modelcontextprotocol/sdk (stdio transport)
- **Web**: React 18 + Vite + Ant Design
- **LLM**: DeepSeek API (轻量任务：分支名/标题生成)
- **图片处理**: sharp (压缩、缩放)
- **云存储**: ali-oss (阿里云 OSS，可选)
- **监控**: 独立 ProcessMonitor 守护进程 (Discord REST API 通知)

## 项目结构

```
claude-bot/
├── discord/                 # 主应用
│   ├── index.ts             # 入口：加载配置、初始化 OSS/MCP、启动 Bot
│   ├── bot/
│   │   ├── discord.ts       # DiscordBot 主类：组件初始化、Handler 注册、生命周期
│   │   ├── handlers.ts      # MessageHandler：文本消息处理、Claude 流式执行
│   │   ├── commands/        # Slash Commands（模块化）
│   │   │   ├── index.ts     # 注册 + 路由
│   │   │   ├── general.ts   # /login /start /help /status
│   │   │   ├── task.ts      # /close /info /cd
│   │   │   ├── session.ts   # /clear /compact /rewind /plan /stop /attach /sessions
│   │   │   ├── model.ts     # /model (Select Menu)
│   │   │   ├── dev.ts       # /qdev /code-audit /idea /commit /merge
│   │   │   └── goal.ts      # /goal
│   │   ├── message-queue.ts # MessageQueue：生产者-消费者队列 + token bucket 限速
│   │   ├── state.ts         # StateManager：Channel session 内存状态管理
│   │   ├── interaction-registry.ts # Button/SelectMenu/Modal 回调
│   │   ├── auth.ts          # Guild 级鉴权
│   │   └── message-utils.ts # Markdown 直通 + Discord 转义 + diff 渲染
│   ├── claude/
│   │   ├── client.ts        # ClaudeClient：封装 executor，提供 run/compact/stop
│   │   ├── executor.ts      # ClaudeExecutor：进程管理、流解析、stall 检测、stdin 注入
│   │   ├── api-error-interceptor.ts   # Claude API 错误拦截
│   │   └── auth-error-interceptor.ts  # 鉴权错误拦截（401 处理）
│   ├── orchestrator/        # Goal 自动调度引擎
│   │   ├── index.ts         # GoalOrchestrator：对外接口，事件路由
│   │   ├── drive.ts         # Drive 生命周期：启动/暂停/恢复
│   │   ├── dispatch.ts      # 任务派发：创建 worktree + channel + 发送 prompt
│   │   ├── task-scheduler.ts # 调度算法：DAG 拓扑排序、Phase 分组、并发控制
│   │   ├── task-control.ts  # 任务控制：skip/done/retry/reset/pause/nudge
│   │   ├── review-handler.ts # Tech Lead 代码审计 + verdict 处理
│   │   ├── replan-handler.ts # Replan 处理（任务卡住时重新规划）
│   │   ├── replanner.ts     # AI 重新规划逻辑
│   │   ├── feedback-handler.ts # 用户反馈处理
│   │   ├── merge-handler.ts # 子任务完成后 merge 到 goal 分支
│   │   ├── rollback-handler.ts # Rollback：回滚到 checkpoint
│   │   ├── goal-audit-handler.ts # Goal 完成后代码审计
│   │   ├── event-scanner.ts # 轮询 task_events 表，驱动编排
│   │   ├── callbacks.ts     # Orchestrator 外部回调（channel/worktree 清理）
│   │   ├── goal-branch.ts   # Git 分支操作：创建/合并/清理 goal 和子任务分支
│   │   ├── goal-state.ts    # 工具函数：子任务解析、进度统计
│   │   ├── goal-body-parser.ts # Goal body Markdown 解析
│   │   ├── goal-buttons.ts  # Discord 按钮：Drive/Pause/Resume/Rollback
│   │   ├── orchestrator-types.ts # 类型定义
│   │   └── git-ops.ts       # 底层 Git 执行（execFile）
│   ├── api/
│   │   ├── server.ts        # HTTP API 服务器（默认 127.0.0.1:3456）
│   │   │                    # 鉴权：localhost 免 token，Tailscale 需 Bearer token
│   │   ├── middleware.ts    # JSON body 解析、响应工具、requireToken/requireAuth
│   │   ├── types.ts         # Route / ApiDeps 类型定义
│   │   └── routes/          # RESTful 路由（见 API 文档）
│   ├── sync/                # Session 同步服务
│   │   ├── session-sync-service.ts  # 扫描 ~/.claude/projects 目录同步 session
│   │   ├── session-timeout-service.ts # 超时 session 自动关闭
│   │   ├── usage-reconciler.ts      # 用量数据对账（token/cost）
│   │   ├── jsonl-metadata.ts        # JSONL 文件元数据解析
│   │   ├── pricing-service.ts       # LiteLLM 定价数据
│   │   └── session-context.ts       # Session 上下文读取
│   ├── services/
│   │   ├── channel-service.ts       # Channel CRUD 业务逻辑
│   │   ├── prompt-config-service.ts # Prompt 配置管理（从 DB 读取/更新）
│   │   └── prompt-requirements.ts   # Prompt 校验规则
│   ├── db/                  # SQLite 数据库层
│   │   ├── index.ts         # DB 初始化 & 单例，导出所有 Repo
│   │   ├── migrate.ts       # 迁移机制（user_version pragma）
│   │   ├── migrations/      # 迁移脚本（001_create_schema.ts ... 041_...）
│   │   ├── repo/            # Repository 实现
│   │   │   ├── channel-repo.ts            # Channel CRUD
│   │   │   ├── claude-session-repo.ts     # Claude session 状态
│   │   │   ├── channel-session-link-repo.ts # Channel ↔ Session 关联
│   │   │   ├── goal-repo.ts               # Goal CRUD
│   │   │   ├── task-repo.ts               # Goal 子任务
│   │   │   ├── task-event-repo.ts         # Task 事件（AI→编排器通信）
│   │   │   ├── goal-event-repo.ts         # Goal 事件
│   │   │   ├── goal-timeline-repo.ts      # Goal 时间线
│   │   │   ├── guild-repo.ts              # Guild 配置
│   │   │   ├── session-changes-repo.ts    # Session 文件变更记录
│   │   │   ├── checkpoint-repo.ts         # Rollback checkpoint
│   │   │   └── sync-cursor-repo.ts        # 同步游标
│   │   ├── devlog-repo.ts       # DevLog 仓库
│   │   ├── goal-meta-repo.ts    # Goal 元数据
│   │   ├── goal-todo-repo.ts    # Goal Todo
│   │   ├── idea-repo.ts         # Idea 仓库
│   │   ├── knowledge-base-repo.ts # 知识库
│   │   ├── project-repo.ts      # 项目仓库
│   │   └── prompt-config-repo.ts # Prompt 配置仓库
│   ├── utils/
│   │   ├── config.ts        # 环境变量 → DiscordBotConfig
│   │   ├── env.ts           # AUTHORIZED_GUILD_ID / GENERAL_CHANNEL_ID 动态读写
│   │   ├── logger.ts        # 多 transport 日志（console/file/discord）
│   │   ├── git-utils.ts     # Git worktree / merge / 分支名生成
│   │   ├── llm.ts           # DeepSeek API：分支名/标题生成
│   │   ├── fork-task.ts     # Fork 核心：创建 worktree + channel + session
│   │   ├── qdev-core.ts     # qdev 核心逻辑（API 路由与 slash command 共用）
│   │   ├── topic-path.ts    # 目录命名（kebab-case/snake_case/original）
│   │   ├── image-processor.ts # 图片下载、压缩、base64 编码
│   │   ├── session-reader.ts  # JSONL session 文件读取工具
│   │   ├── oss.ts           # 阿里云 OSS 文件上传（可选）
│   │   └── transports/      # 日志 transport 实现
│   └── types/
│       ├── index.ts         # 全局类型：Session, StreamEvent, DiscordBotConfig 等
│       ├── db.ts            # SQLite Row 类型
│       └── repository.ts    # Repository 接口
│
├── mcp/                     # MCP Server（stdio transport）
│   ├── server.ts            # 入口：创建 McpServer 并注册所有工具
│   ├── api-client.ts        # 调用 Bot REST API 的 HTTP 客户端
│   └── tools/               # 12 个 MCP 工具（见 MCP 文档）
│
├── web/                     # Web 看板（React 18 + Vite + Ant Design）
│   └── src/
│       ├── pages/           # 页面：Dashboard, Goals, GoalDetail, Sessions,
│       │                    #       Channels, DevLogs, Ideas, KnowledgeBase,
│       │                    #       Projects, Prompts, Commands, Events, Settings
│       ├── components/      # 组件：GoalDAG, GoalTimeline, DriveControls,
│       │                    #       ConversationViewer, ChangesViewer 等
│       └── lib/             # API 封装、hooks（use-goals/use-sessions/...）
│
├── monitor/                 # 进程监控守护进程
│   ├── index.ts             # 入口
│   └── process-monitor.ts   # 崩溃检测 + Discord REST API 通知
│
├── skills/                  # 本地 Claude Code Skills
│   ├── commit/              # 代码审查与提交
│   ├── merge/               # 分支合并与清理
│   ├── goal/                # 目标管理
│   ├── devlog/              # 开发日志（写入 SQLite）
│   ├── review/              # 日报/周报生成
│   └── kb/                  # 知识库管理
│
├── hooks/                   # Claude CLI hook 脚本
│   ├── stop.sh              # Stop hook → POST /api/internal/hooks/session-event
│   ├── session-end.sh       # SessionEnd hook → 同上
│   └── claude-settings-example.json # hook 配置示例
│
├── scripts/                 # 自动化脚本
│   ├── install-skills.sh    # 安装 skills 符号链接到 ~/.claude/skills/
│   └── daily-review.sh      # 每日自动发送日报（cron）
│
├── data/                    # 持久化数据（运行时创建，gitignored）
│   ├── bot.db               # SQLite 数据库
│   └── processes/           # Claude 进程输出临时文件
│
├── config.sh                # 交互式初始化向导
├── deploy.sh                # 生产部署 (systemd + cron + skills)
├── example.env              # 环境变量模板
└── docs/CLAUDE.md           # 本文档
```

## 核心架构

### Discord Bot（Category + Text Channels）

```
Discord Server（授权 Guild）
├── #general                 → 全局命令：/login /status /help
├── Category: project-alpha  → 项目 A
│   ├── [Channel] main       → root session（项目入口）
│   ├── [Channel] feat/login → worktree session（子任务）
│   └── [Channel] fix/bug-1  → worktree session（并行开发）
└── Category: project-beta   → 项目 B
    └── [Channel] main       → root session
```

每个 Channel 是独立的开发会话，包含：
- 独立工作目录（`cwd`）和 Claude session ID
- 可选的 git worktree 分支隔离
- 父子 Channel 通过 `parentChannelId` 关联
- Session 状态持久化到 SQLite

### 消息队列（MessageQueue）

生产者-消费者模型，45 op/s token bucket 限速：

- **Per-channel 串行**: 每个 channel 消息严格串行，防止乱序
- **优先级**: `high`（立即发送）/ `normal`（走缓冲区）
- **消息长度策略**:
  - < 2000 字符 → 原生 Markdown
  - 2000–4096 字符 → Discord Embed
  - > 4096 字符 → 文件附件 / OSS 签名链接
- **Tool thread**: 工具调用结果发到独立 thread，不污染主 channel

### 交互式工具

- `AskUserQuestion` → Discord Buttons + "Other" 自定义文本输入
- `ExitPlanMode` → Buttons（approve / reject / compact_execute）
- Model Switch → StringSelectMenu
- Goal Drive → Buttons（Pause / Resume / Rollback）

### Goal 自动调度引擎（Orchestrator）

完整的多任务自动化开发流程：

```
用户 /goal → 创建 Goal → 设置子任务 → 启动 Drive
  → event-scanner 轮询 task_events 表
  → dispatch: 创建 worktree + channel + 发送任务 prompt
  → 子任务执行 → 写入 task.completed 事件
  → review-handler: Tech Lead 审计代码（Sonnet）
  → merge-handler: 合并到 goal 分支
  → 所有 Phase 完成 → Goal 完成 → 全量 code-audit
```

关键特性：
- **DAG 依赖解析**: 拓扑排序，Phase 分组（Phase N 在 Phase N-1 全完成后执行）
- **并发控制**: 可配置最大并发数（默认 3）
- **Tech Lead review**: 每个子任务完成后，Sonnet 模型审计 diff
  - verdict: `pass` → merge；`fail` → 任务重试；`replan` → 重新规划
- **Rollback**: 创建 checkpoint，支持回滚到任意历史状态
- **Feedback loop**: 用户反馈 → AI 分析 → 任务重新规划

### Claude Hook 集成

Claude CLI hooks 触发 Bot API 回调：

| Hook 事件 | 处理逻辑 |
|-----------|---------|
| `SessionStart` | 标记 session 为 active |
| `Notification` | 5秒后发送"等待输入"消息 |
| `Stop` | 发送 Done 消息（含时长/token/cost），关闭 stdin，触发 task 检查 |
| `SessionEnd` | 标记 session 为 closed，异常退出时标记任务 failed |

### MCP Server

MCP server 通过 stdio transport 与 Claude Code 集成，共 12 个工具：

| 工具 | 操作 |
|------|------|
| `bot_channels` | list / get / delete channel |
| `bot_send_message` | 发消息到 channel（触发 Claude 执行）|
| `bot_qdev` | 快速创建开发子任务 |
| `bot_goals` | Goal CRUD（list/get/create/update）|
| `bot_goal_tasks` | 子任务管理（list/set/skip/done/retry/reset/pause/nudge）|
| `bot_goal_todos` | Goal todo 管理 |
| `bot_goal_event` | 触发 goal.drive 事件 |
| `bot_devlogs` | DevLog list / create |
| `bot_ideas` | Ideas CRUD |
| `bot_kb` | 知识库 CRUD |
| `bot_status` | Bot 全局状态 |
| `bot_task_event` | 写入 task 事件（AI → 编排器通信）|

### Session 同步服务

`session-sync-service` 周期性扫描 `~/.claude/projects` 目录：
- 将 JSONL session 文件同步到 `claude_sessions` 表
- 解析 token 用量、cost（通过 LiteLLM 定价数据）
- `session-timeout-service` 自动关闭超时 session
- `usage-reconciler` 对账 token/cost 数据

### 阿里云 OSS（可选）

- 配置后文件自动上传到 OSS 并发送 24h 有效签名链接
- 未配置时静默降级为 Discord 附件
- 对象路径: `bot-files/YYYY/MM/DD/<timestamp>-<random>-<filename>`

### REST API（默认 127.0.0.1:3456）

#### 鉴权模型
- **localhost** (`127.0.0.1` / `::1`): 免 token，直接访问
- **Tailscale** (`100.64.0.0/10`): 需要 `Authorization: Bearer <BOT_ACCESS_TOKEN>`
- **其他 IP**: 一律拒绝（403）

#### 系统
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/health | 健康检查 |
| GET | /api/status | 全局状态（channels + sessions）|
| GET | /api/projects | 项目列表 |
| POST | /api/projects/sync | 同步项目目录 |
| GET | /api/projects/:name | 项目详情 |
| GET | /api/commands | Slash command 列表 |

#### 模型
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/models | 可用模型列表 |
| PUT | /api/models/default | 设置全局默认模型 |

#### Channel（开发会话）
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/channels | 列出所有 channel（树形结构）|
| POST | /api/channels | 创建 channel |
| GET | /api/channels/:channelId | Channel 详情 |
| PATCH | /api/channels/:channelId | 更新 channel（name/model/cwd）|
| DELETE | /api/channels/:channelId | 删除（归档）channel |
| POST | /api/channels/:channelId/archive | 归档 channel |
| POST | /api/channels/:channelId/fork | Fork channel（创建 worktree）|
| POST | /api/channels/:channelId/qdev | 快速创建开发子任务 |
| POST | /api/channels/:channelId/code-audit | 启动代码审计 |
| POST | /api/channels/:channelId/message | 发消息（触发 Claude 执行）|
| POST | /api/channels/:channelId/clear | 清空 Claude 上下文 |
| POST | /api/channels/:channelId/compact | 压缩 Claude 上下文 |
| POST | /api/channels/:channelId/rewind | 撤销最后一轮 |
| POST | /api/channels/:channelId/stop | 停止当前任务 |
| GET | /api/channels/:channelId/sessions | Channel 的 session 列表 |
| GET | /api/channels/:channelId/changes | Session 文件变更记录 |

#### Sessions & Usage
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/sessions | 列出所有 session |
| GET | /api/sessions/:id/meta | Session 元数据 |
| GET | /api/sessions/:id/conversation | Session 对话内容 |
| GET | /api/sessions/usage/daily | 每日 token/cost 统计 |
| GET | /api/sessions/usage/by-model | 按模型分组的用量统计 |
| GET | /api/changes/:id | 变更记录详情 |

#### Goal CRUD
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/goals | 列出 Goals（?status=&project= 筛选）|
| POST | /api/goals | 创建 Goal |
| GET | /api/goals/:goalId | Goal 详情 |
| PATCH | /api/goals/:goalId | 更新 Goal 元数据 |
| GET | /api/goals/:goalId/timeline | Goal 时间线 |

#### Goal Drive
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/goals/:goalId/tasks | 批量设置子任务（drive 前）|
| POST | /api/goals/:goalId/events | 创建 goal 事件（触发 drive）|
| POST | /api/goals/:goalId/drive | 启动 Goal Drive |
| GET | /api/goals/:goalId/status | 查看 Drive 状态 |
| POST | /api/goals/:goalId/pause | 暂停 Drive |
| POST | /api/goals/:goalId/resume | 恢复 Drive |
| POST | /api/goals/:goalId/tasks/:taskId/skip | 跳过子任务 |
| POST | /api/goals/:goalId/tasks/:taskId/done | 标记子任务完成 |
| POST | /api/goals/:goalId/tasks/:taskId/retry | 重试失败子任务 |
| POST | /api/goals/:goalId/tasks/:taskId/reset | 完整重置并重新启动 |
| POST | /api/goals/:goalId/tasks/:taskId/pause | 暂停子任务 |
| POST | /api/goals/:goalId/tasks/:taskId/nudge | 轻推子任务继续 |
| POST | /api/goals/:goalId/rollback | 启动 Rollback |
| POST | /api/goals/:goalId/confirm-rollback | 确认 Rollback |
| POST | /api/goals/:goalId/cancel-rollback | 取消 Rollback |

#### Goal Todos
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/goals/:goalId/todos | 列出 Todos |
| POST | /api/goals/:goalId/todos | 创建 Todo |
| PATCH | /api/goals/:goalId/todos/:todoId | 更新 Todo |
| DELETE | /api/goals/:goalId/todos/:todoId | 删除 Todo |

#### Task Events（AI → Orchestrator 通信）
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/events | 列出未处理事件 |
| POST | /api/tasks/:taskId/events | 写入 task 事件 |

#### DevLog
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/devlogs | 列出 DevLog（?project=&date=&start=&end=）|
| POST | /api/devlogs | 创建 DevLog |
| GET | /api/devlogs/:id | DevLog 详情 |

#### Ideas
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/ideas | 列出 Ideas（?project=&status=）|
| POST | /api/ideas | 创建 Idea |
| GET | /api/ideas/:id | Idea 详情 |
| PATCH | /api/ideas/:id | 更新 Idea |
| DELETE | /api/ideas/:id | 删除 Idea |

#### Knowledge Base
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/kb | 列出知识库条目 |
| POST | /api/kb | 创建条目 |
| GET | /api/kb/:id | 条目详情 |
| PATCH | /api/kb/:id | 更新条目 |
| DELETE | /api/kb/:id | 删除条目 |

#### Prompt 配置
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/prompts | 列出所有 prompt 配置 |
| POST | /api/prompts/refresh | 从 seed 刷新 prompts |
| GET | /api/prompts/:key | 获取指定 prompt |
| PATCH | /api/prompts/:key | 更新 prompt 内容 |

#### Sync
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/sync/sessions | 同步 Claude session 文件 |
| POST | /api/sync/usage | 对账 token/cost 用量 |
| POST | /api/sync/discord | 同步 Discord channel 状态 |

#### Debug
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/debug/running-tasks | 列出 running 状态任务（含僵尸检测）|
| GET | /api/debug/active-processes | 活跃 Claude 进程列表 |
| POST | /api/debug/kill-zombie-tasks | 清理僵尸任务 |

#### Internal（仅 localhost）
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/internal/hooks/session-event | 接收 Claude CLI hook 事件 |

## Slash Commands

### 全局命令（任意 channel）
- `/login <token>` — 绑定 Bot 到 Server
- `/start` — 显示欢迎信息
- `/status` — 所有 channel 状态
- `/help` — 命令列表

### Channel 内命令

**Session 管理**:
- `/plan <msg>` — Plan 模式
- `/clear` — 清空 Claude 上下文
- `/compact` — 压缩上下文
- `/rewind` — 撤销最后一轮
- `/stop [msg]` — 停止任务（可选：interrupt & inject）
- `/attach [session_id]` — 接管已有 Claude session
- `/sessions` — 列出本 channel 的 Claude session

**Channel 管理**:
- `/close [force]` — 关闭 channel 并清理 worktree/分支
- `/info` — Session 和 channel 详情
- `/cd [path]` — 切换/查看工作目录
- `/model` — 切换本 channel 模型

**开发工作流**:
- `/qdev <描述>` — 快速创建开发分支 + channel
- `/code-audit` — 对当前分支 diff 做代码审计
- `/commit [msg]` — 审查并提交代码
- `/merge <target>` — 合并分支并清理
- `/idea [内容]` — 记录想法或推进已有 Idea

**Goal 管理**:
- `/goal [text]` — 管理 Goals（列表/搜索/创建/Drive）

## Local Skills

6 个本地 Skills，通过 `scripts/install-skills.sh` 安装到 `~/.claude/skills/`：

| Skill | 说明 |
|-------|------|
| `/commit` | 代码审查 + 提交（先 audit 再 commit，Conventional Commits 格式）|
| `/merge` | 分支合并与清理（merge → 删 worktree → 删 channel → 写 devlog）|
| `/goal` | 目标管理（通过 MCP 工具：列表/创建/Drive）|
| `/devlog` | 开发日志（收集 git 信息 → 写入 SQLite，tag 追踪进度）|
| `/review` | 日报/周报（从 SQLite DevLog + Goals 生成结构化报告）|
| `/kb` | 知识库管理（记录架构决策/调试经验/API 设计等）|

## 数据存储

所有数据存储在本地 SQLite 数据库（`data/bot.db`）：

| 表 | 说明 |
|----|------|
| `channels` | Discord channel 配置和状态 |
| `claude_sessions` | Claude CLI session（从 JSONL 同步）|
| `channel_session_links` | Channel ↔ Session 关联 |
| `guilds` | Guild 配置 |
| `goals` | 开发目标 |
| `tasks` | Goal 子任务（含依赖/Phase/状态）|
| `task_events` | AI → 编排器通信事件 |
| `goal_events` | Goal 级事件 |
| `goal_timeline` | Goal 时间线记录 |
| `goal_todos` | Goal Todo 列表 |
| `checkpoints` | Rollback checkpoint |
| `devlogs` | 开发日志 |
| `ideas` | 想法记录 |
| `knowledge_base` | 知识库条目 |
| `projects` | 项目目录记录 |
| `prompt_config` | 可配置的 AI prompt 模板 |
| `session_changes` | Session 文件变更记录 |

## 环境变量

### 必填
| 变量 | 说明 |
|------|------|
| `DISCORD_TOKEN` | Discord Bot Token |
| `DISCORD_APPLICATION_ID` | Discord Application ID |
| `BOT_ACCESS_TOKEN` | API 认证 Token（Tailscale 请求需要）|

### 自动填充（/login 后写入 .env）
| 变量 | 说明 |
|------|------|
| `AUTHORIZED_GUILD_ID` | 授权 Guild ID |
| `GENERAL_CHANNEL_ID` | #general channel ID |

### 工作目录
| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DEFAULT_WORK_DIR` | `~/` | 默认工作目录 |
| `PROJECTS_ROOT` | `~/projects` | 项目根目录 |
| `WORKTREES_DIR` | `$PROJECTS_ROOT/worktrees` | Worktree 目录 |

### Claude CLI
| 变量 | 默认值 | 说明 |
|------|--------|------|
| `COMMAND_TIMEOUT` | `3600000` | 命令超时 (1h) |
| `MAX_TURNS` | `500` | Claude 最大轮次 |
| `STALL_TIMEOUT` | `60000` | 无输出超时 (1min) |
| `PIPELINE_SONNET_MODEL` | `claude-sonnet-4-6` | 编排器 Sonnet 模型 |
| `PIPELINE_OPUS_MODEL` | `claude-opus-4-6` | 编排器 Opus 模型 |

### API
| 变量 | 默认值 | 说明 |
|------|--------|------|
| `API_PORT` | `3456` | 本地 HTTP API 端口（0=禁用）|
| `API_LISTEN` | `127.0.0.1` | 监听地址（`0.0.0.0` 支持 Tailscale）|
| `WEB_URL` | - | Web 看板地址（Done 消息附带链接）|

### 通知
| 变量 | 说明 |
|------|------|
| `GOAL_LOG_CHANNEL_ID` | Goal pipeline 日志专用 channel |
| `DISCORD_NOTIFY_USER_ID` | @mention 目标用户 ID |

### LLM
| 变量 | 说明 |
|------|------|
| `DEEPSEEK_API_KEY` | DeepSeek API Key（分支名/标题生成）|

### 进程监控
| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MONITOR_CHECK_INTERVAL` | `5000` | 进程检查间隔 (5s) |
| `MONITOR_COOLDOWN` | `180000` | 通知冷却期 (3min) |
| `MONITOR_MIN_RUNTIME` | `2` | 最小运行时间 (秒) |
| `MONITOR_MAX_RUNTIME` | `3600` | 最大运行时间 (秒) |
| `MONITOR_SERVICES` | `claude-discord` | 要监控的服务 |

### 阿里云 OSS（可选）
| 变量 | 说明 |
|------|------|
| `OSS_REGION` | 地域（如 `oss-cn-hangzhou`）|
| `OSS_BUCKET` | Bucket 名称 |
| `OSS_ACCESS_KEY_ID` | Access Key ID |
| `OSS_ACCESS_KEY_SECRET` | Access Key Secret |
| `OSS_ENDPOINT` | 自定义 Endpoint（可选）|

## 部署

### 初始化
```bash
./config.sh          # 交互式向导（推荐）
```

### 开发模式
```bash
npm run dev          # Discord Bot
npm run dev:monitor  # Process Monitor
cd web && npm run dev  # Web 看板
```

### 生产部署
```bash
./deploy.sh deploy   # 完整部署（install skills + cron + systemd）
./deploy.sh status   # 查看服务状态
./deploy.sh logs     # 查看日志
./deploy.sh restart  # 重启服务
./deploy.sh stop     # 停止服务
```

**systemd 服务**（user scope）:
- `claude-discord.service` — Discord Bot + REST API
- `claude-monitor.service` — 进程监控

**Skills 安装**:
```bash
./scripts/install-skills.sh  # 符号链接到 ~/.claude/skills/
```

### Claude Hooks 配置

将 `hooks/claude-settings-example.json` 中的 hooks 配置合并到 `~/.claude/settings.json`：

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "~/.claude/hooks/stop.sh" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "~/.claude/hooks/session-end.sh" }] }]
  }
}
```

然后安装 hook 脚本到 `~/.claude/hooks/`（deploy.sh 会自动处理）。
