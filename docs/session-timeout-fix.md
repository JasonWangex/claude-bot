# 会话中断问题修复文档

## 问题描述

Telegram Bot 在执行长时间任务时会中途停止，即使任务尚未完成。

## 根本原因

发现了两个导致会话中断的限制：

### 1. 命令执行超时（COMMAND_TIMEOUT）

**位置**: `telegram/claude/executor.ts`

**默认值**: 300000ms (5 分钟)

**问题表现**:
- 任务执行超过 5 分钟后，进程被 SIGTERM 强制终止
- 用户看到错误提示或任务突然停止
- 日志中出现 "Process timeout after 300000ms"

**影响范围**:
- 复杂的代码搜索和分析任务
- 大型项目的文件批量操作
- 需要多次迭代的重构任务

### 2. 最大轮次限制（MAX_TURNS）

**位置**: `telegram/utils/config.ts`

**默认值**: 20 轮

**问题表现**:
- Claude 执行到第 20 轮时自动停止
- 即使任务明显未完成，也会强制结束
- 返回 result 事件，num_turns = 20

**什么是一轮（turn）**:

一轮 = 用户消息 → Claude 思考 → 工具调用 → 工具结果 → 下一轮

典型任务的轮次消耗：
```
复杂重构任务示例：
轮 1-3:   搜索和定位相关文件 (Glob, Grep)
轮 4-10:  读取和分析代码 (Read × 7)
轮 11-15: 编辑多个文件 (Edit × 5)
轮 16-18: 运行测试和验证 (Bash × 3)
轮 19-20: 分析结果和总结
→ 20 轮用完，任务被迫中断 ❌
```

## 解决方案

### 已应用的修复

在 `.env` 文件中添加了以下配置：

```bash
# Claude CLI 配置
# 命令执行超时（毫秒）- 30分钟
COMMAND_TIMEOUT=1800000

# 最大执行轮次 - 80轮足以应对大多数复杂任务
MAX_TURNS=80
```

### 配置说明

#### COMMAND_TIMEOUT（命令超时）

- **默认**: 300000 (5分钟)
- **推荐**: 1800000 (30分钟)
- **特殊场景**: 3600000 (60分钟) 或更长
- **禁用超时**: 设为 0（不推荐，可能导致僵死进程无法终止）

#### MAX_TURNS（最大轮次）

- **默认**: 20 轮
- **推荐**: 50-100 轮
- **当前设置**: 80 轮
- **特殊场景**: 150+ 轮（大型项目迁移等）

### 如何应用修复

1. **重启 Telegram Bot**:
   ```bash
   # 如果使用 pm2
   pm2 restart telegram

   # 或者直接重启
   npm run start
   ```

2. **验证配置生效**:
   ```bash
   # 查看运行中的 Claude 进程参数
   ps aux | grep "claude --" | grep -v grep

   # 应该看到: --max-turns 80
   ```

3. **测试长时间任务**:
   - 执行一个需要多步操作的任务
   - 观察是否能完整执行（不会在 5 分钟或 20 轮时中断）

## 监控和调优

### 如何判断需要调整配置

#### 超时问题的迹象：
- 任务在固定时间点（5分钟、30分钟等）停止
- 日志中出现 "Process timeout"
- 进程被 SIGTERM 终止

**解决**: 增加 `COMMAND_TIMEOUT`

#### 轮次限制的迹象：
- result 事件中 `num_turns` = MAX_TURNS 设置值
- 任务明显未完成但返回了结果
- Claude 的回复像是"话说到一半就停了"

**解决**: 增加 `MAX_TURNS`

### 性能考虑

**过大的配置值的风险**:
- `COMMAND_TIMEOUT` 过大：僵死任务难以终止
- `MAX_TURNS` 过大：
  - Token 消耗增加
  - 成本上升
  - 可能触发 context length 限制

**建议**:
- 先使用推荐值（TIMEOUT=30分钟, TURNS=80）
- 根据实际使用情况调整
- 对于已知的特定长任务，可以临时调高

## 技术细节

### 超时机制实现

```typescript
// telegram/claude/executor.ts:207-217
if (this.commandTimeout > 0) {
  const timeoutHandle = setTimeout(() => {
    logger.warn(`Process timeout after ${this.commandTimeout}ms`);
    flags.killed = true;
    child.kill('SIGTERM');
    const killTimer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 5000);
  }, this.commandTimeout);
}
```

超时触发后：
1. 发送 SIGTERM（优雅终止）
2. 等待 5 秒
3. 如果进程仍未退出，发送 SIGKILL（强制终止）

### 轮次限制实现

```typescript
// 传递给 Claude CLI
args.push('--max-turns', String(options.maxTurns));
```

```bash
# 实际命令
claude --max-turns 80 --output-format stream-json ...
```

Claude CLI 在达到最大轮次时会自动停止 agentic loop，返回当前状态作为最终结果。

## 历史记录

- **2025-02-09**: 发现并修复会话中断问题
  - 添加 `COMMAND_TIMEOUT=1800000` (30分钟)
  - 添加 `MAX_TURNS=80`
  - 更新 `prd.env`, `dev.env`, `env.example`
