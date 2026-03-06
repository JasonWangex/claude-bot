# Claude Bot 快速上手指南

从零开始，在你自己的服务器上部署 Claude Bot。

---

## 第一步：准备外部账号和工具

### 1.1 必须准备

#### Discord Bot
1. 访问 [Discord Developer Portal](https://discord.com/developers/applications)
2. 点击右上角 **New Application**，填写名称（如 `claude-bot`）
3. 左侧菜单 → **Bot** → 点击 **Add Bot**
4. 在 Bot 页面：
   - 复制 **Token**（即 `DISCORD_TOKEN`，只显示一次，妥善保存）
   - 开启 **Message Content Intent**（Privileged Gateway Intents 下）
5. 左侧菜单 → **General Information** → 复制 **Application ID**（即 `DISCORD_APPLICATION_ID`）
6. 邀请 Bot 到你的服务器：
   - 左侧 → **OAuth2 → URL Generator**
   - Scopes 勾选：`bot` + `applications.commands`
   - Bot Permissions 勾选：`Administrator`（或按需最小权限）
   - 复制生成的链接，在浏览器打开，选择服务器完成邀请

#### Claude Code CLI

前往官网下载安装：**https://claude.ai/download**

安装完成后登录 Anthropic 账号：
```bash
claude
# 首次运行会引导你登录，完成后 Ctrl+C 退出
```
确认可用：
```bash
claude --version
```

#### Node.js 18+
```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 验证
node -v   # 应显示 v20.x.x
```

#### pnpm（部署工具）
```bash
npm install -g pnpm
```

#### git
```bash
sudo apt-get install -y git   # Ubuntu/Debian
```

### 1.2 可选准备

| 服务 | 用途 | 获取方式 |
|------|------|---------|
| [DeepSeek API](https://platform.deepseek.com/) | 自动生成 git 分支名 | 注册后 → API Keys |
| [Aliyun OSS](https://www.aliyun.com/product/oss) | 大文件上传为签名链接（替代 Discord 附件）| 开通 OSS → 创建 Bucket → 生成 AccessKey |
| [Tailscale](https://tailscale.com/) | 远程访问本地 API | 注册后在服务器和客户端各安装 |

---

## 第二步：准备工作目录

Bot 需要一个**默认工作目录**（Claude 在没有项目上下文时在这里运行），以及一个**项目根目录**（存放你的代码项目）。

推荐目录结构：
```
$HOME/
├── assistant/          ← DEFAULT_WORK_DIR：Claude 的默认工作区
├── projects/           ← PROJECTS_ROOT：所有代码项目
│   ├── claude-bot/     ← 本项目
│   └── worktrees/      ← WORKTREES_DIR：git worktree 临时目录
```

创建目录：
```bash
mkdir -p ~/assistant
mkdir -p ~/projects/worktrees
```

---

## 第三步：克隆项目并配置

```bash
cd ~/projects
git clone <repo-url> claude-bot
cd claude-bot
```

运行交互式配置向导（会逐步引导你填写所有必要信息）：
```bash
./config.sh
```

向导会依次完成：
- ✅ 检查依赖
- ✅ 填写 Discord Token / Application ID / Bot Access Token
- ✅ 设置工作目录路径
- ✅ 配置可选项（DeepSeek、API 端口等）
- ✅ 生成 `.env` 文件（权限 600，仅本用户可读）
- ✅ 安装 npm 依赖
- ✅ 安装 Skills 到 `~/.claude/skills/`
- ✅ 安装 Claude hooks 到 `~/.claude/hooks/`
- ✅ 创建 systemd 服务

> **如果只想重新生成 `.env`**，可以单独运行：`./config.sh env`

---

## 第四步：完整部署

```bash
./deploy.sh deploy
```

这一步会：
1. 安装所有依赖（pnpm install）
2. 安装 Skills 符号链接
3. 编译 MCP Server（TypeScript → `dist-server/`）
4. 构建 Web 看板（`web/` → 静态文件）
5. 安装 systemd 服务文件
6. 注册定时日报（cron，每天 09:00）
7. 安装 Claude hooks 并**自动写入 `~/.claude/settings.json`**
8. 注册 MCP Server 到 `~/.claude.json`
9. 启动所有服务

部署完成后检查服务状态：
```bash
./deploy.sh status
```

---

## 第五步：Discord 服务器初始化

Bot 启动后，在 Discord 服务器的**任意频道**发送：
```
/login <token>
```
`<token>` 是你在 `.env` 中设置的 `BOT_ACCESS_TOKEN`。

完成后 Bot 会自动：
- 将当前服务器 ID 写入 `.env`（`AUTHORIZED_GUILD_ID`）
- 将当前频道设为通知频道（`GENERAL_CHANNEL_ID`）

---

## 第六步：验证配置

```bash
./config.sh verify
```

应该全部显示绿色 `[OK]`。

---

## 基本使用

### 创建第一个开发会话

在 Discord 服务器中，创建一个 **Category**（频道分类），然后在 Bot 所在的 Category 下创建一个文字频道，或者使用斜线命令：

```
/start         # 查看当前状态
/status        # 列出所有活跃 session
```

在任意文字频道直接发消息，Bot 就会用 Claude 响应。

### 快速创建开发任务（qdev）

```
/qdev 实现用户登录功能
```

Bot 会自动创建一个独立的 git worktree + Discord 频道，并在其中启动 Claude 执行任务。

### 管理开发目标（goal）

```
/goal 完成用户认证模块，包含登录、注册、JWT 刷新
```

Bot 会将目标拆分为子任务，并行执行，自动合并结果。

---

## 常用命令速查

```bash
./deploy.sh deploy    # 更新部署（代码更新后运行）
./deploy.sh restart   # 重启服务
./deploy.sh logs      # 实时查看日志
./deploy.sh status    # 查看服务状态
./deploy.sh stop      # 停止服务
```

---

## 遇到问题？

### Bot 没有响应
```bash
# 查看实时日志
./deploy.sh logs

# 检查服务是否在运行
systemctl --user status claude-discord
```

### Claude CLI 认证失败
```bash
# 重新登录
claude
```

### MCP 工具不可用（/goal 等命令失效）
```bash
# 重新编译并注册 MCP
pnpm exec tsc --project tsconfig.json
./deploy.sh deploy
```

### 端口被占用
检查 `.env` 中的 `API_PORT`，修改为其他端口（如 `3457`）后重启：
```bash
./deploy.sh restart
```

---

## 目录说明

```
claude-bot/
├── discord/      # Bot 主程序源码
├── mcp/          # MCP Server（Claude Code 工具集成）
├── web/          # Web 看板（可选）
├── skills/       # Claude Code 本地技能
├── hooks/        # Claude CLI hook 脚本
├── data/         # 数据库和临时文件（自动创建，勿删）
├── config.sh     # 初始化向导
├── deploy.sh     # 部署脚本
└── example.env   # 环境变量模板
```
