# Goal 系统问题分析与解决方案

## 问题总结

根据用户反馈和代码审查，Goal 系统存在以下核心问题：

### 1. Audit-Refix 死亡循环 ⚠️ 严重

**现象**：
- 几乎所有任务都会陷入 `审计失败 → 修复 → 再审计失败` 的循环
- 最多重试 2 次后任务被标记为 failed 并 blocked

**根本原因**：
1. **信息丢失严重**：
   - Audit 结果文件包含完整信息：`verdict`, `summary`, `issues`, `verifyCommands`
   - 但 fix prompt 只接收 `issues: string[]`，丢失了 `summary`（Opus 对代码的整体评价）
   - Sonnet 只看到问题列表，无法理解 Opus 的真实意图和审查标准

2. **上下文割裂**：
   - Audit 和 Fix 在同一个 thread 但不同 session
   - Fix prompt 是独立的新对话，没有延续 audit 的推理过程
   - Sonnet 缺少 Opus 审查时的完整思考链

3. **标准可能不一致**：
   - Opus audit 可能过于严格（把 warning 当 error）
   - Sonnet fix 可能理解不充分（无法抓住审查者的关注重点）

**代码位置**：
- `discord/orchestrator/index.ts:1336-1387` - auditFixLoop
- `discord/orchestrator/index.ts:1712-1759` - buildFixPrompt
- `discord/orchestrator/index.ts:1464-1537` - readAuditResult

### 2. Goal 间隔离问题 ⚠️ 中等

**现象**：
- Goal A 会被 Goal B 的任务影响
- 不同 Goal 应该完全独立、互相不感知

**分析**：
1. **Task ID 存储**：
   - 内部存储的 `task.id` 是原始值（"t1", "t2"），不带 goal 前缀
   - 只在显示时通过 `getTaskLabel(state, task.id)` 动态添加前缀（如 "g9t1"）

2. **分支名和 Thread 名**：
   - 已正确使用 `getTaskLabel` 生成（如 `feat/g9t1-xxx`）
   - 这部分隔离是正确的

3. **潜在风险**：
   - 如果某些查询逻辑直接使用 `task.id` 而不是 `getTaskLabel`，可能会混淆不同 goal 的任务
   - 建议：在存储层面就使用全局唯一 ID

**代码位置**：
- `discord/orchestrator/index.ts:93-95` - getTaskLabel
- `discord/orchestrator/index.ts:2674-2679` - generateBranchName

### 3. Opus 与 Sonnet 交互断裂 ⚠️ 严重

**现象**：
- Sonnet 修复多次也无法通过 Opus 审计

**根本原因**（与问题1重叠）：
- **传递的信息过于简化**：
  ```typescript
  // readAuditResult 返回完整信息
  { verdict: 'pass' | 'fail'; issues: string[]; verifyCommands: string[] }

  // 但传递给 buildFixPrompt 时只用了 issues
  buildFixPrompt(task, state, issues, verifyCommands)
  // 丢失了 summary（整体评价）和 audit 的推理过程
  ```

- **缺少反馈回路**：
  - Audit 文件写入后，Fix prompt 应该指引 Sonnet 去读取完整的 audit 文件
  - 或者直接在 prompt 中包含完整的 audit 结果（不仅是 issues）

### 4. 子任务缺少详细计划 ⚠️ 中等

**现象**：
- 子任务执行时缺少完整的计划信息

**分析**：
1. **SKILL.md 中的要求**：
   - 每个子任务应该有：目标、为什么、实现、注意事项
   - 存储在 Goal body 的 markdown 中（如 `### t1: ...`）

2. **当前实现**：
   - 有 `.task-plan.md` 机制（用于复杂任务）
   - 但简单任务可能没有充分利用 Goal body 中的详细计划

3. **改进方向**：
   - Execute prompt 应该从 Goal body 提取对应子任务的详细计划
   - 传递给执行者，避免"闷头写代码"

**代码位置**：
- `skills/goal/SKILL.md:148-209` - 子任务详细计划要求
- `discord/orchestrator/index.ts:2681+` - buildTaskPrompt

## 解决方案优先级

### 🔴 高优先级（立即修复）

1. **修复 audit-fix 上下文传递**（任务 #2）
   - 在 fix prompt 中包含完整的 audit 结果（summary + issues）
   - 或指引 Sonnet 读取 `feedback/<taskId>-audit.json` 完整文件
   - 确保 Sonnet 理解 Opus 的完整审查意图

2. **优化 audit 策略**（任务 #5）
   - 明确 "error" vs "warning" 的标准
   - 强调功能完整性优先于代码完美
   - 避免过度严格的审查

### 🟡 中优先级（短期改进）

3. **为子任务传递详细计划**（任务 #4）
   - 从 Goal body 解析子任务计划
   - 在 execute/audit/fix prompt 中使用

4. **完善 Goal 间隔离**（任务 #3）
   - 考虑在存储层使用全局唯一 ID
   - 审查所有使用 task.id 的代码路径

## 立即行动

建议按顺序执行：
1. 先修复任务 #2（audit-fix 上下文）和任务 #5（audit 策略）—— 这两个是死亡循环的核心原因
2. 再做任务 #4（子任务计划）
3. 最后优化任务 #3（Goal 隔离）

---

**创建时间**: 2026-02-14
**分析者**: Claude Sonnet 4.5
