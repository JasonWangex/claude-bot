# claude-bot

Discord-native development orchestrator built on top of Claude Code CLI.

## 这是什么

claude-bot 把 Discord 变成一个完整的 AI 开发工作台。每一个 Discord 频道对应一个独立的 Claude Code CLI 会话，拥有自己的工作目录和 git 上下文。

- **多会话管理** — 多频道并行，每个频道一个独立 Claude Code 进程
- **qdev** — 聊天式快速开发，自动管理分支和 worktree，日常主力工作流
- **Goal Drive** — 大型功能拆解成 DAG 任务图，Orchestrator 自动调度、review、merge
- **全程可追溯** — Discord 频道历史 + SQLite 记录，Claude 做了什么永久留存
- **MCP 工具层** — 12 个 MCP 工具，Claude 在会话内直接操作目标、写任务事件

## 两种开发模式

### `/qdev` — 聊天式，日常主力

使用频率最高的命令。体验和直接和 Claude 聊天几乎一样，区别是自动帮你做了分支隔离：

1. 从当前分支创建 git worktree + feature 分支
2. 在 Discord 开一个专属频道，绑定到这个 worktree
3. Claude 在隔离环境里开发，你在频道里实时对话调整
4. 完成后 `/merge` 合并，频道自动清理

适合：修 bug、加小功能、快速试验。

### `/goal` + Goal Drive — 大型功能，自动编排

针对「Claude 一口气做不完」的大型功能。你描述目标，AI 拆解成任务图，Orchestrator 全程接管：

1. 创建 Goal，设置任务依赖图（手动或 AI 规划）
2. 启动 Drive，自动并行 dispatch 多个子任务（每个子任务本质是一个 qdev）
3. 每个子任务完成后自动 Sonnet review → merge → 解锁下一批
4. 全部完成后做 goal 级别 code audit

适合：跨模块新功能、多文件重构、有明确交付物但步骤复杂的任务。

| | `/qdev` | Goal Drive |
|---|---|---|
| 启动 | 一条命令，秒级 | 先规划任务图 |
| 交互 | 随时对话，高度交互 | 主要在 review 时介入 |
| 规模 | 单个任务（分钟~数小时） | 多子任务并行（数小时~数天） |
| 合并 | 手动 `/merge` | 自动 merge |

## 设计哲学

**Discord 结构即开发结构。** Category = 项目，Channel = Claude Code 会话，Thread = 工具调用展开。这不是巧合——Discord 的层级天然对应开发的组织方式，不需要另造一套 UI 概念。

**完全暴露执行过程。** Claude 的每一次工具调用、每一段 thinking、每一条错误信息都实时出现在 Discord 频道里，没有黑盒。你可以在 Claude 还在跑的时候就看到它在做什么，随时打断、纠正方向，而不是等它跑完再看结果。

**驱动 CLI，而不是重新实现 API。** claude-bot 直接驱动 `claude --output-format stream-json` 进程，把 stdin/stdout 桥接到 Discord。Claude Code 的全部能力（MCP、CLAUDE.md、session compact、hooks）开箱即用，升级 CLI 即可跟上 Anthropic 最新能力。

**SQLite 是唯一的 IPC 总线。** Claude（写）和 Orchestrator（读）通过 `task_events` 表通信，没有直接函数调用。两者完全解耦，任意一方崩溃重启，事件还在数据库里等着。

**全透明、可审查、可回溯。** 原生 Claude Code 跑在 terminal，输出滚过去就消失了。claude-bot 每一层都有持久化：Discord 频道历史（完整对话流）、task_events（状态转换 + review 结论）、goal_timeline（目标审计日志）、claude_sessions（token 用量 + cost）。一周后回来还能看清楚某个功能是怎么做出来的、某次 review 为什么 fail。

**知识沉淀，指导未来的 Claude。** 每次开发产生的经验不应该消失在聊天记录里。claude-bot 内置知识库（KB）和 DevLog：KB 记录架构决策、踩坑经验、API 设计约定；DevLog 记录每次开发的完成情况，可生成日报/周报。Web Dashboard 统一展示项目历史，让后续的 Claude 工作有据可查。

## 和原生 Claude Code / 同类工具的区别

| | 原生 Claude Code | claude-squad | claude-bot |
|---|---|---|---|
| 界面 | Terminal | Terminal / TUI | Discord（任意设备） |
| 并行会话 | 不支持 | 支持（手动管理） | 支持（自动调度） |
| 任务依赖 | 无 | 无 | DAG 依赖图 |
| 完成检测 | 手动 | 手动 | 自动（task_events） |
| 代码合并 | 手动 | 手动 | 自动 |
| 失败处理 | 手动重试 | 手动重启 | 自动 retry / replan |
| 审计追溯 | 无 | 无 | 频道历史 + SQLite 永久留存 |

原生 Claude Code 是锤子，claude-squad 类工具是工具箱，claude-bot 是带流水线的工坊。

## 架构

```
Discord
  ↕
Bot Layer              ← 消息路由、MessageQueue、斜线命令
  ↕
Claude Executor        ← 驱动 claude CLI，解析 stream-json
  ↕
Claude Code CLI        ← 实际的 AI 执行引擎

Goal Orchestrator      ← event-scanner 每 2s 轮询 task_events
  ├── task-scheduler   ← DAG 拓扑排序 + phase 分组
  ├── dispatch         ← 创建 worktree + Discord 频道 + 发送 prompt
  ├── review-handler   ← Sonnet 审查 diff → pass / fail / replan
  └── merge-handler    ← 合并 worktree，清理频道

REST API (:3456)       ← MCP Server + Web Dashboard 后端
MCP Server             ← Claude 会话内访问 Bot 能力的工具集
SQLite (data/bot.db)   ← 唯一持久化层，也是 AI ↔ Orchestrator IPC
```

## 快速开始

**Prerequisites**: Node.js 18+、Claude Code CLI（已登录）、Discord Bot Token

```bash
./config.sh       # 交互式配置
npm start         # 启动
# 在 Discord 中 /login 完成初始化
```

详见 [`docs/env.md`](docs/env.md)（环境变量）、[`docs/architecture.md`](docs/architecture.md)（架构详情）、[`docs/api.md`](docs/api.md)（REST API）。

## 开发 & 部署

```bash
npm run dev           # 开发模式
npm run test          # 运行测试
./deploy.sh deploy    # 生产部署（systemd）
./deploy.sh logs      # 查看日志
```

## Tech Stack

Node.js 18+ / TypeScript 5.9 · discord.js 14 · Claude Code CLI · SQLite (better-sqlite3, WAL) · MCP SDK · React + Vite + Ant Design

## License

Private project
