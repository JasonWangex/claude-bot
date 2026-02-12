# Claude Bot 项目文档

生成时间: 2026-02-12

## 项目概述

**项目名称**: claude-bot
**项目位置**: `/home/jason/projects/claude-bot`
**项目类型**: Discord Bot + REST API
**主要功能**: 通过 Discord 和本地 API 与 Claude Code CLI 交互，支持多 Forum Post 并行开发、Goal 自动调度、Notion 集成

## 技术栈

- **运行时**: Node.js 18+ (ESM, tsx 直接运行 TypeScript)
- **语言**: TypeScript 5.9 (strict mode)
- **Discord**: discord.js 14.x
- **Claude**: Claude Code CLI (stream-json 解析)
- **监控**: 独立 ProcessMonitor 守护进程 (Discord REST API 通知)

## 项目结构

```
claude-bot/
├── discord/                 # 主应用
│   ├── index.ts             # 入口：加载配置、启动 Bot
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
│   │   ├── state.ts         # StateManager：Session 持久化 CRUD
│   │   ├── interaction-registry.ts # Button/SelectMenu/Modal 回调
│   │   ├── auth.ts          # Guild 级鉴权
│   │   └── message-utils.ts # Markdown 直通 + Discord 转义 + diff 渲染
│   ├── claude/
│   │   ├── client.ts        # ClaudeClient：封装 executor
│   │   └── executor.ts      # ClaudeExecutor：进程管理、流解析、stall 检测
│   ├── orchestrator/         # Goal 自动调度引擎
│   │   ├── index.ts         # GoalOrchestrator：drive 生命周期、任务派发、merge
│   │   ├── goal-state.ts    # 状态持久化：读写 data/goals/<id>.json
│   │   ├── goal-branch.ts   # Git 分支操作：创建/合并/清理 goal 和子任务分支
│   │   ├── git-ops.ts       # 底层 Git 执行
│   │   └── task-scheduler.ts # 调度算法：依赖分析、并发控制、进度统计
│   ├── api/
│   │   ├── server.ts        # HTTP API 服务器 (127.0.0.1:3456)
│   │   ├── routes/          # RESTful 路由（tasks, goals, messages 等）
│   │   ├── types.ts         # API 类型定义
│   │   └── middleware.ts    # JSON 响应工具
│   ├── utils/
│   │   ├── config.ts        # 环境变量 → DiscordBotConfig
│   │   ├── env.ts           # AUTHORIZED_GUILD_ID / GENERAL_CHANNEL_ID 读写
│   │   ├── logger.ts        # 日志工具
│   │   ├── git-utils.ts     # Git 操作：worktree、merge、分支名生成
│   │   ├── llm.ts           # LLM 工具（标题生成等）
│   │   ├── fork-task.ts     # Fork 核心：创建 worktree + Forum Post + session
│   │   ├── topic-path.ts    # 目录命名
│   │   └── image-processor.ts # Discord 附件图片处理
│   └── types/index.ts       # 全局类型：Session, StreamEvent, GoalDriveState 等
│
├── monitor/                  # 进程监控守护进程
│   ├── index.ts             # 入口
│   ├── process-monitor.ts   # 崩溃检测 + Discord REST API 通知
│   └── types.ts             # 监控类型
│
├── data/                     # 持久化数据
│   ├── discord-states.json  # Bot 状态（sessions + guilds）
│   ├── goals/               # Goal Drive 状态文件（<goalId>.json）
│   └── processes/           # Claude 进程输出临时文件
│
├── deploy.sh                # 生产部署 (systemd)
└── package.json             # 依赖配置
```

## 核心架构

### Discord Bot (Guild + Forum Posts)

```
Discord Server (授权的 Guild ID)
├── #general              → 全局命令: /login, /status, /model
├── Forum: claude-bot     → Project Forum Channel
│   ├── [Post] feat/task-a → Session A (独立 cwd、Claude 上下文)
│   └── [Post] fix/task-b  → Session B (并行执行)
└── Forum: another-project
    └── [Post] feat/feature → Session C
```

每个 Forum Post (Thread) 是独立的开发会话，支持：
- 独立工作目录和 Claude session
- Git worktree 分支隔离
- 并行执行互不干扰
- Forum Tags 状态追踪 (developing/merged/closed)

### 消息队列 (MessageQueue)

生产者-消费者模型，解耦 Claude 输出与 Discord API：

- **Per-thread 节流**: 普通消息缓冲 10s 后合并发送
- **优先级**: high（立即发送）/ normal（走缓冲区）
- **Rate limiting**: 100ms flush 间隔，1100ms 操作间隔
- **消息长度策略**: < 2000 原生 Markdown, 2000-4096 Embed, > 4096 文件附件
- **Edit 合并**: 连续同 messageId 的 edit 只保留最后一个
- **串行 Promise 链**: 文本发送 + 进度重建严格串行

### 交互式工具

- `AskUserQuestion` → Discord Buttons + "Other" 自定义文本
- `ExitPlanMode` → Buttons (approve/reject/compact_execute)
- Model Switch → StringSelectMenu
- 自动检测 CLI auto-denial，显示 Discord UI 收集用户输入

### REST API (127.0.0.1:3456)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/health | 健康检查 |
| GET | /api/status | 全局状态 |
| GET/POST | /api/tasks | 列出/创建 Task |
| GET/PATCH/DELETE | /api/tasks/:threadId | Task CRUD |
| POST | /api/tasks/:threadId/fork | Fork（创建 worktree 子 Task） |
| POST | /api/tasks/:threadId/qdev | 快速创建开发任务 |
| POST | /api/tasks/:threadId/message | 发消息（触发 Claude 执行） |
| POST | /api/tasks/:threadId/clear\|compact\|rewind\|stop | 会话操作 |
| GET/PUT | /api/models | 模型管理 |
| POST | /api/goals/:id/drive | 启动 Goal 自动驱动 |
| GET | /api/goals/:id/status | 查看 Drive 状态 |
| POST | /api/goals/:id/pause\|resume | 暂停/恢复 Drive |
| POST | /api/goals/:id/tasks/:taskId/skip\|done\|retry | 子任务操作 |

## Slash Commands

### #general (Text Channel)
- `/login <token>` - 绑定 Bot
- `/status` - 所有 Task 状态
- `/model` - 全局默认模型
- `/help` - 命令列表

### Forum Post (Thread) 内
- `/plan <msg>` - Plan 模式
- `/cd <path>` - 切换工作目录
- `/clear` - 清空上下文
- `/compact` - 压缩上下文
- `/rewind` - 撤销最后一轮
- `/stop` - 停止任务
- `/info` - 会话详情
- `/close` - 关闭 Thread 并清理
- `/qdev <描述>` - 快速创建开发分支
- `/idea <描述>` - 记录/推进想法
- `/commit` - 审查并提交代码
- `/merge <target>` - 合并分支并清理
- `/model` - 切换 Thread 模型
- `/attach <session_id>` - 接管其他会话

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| DISCORD_TOKEN | 必填 | Discord Bot Token |
| DISCORD_APPLICATION_ID | 必填 | Discord Application ID |
| BOT_ACCESS_TOKEN | 必填 | 认证 Token |
| AUTHORIZED_GUILD_ID | /login 后填充 | 授权 Guild ID |
| GENERAL_CHANNEL_ID | /login 后填充 | #general 频道 ID |
| DEFAULT_WORK_DIR | ~/ | 默认工作目录 |
| MAX_TURNS | 20 | Claude 最大轮次 |
| COMMAND_TIMEOUT | 300000 | 命令超时 (5min) |
| STALL_TIMEOUT | 60000 | 无输出超时 (1min) |
| API_PORT | 3456 | API 端口 (0=禁用) |
| WORKTREES_DIR | ${PROJECTS_ROOT}/worktrees | Worktree 目录 |

## 部署

```bash
./deploy.sh deploy   # 完整部署（systemd reload + restart）
./deploy.sh status   # 查看服务状态
./deploy.sh logs     # 查看日志
```

**systemd 服务**:
- `claude-discord.service` - Discord Bot
- `claude-monitor.service` - 进程监控

## 可用模型

- `claude-opus-4-6` (Opus 4.6)
- `claude-sonnet-4-5-20250929` (Sonnet 4.5)
- `claude-haiku-4-5-20251001` (Haiku 4.5)
