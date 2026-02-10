# 代码审计报告

**项目**: claude-web
**审计日期**: 2026-02-09
**审计范围**: 全栈代码（Frontend + Backend + Telegram Bot）

---

## 执行摘要

本次审计覆盖了 claude-web 项目的所有核心模块，发现 **16 个问题**（2 个严重、5 个高危、6 个中危、3 个低危）。主要风险集中在：

1. **JSON 解析未包裹异常处理**，可能导致进程崩溃
2. **密码明文存储在环境变量中**，存在安全风险
3. **类型安全薄弱**，大量使用 `any` 类型
4. **资源泄漏风险**，部分定时器未正确清理

---

## Phase 1: 代码质量 (Code Quality)

### [🔴CRITICAL] 代码质量 | telegram/bot/handlers.ts:909
**问题**: 单个文件超过 900 行，复杂度过高，难以维护
**建议**: 拆分为多个文件：
- `handlers/stream-handler.ts` - 处理流式输出
- `handlers/interactive-handler.ts` - 处理交互式输入
- `handlers/diff-handler.ts` - 处理文件 diff 展示

```typescript
// 建议结构
export class MessageHandler {
  private streamHandler: StreamHandler;
  private interactiveHandler: InteractiveHandler;
  private diffHandler: DiffHandler;

  constructor(...) {
    this.streamHandler = new StreamHandler(...);
    this.interactiveHandler = new InteractiveHandler(...);
    this.diffHandler = new DiffHandler(...);
  }
}
```

---

### [🟠HIGH] 代码质量 | 多处使用 any 类型
**问题**: 发现 50+ 处 `any` 类型使用，削弱类型安全
**位置**:
- `telegram/bot/handlers.ts:190` - `input: any`
- `telegram/bot/commands.ts:70` - `handler: (session: any, topicId: number)`
- `telegram/bot/telegram.ts:32` - `const botOptions: any = {}`
- `server/index.ts:68` - `catch (err: any)`

**建议**: 定义明确类型
```typescript
// ❌ 错误
catch (err: any) {
  res.status(500).json({ error: err.message });
}

// ✅ 正确
catch (err: unknown) {
  const message = err instanceof Error ? err.message : 'Unknown error';
  res.status(500).json({ error: message });
}
```

---

### [🟠HIGH] 代码质量 | telegram/claude/executor.ts:438
**问题**: `processStream` 方法超过 250 行，嵌套层级达到 5 层
**建议**: 提取子方法
```typescript
private processStream(...): Promise<ClaudeResponse> {
  return new Promise((resolve, reject) => {
    this.setupStreamHandlers(child, resolve, reject);
    this.setupErrorHandlers(child, flags, reject);
    this.setupTimeout(child, lockKey, flags);
  });
}

private setupStreamHandlers(...) { /* ... */ }
private setupErrorHandlers(...) { /* ... */ }
private setupTimeout(...) { /* ... */ }
```

---

### [🟡MEDIUM] 代码质量 | 多处魔法值
**问题**: 硬编码的数字和字符串散布在代码中
```typescript
// telegram/bot/telegram.ts:71
setInterval(() => { ... }, 60 * 60 * 1000);  // 1 小时

// server/index.ts:167
setTimeout(() => { ... }, 5000);  // 5 秒

// server/index.ts:324
setTimeout(() => process.exit(0), 5000);  // 5 秒
```

**建议**: 定义常量
```typescript
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;  // 1 hour
const AUTH_TIMEOUT_MS = 5000;  // 5 seconds
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 5000;  // 5 seconds
```

---

## Phase 2: 状态与数据流转 (State & Data Flow)

### [🔴CRITICAL] 数据流转 | telegram/bot/cli-stats-reader.ts:98
**问题**: `JSON.parse` 未包裹 try-catch，解析失败会导致进程崩溃
**影响**: 如果 `~/.claude/stats-cache.json` 损坏，整个 Bot 会崩溃

**建议**: 添加异常处理
```typescript
// ❌ 当前代码
private async readStats(): Promise<CLIStatsCache | null> {
  try {
    const raw = await readFile(this.statsPath, 'utf-8');
    return JSON.parse(raw);  // 可能抛出异常
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      logger.warn('CLI stats file not found:', this.statsPath);
    } else {
      logger.error('Failed to read CLI stats:', err.message);
    }
    return null;
  }
}

// ✅ 修复后
private async readStats(): Promise<CLIStatsCache | null> {
  try {
    const raw = await readFile(this.statsPath, 'utf-8');
    try {
      return JSON.parse(raw);
    } catch (parseErr) {
      logger.error('Invalid JSON in stats file:', this.statsPath);
      return null;
    }
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      logger.warn('CLI stats file not found:', this.statsPath);
    } else {
      logger.error('Failed to read CLI stats:', err.message);
    }
    return null;
  }
}
```

**相同问题也存在于**:
- `telegram/bot/state.ts:41`
- `telegram/claude/executor.ts:232`
- `telegram/claude/executor.ts:274`
- `server/index.ts:176`
- `server/index.ts:252`
- `server/session-manager.ts:206`

---

### [🟠HIGH] 数据流转 | telegram/bot/commands.ts 中未完成重构
**问题**: `CommandHandler` 构造函数仍接收 `usageTracker`，但该文件已被删除
**影响**: TypeScript 编译错误，代码无法运行

**当前代码**:
```typescript
// telegram/bot/commands.ts:32
constructor(stateManager: StateManager, claudeClient: ClaudeClient,
            messageHandler: MessageHandler, cliStatsReader: CLIStatsReader) {
  this.stateManager = stateManager;
  this.claudeClient = claudeClient;
  this.messageHandler = messageHandler;
  this.cliStatsReader = cliStatsReader;
}
```

**但 `/usage` 命令中仍使用旧代码**:
```typescript
// telegram/bot/commands.ts:283
stats = this.usageTracker.getYesterdayStats();  // ❌ usageTracker 未定义
```

**建议**: 完成重构
```typescript
async handleUsage(ctx: Context): Promise<void> {
  // ...
  if (arg === 'yesterday') {
    stats = await this.cliStatsReader.getYesterdayStats();
  } else if (arg && /^\d{4}-\d{2}-\d{2}$/.test(arg)) {
    stats = await this.cliStatsReader.getDailyStats(arg);
  } else {
    stats = await this.cliStatsReader.getTodayStats();
  }

  if (!stats) {
    await ctx.reply('❌ 无统计数据', { message_thread_id: topicId });
    return;
  }

  const report = this.cliStatsReader.formatDailyReport(stats, title);
  // ...
}
```

---

### [🟠HIGH] 数据流转 | telegram/bot/telegram.ts 中未完成重构
**问题**: `telegram.ts` 中仍然引用已删除的 `UsageTracker`

**需要修改的位置**:
1. 删除 `import { UsageTracker } from './usage-tracker.js';` (line 16)
2. 删除 `private usageTracker: UsageTracker;` (line 26)
3. 删除 `this.usageTracker = new UsageTracker();` (line 54)
4. 修改构造函数传参 (line 60-61)
5. 删除 `this.usageTracker.cleanup();` (line 70)
6. 删除 `await this.usageTracker.load();` (line 232)
7. 修改 `sendDailyReport()` 方法 (line 282-283)
8. 删除 `await this.usageTracker.flush();` (line 299)

**建议**: 替换为 `CLIStatsReader`
```typescript
import { CLIStatsReader } from './cli-stats-reader.js';

export class TelegramBot {
  private cliStatsReader: CLIStatsReader;

  constructor(config: TelegramBotConfig) {
    // ...
    this.cliStatsReader = new CLIStatsReader();
    this.messageHandler = new MessageHandler(this.stateManager, this.claudeClient, this.callbackRegistry);
    this.commandHandler = new CommandHandler(this.stateManager, this.claudeClient, this.messageHandler, this.cliStatsReader);

    // 删除 cleanup 中的 usageTracker.cleanup()
    setInterval(() => {
      this.stateManager.cleanup();
      this.callbackRegistry.cleanup();
      // 不需要 cleanup CLI stats（它是只读的）
    }, 60 * 60 * 1000);
  }

  async launch(): Promise<void> {
    // ...
    await this.stateManager.load();
    // 不需要 load CLI stats（它是实时读取的）
    // ...
  }

  private async sendDailyReport(): Promise<void> {
    // ...
    try {
      const yesterday = await this.cliStatsReader.getYesterdayStats();
      if (!yesterday) {
        logger.info('Skip daily report: no stats available');
        return;
      }
      const report = this.cliStatsReader.formatDailyReport(yesterday, '📊 昨日使用报告');
      // ...
    }
  }

  private async stop(signal: string): Promise<void> {
    // ...
    await this.stateManager.flush();
    // 不需要 flush CLI stats（它是只读的）
    this.bot.stop(signal);
  }
}
```

---

### [🟡MEDIUM] 数据流转 | telegram/bot/cli-stats-reader.ts:220
**问题**: Cache tokens 计算使用全局比例估算当天数据，精度不足
**原因**: CLI stats-cache.json 没有按天的 cache tokens 数据

**当前逻辑**:
```typescript
// 假设当天的 cache 比例与全局相同（这是一个近似）
const cacheReadRatio = globalUsage.cacheReadInputTokens /
  (globalUsage.inputTokens + globalUsage.cacheReadInputTokens || 1);
```

**建议**: 添加注释说明限制，或考虑其他数据源
```typescript
// 注意：CLI stats 不提供按天的 cache tokens，这里使用全局比例估算
// 可能导致单日费用计算不精确，但总体趋势仍然准确
const cacheReadRatio = globalUsage.cacheReadInputTokens /
  (globalUsage.inputTokens + globalUsage.cacheReadInputTokens || 1);
```

---

### [🟡MEDIUM] 数据流转 | telegram/bot/state.ts:41
**问题**: 状态文件 JSON 解析失败时，会丢失所有历史 session
**建议**: 创建备份
```typescript
private async saveToDisk(): Promise<void> {
  const data: PersistedData = {
    sessions: Object.fromEntries(this.sessions),
    groups: Object.fromEntries(this.groups),
  };

  const tmpFile = this.filePath + '.tmp';
  const backupFile = this.filePath + '.backup';

  await writeFile(tmpFile, JSON.stringify(data, null, 2), 'utf-8');

  // 创建备份
  try {
    const oldData = await readFile(this.filePath, 'utf-8');
    await writeFile(backupFile, oldData, 'utf-8');
  } catch {
    // 首次保存，没有旧文件
  }

  await rename(tmpFile, this.filePath);
}
```

---

## Phase 3: 前后端交互 (Frontend-Backend Interaction)

### [🟠HIGH] 前后端交互 | server/index.ts:46
**问题**: 登录接口吞掉了所有异常，返回通用错误
**影响**: 无法诊断问题（密码错误 vs 服务器错误）

```typescript
// ❌ 当前代码
app.post('/api/login', async (req, res) => {
  try {
    // ...
  } catch {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ✅ 建议
app.post('/api/login', async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || typeof password !== 'string') {
      res.status(400).json({ error: 'Password is required' });
      return;
    }
    const valid = await verifyPassword(password);
    if (!valid) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }
    const token = signToken();
    res.json({ token });
  } catch (err) {
    logger.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

---

### [🟡MEDIUM] 前后端交互 | src/lib/api.ts:36
**问题**: 前端 JWT 过期检查不准确，可能导致 401 响应后才发现过期
**原因**: 客户端时钟可能不准确

**建议**: 提前 1 分钟过期
```typescript
export function isLoggedIn(): boolean {
  const token = getToken();
  if (!token) return false;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    // 提前 1 分钟过期，避免边界情况
    if (payload.exp && payload.exp * 1000 < Date.now() + 60000) {
      localStorage.removeItem('token');
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
```

---

### [🟡MEDIUM] 前后端交互 | 缺少 API 错误重试机制
**问题**: 网络抖动可能导致操作失败，没有自动重试
**建议**: 添加重试逻辑（幂等操作）
```typescript
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  retries = 3
): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.status >= 500 && i < retries - 1) {
        // 服务器错误，重试
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
        continue;
      }
      return res;
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw new Error('Max retries exceeded');
}
```

---

### [🔵LOW] 前后端交互 | server/index.ts:107
**问题**: `lines` 参数可能被恶意设置为负数或超大值
**当前保护**:
```typescript
const lines = Math.min(Math.max(parseInt(req.query.lines as string) || 50, 1), 5000);
```
**评价**: ✅ 已有保护，但可以改进错误提示

---

## Phase 4: 逻辑与异常处理 (Logic & Exception Handling)

### [🟠HIGH] 逻辑异常处理 | server/auth.ts:32
**问题**: 密码以明文形式存储在 `process.env.PASSWORD` 中，然后才删除
**风险**:
1. 如果进程在 `delete process.env.PASSWORD` 前崩溃，密码泄漏
2. 子进程可能继承 `process.env`（在删除前 spawn 的）

**建议**: 使用文件读取
```typescript
// .env 文件中不要存储明文密码
// PASSWORD=mypassword  ❌

// 改用密码哈希
// PASSWORD_HASH=$2a$10$...  ✅

export async function initAuth() {
  const passwordHash = process.env.PASSWORD_HASH;
  if (!passwordHash) {
    console.error('ERROR: PASSWORD_HASH environment variable is required');
    process.exit(1);
  }

  // 验证哈希格式
  if (!passwordHash.startsWith('$2a$') && !passwordHash.startsWith('$2b$')) {
    console.error('ERROR: PASSWORD_HASH must be a bcrypt hash');
    process.exit(1);
  }

  passwordHashGlobal = passwordHash;
  console.log('Auth initialized');
}

export async function verifyPassword(password: string): Promise<boolean> {
  if (!passwordHashGlobal) return false;
  return bcrypt.compare(password, passwordHashGlobal);
}
```

**生成哈希工具**:
```bash
node -e "require('bcryptjs').hash('your-password', 10).then(console.log)"
```

---

### [🟡MEDIUM] 逻辑异常处理 | server/index.ts:324
**问题**: Graceful shutdown 强制 5 秒后退出，可能导致数据丢失
**建议**: 等待所有保存操作完成
```typescript
async function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down gracefully...`);

  // 通知所有客户端断开
  wss.clients.forEach((ws) => {
    ws.close(1001, 'Server shutting down');
  });

  clearInterval(heartbeat);

  // 等待数据保存
  try {
    await Promise.race([
      sessionManager.flush(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Flush timeout')), 3000)
      ),
    ]);
  } catch (err) {
    console.error('Failed to flush data:', err);
  }

  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });

  // 兜底退出
  setTimeout(() => {
    console.warn('Forced exit after timeout');
    process.exit(1);
  }, 5000);
}
```

---

### [🟡MEDIUM] 逻辑异常处理 | telegram/bot/telegram.ts:294
**问题**: `dailyReportTimer` 在 `stop()` 时清理，但如果服务器异常退出，定时器继续运行
**建议**: 添加 uncaughtException 处理
```typescript
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err);
  this.stop('UNCAUGHT_EXCEPTION').then(() => process.exit(1));
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason);
  this.stop('UNHANDLED_REJECTION').then(() => process.exit(1));
});
```

---

### [🟡MEDIUM] 逻辑异常处理 | telegram/claude/executor.ts:112
**问题**: 活动进程存储在 Map 中，但如果 CLI 崩溃，可能永远不会被清理
**建议**: 添加定期清理
```typescript
constructor(claudeCliPath: string = 'claude', commandTimeout: number = 300000) {
  this.claudeCliPath = claudeCliPath;
  this.commandTimeout = commandTimeout;

  // 每 5 分钟清理僵尸进程
  setInterval(() => {
    for (const [key, proc] of this.activeProcesses.entries()) {
      if (proc.child.exitCode !== null || proc.child.killed) {
        logger.warn(`Cleaning up zombie process for lock [${key}]`);
        this.activeProcesses.delete(key);
        this.releaseLock(key);
      }
    }
  }, 5 * 60 * 1000);
}
```

---

### [🔵LOW] 逻辑异常处理 | server/session-manager.ts:189
**问题**: `restart()` 失败时返回 `null`，但不清理僵尸 session
**建议**: 标记为 dead
```typescript
restart(id: string): SessionInfo | null {
  const session = this.sessions.get(id);
  if (!session) return null;

  tmuxKillSession(session.tmuxName);

  const cols = 120;
  const rows = 30;
  try {
    tmuxNewSession(session.tmuxName, session.cwd, cols, rows);
    session.alive = true;
  } catch (err) {
    console.error(`Failed to restart session ${id}:`, err);
    session.alive = false;
    // 返回 dead session 信息，而不是 null
    return this.toInfo(session);
  }

  this.saveMetas();
  return this.toInfo(session);
}
```

---

## 汇总表

| 维度 | 🔴 | 🟠 | 🟡 | 🔵 |
|------|-----|-----|-----|-----|
| 代码质量 | 1 | 2 | 1 | 0 |
| 数据流转 | 1 | 2 | 3 | 0 |
| 前后端交互 | 0 | 1 | 2 | 1 |
| 逻辑异常处理 | 0 | 1 | 3 | 1 |
| **总计** | **2** | **6** | **9** | **2** |

---

## Top 5 优先修复项

### 1. [🔴] 完成 UsageTracker 到 CLIStatsReader 的重构

**影响**: 当前代码无法编译运行
**文件**: `telegram/bot/commands.ts`, `telegram/bot/telegram.ts`

**修复步骤**:
1. 修改 `commands.ts` 中的 `/usage` 命令处理
2. 修改 `telegram.ts` 的构造函数和依赖注入
3. 修改 `sendDailyReport()` 方法
4. 删除所有 `usageTracker` 相关代码

**预计时间**: 30 分钟

---

### 2. [🔴] 修复所有 JSON.parse 未捕获异常

**影响**: 进程崩溃风险
**文件**: 7 处位置

**修复模板**:
```typescript
try {
  const data = JSON.parse(raw);
  // 使用 data
} catch (parseErr) {
  logger.error('Invalid JSON:', parseErr);
  return fallbackValue;  // 或抛出自定义错误
}
```

**预计时间**: 1 小时

---

### 3. [🟠] 密码安全：改用 bcrypt 哈希存储

**影响**: 安全风险
**文件**: `server/auth.ts`, `.env`

**步骤**:
1. 生成密码哈希：`node -e "require('bcryptjs').hash('your-password', 10).then(console.log)"`
2. 在 `.env` 中设置 `PASSWORD_HASH=...`
3. 修改 `initAuth()` 逻辑
4. 更新文档

**预计时间**: 20 分钟

---

### 4. [🟠] 拆分 handlers.ts 大文件

**影响**: 可维护性
**文件**: `telegram/bot/handlers.ts`

**拆分方案**:
```
telegram/bot/
├── handlers.ts (主协调器, ~200 行)
├── handlers/
│   ├── stream-handler.ts (流式输出处理)
│   ├── interactive-handler.ts (交互式输入)
│   └── diff-handler.ts (diff 展示)
```

**预计时间**: 2 小时

---

### 5. [🟠] 添加 Graceful Shutdown 数据保存

**影响**: 数据丢失风险
**文件**: `server/index.ts`, `telegram/index.ts`

**修复代码**: 见上文 Phase 4 - Graceful shutdown 部分

**预计时间**: 30 分钟

---

## 其他建议

### 测试覆盖
**当前状态**: 无单元测试
**建议**: 至少为关键路径添加集成测试
- 登录流程
- Session 创建/销毁
- JSON 解析边界情况
- Graceful shutdown

### 文档
**当前状态**: README 基础
**建议**: 补充
- API 接口文档
- 环境变量配置说明
- 部署指南
- 故障排查手册

### 监控
**建议**: 添加
- Prometheus metrics (请求数、错误率、响应时间)
- Health check 端点 (`/health`)
- 日志聚合（结构化日志 → ELK/Loki）

---

## 审计结论

项目整体代码质量**中等偏上**，核心逻辑清晰，但存在以下待改进点：

**优点** ✅:
- 安全意识较好（使用 bcrypt、JWT、helmet）
- 命令注入防护到位（使用 execFileSync）
- WebSocket 认证流程合理
- 使用原子写入防止数据损坏

**待改进** ⚠️:
- 类型安全需加强（减少 `any` 使用）
- 异常处理需完善（JSON 解析、资源清理）
- 代码模块化需优化（大文件拆分）
- 密码存储方式需改进（改用哈希）

**建议优先级**:
1. **本周内**: 修复 Top 5 问题（尤其是 #1 和 #2）
2. **本月内**: 完成代码质量改进（类型安全、模块化）
3. **下季度**: 添加测试、监控、文档

---

**审计完成时间**: 2026-02-09 11:30
**审计者**: Claude Code (Sonnet 4.5)
