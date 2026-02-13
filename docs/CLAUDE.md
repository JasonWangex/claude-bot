# Claude Bot 项目文档

生成时间: 2026-02-12

## 项目概述

**项目名称**: claude-bot
**项目位置**: `/home/jason/projects/claude-bot`
**项目类型**: Discord Bot + REST API + Local Skills
**主要功能**: 通过 Discord 和本地 API 与 Claude Code CLI 交互，支持多 Task 并行开发、Goal 自动调度、SQLite 本地数据存储、本地 Skill 工作流

## 技术栈

- **运行时**: Node.js 18+ (ESM, tsx 直接运行 TypeScript)
- **语言**: TypeScript 5.9 (strict mode)
- **Discord**: discord.js 14.x
- **Claude**: Claude Code CLI (stream-json 解析)
- **数据库**: SQLite (better-sqlite3, WAL mode)
- **LLM**: DeepSeek API (轻量任务：分支名/标题生成)
- **图片处理**: sharp (压缩、缩放)
- **云存储**: ali-oss (阿里云 OSS，可选)
- **监控**: 独立 ProcessMonitor 守护进程 (Discord REST API 通知)

## 项目结构

```
claude-bot/
├── discord/                 # 主应用
│   ├── index.ts             # 入口：加载配置、初始化 OSS、启动 Bot
│   ├── bot/
│   │   ├── discord.ts       # DiscordBot 主类：组件初始化、Handler 注册、生命周期
│   │   ├── handlers.ts      # MessageHandler：文本消息处理、Claude 流式执行
│   │   ├── commands/        # Slash Commands（模块化）
│   │   │   ├── index.ts     # 注册 + 路由
│   │   │   ├── general.ts   # /login /start /help /status
│   │   │   ├── task.ts      # /task /close /info /cd
│   │   │   ├── session.ts   # /clear /compact /rewind /plan /stop /attach
│   │   │   ├── model.ts     # /model (Select Menu)
│   │   │   ├── dev.ts       # /qdev /idea /commit /merge
│   │   │   └── types.ts     # CommandDeps 接口
│   │   ├── message-queue.ts # MessageQueue：生产者-消费者队列 + per-thread 节流
│   │   ├── state.ts         # StateManager：Session 持久化 CRUD（SQLite 后端）
│   │   ├── interaction-registry.ts # Button/SelectMenu/Modal 回调
│   │   ├── auth.ts          # Guild 级鉴权
│   │   └── message-utils.ts # Markdown 直通 + Discord 转义 + diff 渲染
│   ├── claude/
│   │   ├── client.ts        # ClaudeClient：封装 executor
│   │   └── executor.ts      # ClaudeExecutor：进程管理、流解析、stall 检测
│   ├── orchestrator/        # Goal 自动调度引擎
│   │   ├── index.ts         # GoalOrchestrator：drive 生命周期、任务派发、merge
│   │   ├── goal-state.ts    # 工具函数：子任务解析、分支名生成
│   │   ├── goal-branch.ts   # Git 分支操作：创建/合并/清理 goal 和子任务分支
│   │   ├── git-ops.ts       # 底层 Git 执行
│   │   └── task-scheduler.ts # 调度算法：依赖分析、并发控制、进度统计
│   ├── api/
│   │   ├── server.ts        # HTTP API 服务器 (127.0.0.1:3456)
│   │   ├── routes/          # RESTful 路由
│   │   │   ├── health.ts    # 健康检查
│   │   │   ├── status.ts    # 全局状态
│   │   │   ├── tasks.ts     # Task CRUD
│   │   │   ├── goals.ts     # Goal Drive API
│   │   │   ├── qdev.ts      # 快速开发 API
│   │   │   ├── messages.ts  # 消息发送
│   │   │   ├── models.ts    # 模型管理
│   │   │   └── session-ops.ts # 会话操作 (clear/compact/rewind/stop)
│   │   ├── types.ts         # API 类型定义
│   │   └── middleware.ts    # JSON 响应工具
│   ├── db/                  # SQLite 数据库层
│   │   ├── index.ts         # DB 初始化 & 单例
│   │   ├── migrate.ts       # 迁移机制（user_version pragma）
│   │   ├── migrations/      # 迁移脚本（001_initial_schema.ts ...）
│   │   ├── repo/            # Repository 实现（session, guild, goal, goal-task）
│   │   ├── idea-repo.ts     # Idea 仓库
│   │   └── devlog-repo.ts   # DevLog 仓库
│   ├── utils/
│   │   ├── config.ts        # 环境变量 → DiscordBotConfig
│   │   ├── env.ts           # AUTHORIZED_GUILD_ID / GENERAL_CHANNEL_ID 读写
│   │   ├── logger.ts        # 日志工具
│   │   ├── git-utils.ts     # Git 操作：worktree、merge、分支名生成
│   │   ├── llm.ts           # DeepSeek API：分支名/标题生成
│   │   ├── fork-task.ts     # Fork 核心：创建 worktree + Thread + session
│   │   ├── topic-path.ts    # 目录命名
│   │   ├── image-processor.ts # 图片下载、压缩、base64 编码
│   │   └── oss.ts           # 阿里云 OSS 文件上传（可选）
│   └── types/               # 类型定义
│       ├── index.ts         # 全局类型：Session, StreamEvent, GoalDriveState 等
│       ├── db.ts            # SQLite Row 类型
│       └── repository.ts    # Repository 接口（DevLog, Idea 等）
│
├── monitor/                  # 进程监控守护进程
│   ├── index.ts             # 入口
│   ├── process-monitor.ts   # 崩溃检测 + Discord REST API 通知
│   └── types.ts             # 监控类型
│
├── skills/                   # 本地 Claude Code Skills
│   ├── commit/              # 代码审查与提交
│   ├── qdev/                # 快速创建开发任务
│   ├── goal/                # 目标管理
│   ├── merge/               # 分支合并与清理
│   ├── idea/                # 想法记录与推进
│   ├── devlog/              # 开发日志（写入 SQLite）
│   ├── review/              # 日报/周报生成
│   └── dc/                  # Discord Bot 远程控制
│
├── scripts/                  # 自动化脚本
│   ├── install-skills.sh    # 安装 skills 符号链接到 ~/.claude/skills/
│   ├── daily-review.sh      # 每日自动发送日报（cron）
│   └── debug-session.sh     # 会话调试工具
│
├── data/                     # 持久化数据（运行时创建）
│   ├── bot.db               # SQLite 数据库（sessions, guilds, goals, devlogs, ideas）
│   └── processes/           # Claude 进程输出临时文件
│
├── docs/
│   └── CLAUDE.md            # 项目文档
├── deploy.sh                # 生产部署 (systemd + cron + skills)
├── package.json             # 依赖配置
├── tsconfig.json            # TypeScript 配置
└── example.env              # 环境变量模板
```

## 核心架构

### Discord Bot (Category + Text Channels)

```
Discord Server (授权的 Guild ID)
├── #general              → 全局命令: /login, /status, /model
├── Category: claude-bot  → 项目 Category
│   ├── [Channel] feat/task-a → Session A (独立 cwd、Claude 上下文)
│   └── [Channel] fix/task-b  → Session B (并行执行)
└── Category: another-project
    └── [Channel] feat/feature → Session C
```

每个 Task (Text Channel) 是独立的开发会话，支持：
- 独立工作目录和 Claude session
- Git worktree 分支隔离
- 并行执行互不干扰
- 父子 Task 通过 `parentThreadId` 关联
- Fork 支持（创建 worktree 子 Task）

### 消息队列 (MessageQueue)

生产者-消费者模型，解耦 Claude 输出与 Discord API：

- **Per-thread 节流**: 普通消息缓冲 10s 后合并发送
- **优先级**: high（立即发送）/ normal（走缓冲区）
- **Rate limiting**: 100ms flush 间隔，1100ms 操作间隔
- **消息长度策略**: < 2000 原生 Markdown, 2000-4096 Embed, > 4096 文件附件/OSS
- **Edit 合并**: 连续同 messageId 的 edit 只保留最后一个
- **串行 Promise 链**: 文本发送 + 进度重建严格串行

### 交互式工具

- `AskUserQuestion` → Discord Buttons + "Other" 自定义文本
- `ExitPlanMode` → Buttons (approve/reject/compact_execute)
- Model Switch → StringSelectMenu
- 自动检测 CLI auto-denial，显示 Discord UI 收集用户输入

### Goal 自动调度引擎 (Orchestrator)

自动化多任务开发流程：

1. 启动 Goal drive（创建 goal 分支 + worktree）
2. 解析子任务依赖关系（支持 Phase 分组）
3. 自动派发可执行任务到独立 worktree/Discord Thread
4. 监控子任务完成 → 自动 merge 到 goal 分支
5. 异常时暂停等待用户干预

关键特性：
- **依赖分析**: DAG 拓扑排序
- **Phase 分组**: Phase N 在 Phase N-1 全部完成后执行
- **并发控制**: 最大并发数可配置
- **自动 merge**: 子任务完成后自动合并到 goal 分支

### 阿里云 OSS (可选)

- 配置后文件自动上传到 OSS 并发送签名链接（24h 有效）
- 未配置时静默降级为 Discord 附件
- 文件路径: `bot-files/YYYY/MM/DD/<timestamp>-<random>-<filename>`

### 图片处理

- 从 Discord CDN 下载图片并智能压缩
- 小 PNG（< 200KB）保持原格式，大图压缩为 JPEG（quality=80）
- 超过 1568px 的图片按比例缩放
- 最大下载限制 20MB，返回 base64 供 Claude API 使用

### REST API (127.0.0.1:3456)

#### 系统
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/health | 健康检查 |
| GET | /api/status | 全局状态 |

#### 模型
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/models | 可用模型列表 |
| PUT | /api/models/default | 设置全局默认模型 |

#### Task
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/tasks | 列出所有 Task（树形结构） |
| POST | /api/tasks | 创建 Task |
| GET | /api/tasks/:threadId | Task 详情 |
| PATCH | /api/tasks/:threadId | 更新 Task (name/model/cwd) |
| DELETE | /api/tasks/:threadId | 删除（归档 Thread） |
| POST | /api/tasks/:threadId/archive | 归档 Task |
| POST | /api/tasks/:threadId/fork | Fork Task（创建 worktree） |
| POST | /api/tasks/:threadId/qdev | 快速创建开发子任务 |
| POST | /api/tasks/:threadId/message | 发消息（触发 Claude 执行） |
| POST | /api/tasks/:threadId/clear | 清空上下文 |
| POST | /api/tasks/:threadId/compact | 压缩上下文 |
| POST | /api/tasks/:threadId/rewind | 撤销最后一轮 |
| POST | /api/tasks/:threadId/stop | 停止任务 |

#### Goal CRUD
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/goals | 列出 Goals（?status=&project= 筛选） |
| POST | /api/goals | 创建 Goal |
| GET | /api/goals/:id | Goal 详情（含子任务） |
| PATCH | /api/goals/:id | 更新 Goal 元数据 |

#### Goal Drive
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/goals/:id/drive | 启动 Goal 自动驱动 |
| GET | /api/goals/:id/status | 查看 Drive 状态 |
| POST | /api/goals/:id/pause | 暂停 Drive |
| POST | /api/goals/:id/resume | 恢复 Drive |
| POST | /api/goals/:id/tasks/:taskId/skip | 跳过子任务 |
| POST | /api/goals/:id/tasks/:taskId/done | 标记手动任务完成 |
| POST | /api/goals/:id/tasks/:taskId/retry | 重试失败任务 |

#### DevLog CRUD
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/devlogs | 列出 DevLog（?project=&date=&start=&end= 筛选） |
| POST | /api/devlogs | 创建 DevLog |
| GET | /api/devlogs/:id | DevLog 详情 |

#### Ideas CRUD
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/ideas | 列出 Ideas（?project=&status= 筛选） |
| POST | /api/ideas | 创建 Idea |
| GET | /api/ideas/:id | Idea 详情 |
| PATCH | /api/ideas/:id | 更新 Idea |

## Slash Commands

### #general (Text Channel)
- `/login <token>` - 绑定 Bot 到 Server
- `/start` - 显示欢迎信息
- `/status` - 所有 Task 状态
- `/model` - 全局默认模型
- `/help` - 命令列表

### Task (Text Channel) 内

**Session 管理**:
- `/plan <msg>` - Plan 模式
- `/clear` - 清空上下文
- `/compact` - 压缩上下文
- `/rewind` - 撤销最后一轮
- `/stop [msg]` - 停止任务（可选：interrupt & resume）
- `/attach [id]` - 接管其他 Claude session

**Task 管理**:
- `/task <name>` - 创建新 Task（Category 下 Text Channel）
- `/close [force]` - 关闭 Thread 并清理 worktree/分支
- `/info` - 会话详情
- `/cd [path]` - 切换/查看工作目录
- `/model` - 切换 Thread 模型

**开发工作流**:
- `/qdev <描述>` - 快速创建开发分支 + Task
- `/idea [内容]` - 记录想法或推进已有 Idea
- `/commit [msg]` - 审查并提交代码
- `/merge <target>` - 合并分支并清理

## Local Skills

项目包含 8 个本地 Claude Code Skills（通过 `scripts/install-skills.sh` 安装到 `~/.claude/skills/`）：

| Skill | 说明 |
|-------|------|
| `/commit` | 代码审查 + 提交（先 audit 再 commit，Conventional Commits 格式） |
| `/qdev` | 快速创建开发任务（通过 Bot API fork root task + 发送描述） |
| `/goal` | 目标管理（列表/搜索/创建/批量 drive all，通过 Bot API + SQLite） |
| `/merge` | 分支合并与清理（merge → 删 worktree → 删分支 → 删 Thread → devlog） |
| `/idea` | 想法记录（写入 SQLite Status=Idea）或推进已有 Idea（→ qdev） |
| `/devlog` | 开发日志（收集 git 信息 → 写入 SQLite，tag 追踪进度） |
| `/review` | 日报/周报（从 SQLite DevLog + Goals 收集数据，生成结构化报告） |
| `/dc` | Discord Bot 远程控制（通过本地 HTTP API 操作 Bot 所有功能） |

## 数据存储

所有数据存储在本地 SQLite 数据库 (`data/bot.db`)：
- **sessions / archived_sessions** - Discord 会话状态
- **guilds** - Guild 配置
- **goals / goal_tasks / goal_task_deps** - 目标管理、子任务拆解、依赖关系
- **devlogs** - 开发日志、合并记录、变更历史
- **ideas** - 想法记录与状态追踪

Skills 通过 Bot REST API (`/api/goals`, `/api/devlogs`, `/api/ideas`) 读写数据。

## 环境变量

### 必填
| 变量 | 说明 |
|------|------|
| DISCORD_TOKEN | Discord Bot Token |
| DISCORD_APPLICATION_ID | Discord Application ID |
| BOT_ACCESS_TOKEN | 认证 Token |

### 自动填充
| 变量 | 说明 |
|------|------|
| AUTHORIZED_GUILD_ID | /login 后自动写入 |
| GENERAL_CHANNEL_ID | /login 后自动写入 |

### 工作目录
| 变量 | 默认值 | 说明 |
|------|--------|------|
| DEFAULT_WORK_DIR | ~/ | 默认工作目录 |
| PROJECTS_ROOT | - | 项目根目录 |
| WORKTREES_DIR | ${PROJECTS_ROOT}/worktrees | Worktree 目录 |

### Claude CLI
| 变量 | 默认值 | 说明 |
|------|--------|------|
| COMMAND_TIMEOUT | 3600000 | 命令超时 (1h) |
| MAX_TURNS | 500 | Claude 最大轮次 |
| STALL_TIMEOUT | 60000 | 无输出超时 (1min) |

### LLM
| 变量 | 说明 |
|------|------|
| DEEPSEEK_API_KEY | DeepSeek API Key（轻量 LLM 任务） |
| DEEPSEEK_BASE_URL | 可选，默认 https://api.deepseek.com |

### API
| 变量 | 默认值 | 说明 |
|------|--------|------|
| API_PORT | 3456 | 本地 HTTP API 端口 (0=禁用) |

### 进程监控
| 变量 | 默认值 | 说明 |
|------|--------|------|
| MONITOR_CHECK_INTERVAL | 5000 | 进程检查间隔 (5s) |
| MONITOR_COOLDOWN | 180000 | 通知冷却期 (3min) |
| MONITOR_MIN_RUNTIME | 2 | 最小运行时间 (秒) |
| MONITOR_MAX_RUNTIME | 3600 | 最大运行时间 (秒) |
| MONITOR_SERVICES | claude-discord | 要监控的服务 |

### 阿里云 OSS (可选)
| 变量 | 说明 |
|------|------|
| OSS_REGION | 地域 (如 oss-cn-hangzhou) |
| OSS_BUCKET | Bucket 名称 |
| OSS_ACCESS_KEY_ID | Access Key ID |
| OSS_ACCESS_KEY_SECRET | Access Key Secret |
| OSS_ENDPOINT | 自定义 Endpoint (可选) |

## 部署

### 开发模式
```bash
npm run dev          # Discord Bot
npm run dev:monitor  # Process Monitor
```

### 生产部署
```bash
./deploy.sh deploy   # 完整部署（install skills + cron + systemd）
./deploy.sh status   # 查看服务状态
./deploy.sh logs     # 查看日志
./deploy.sh restart  # 重启服务
./deploy.sh stop     # 停止服务
```

**systemd 服务**:
- `claude-discord.service` - Discord Bot
- `claude-monitor.service` - 进程监控

**Cron 任务**:
- `daily-review.sh` - 每天 09:00 自动发送日报

**Skills 安装**:
```bash
./scripts/install-skills.sh  # 符号链接到 ~/.claude/skills/
```

## 可用模型

- `claude-opus-4-6` (Opus 4.6)
- `claude-sonnet-4-5-20250929` (Sonnet 4.5)
- `claude-haiku-4-5-20251001` (Haiku 4.5)
