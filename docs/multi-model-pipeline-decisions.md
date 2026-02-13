# 多模型流水线 — 决策记录

> 2026-02-13 讨论记录，聚焦"为什么这么做"和"为什么不那么做"

## 核心决策：决策和执行分离

**为什么**：所有任务用 Opus 导致账单爆炸。Opus 的核心优势在推理深度和架构决策，不在逐行写代码。就像工程团队里架构师出方案、工程师写代码、架构师 review。

**模型分工**：
- 调研/规划/审核 → Opus（需要自主决策和深度推理）
- 代码执行 → Sonnet（按图索骥，够用且便宜）

---

## 为什么调研用 Opus 而不是 Sonnet？

最初考虑过"调研是搜索总结，Sonnet 够用"。但调研任务的价值在于**做出判断和推荐**，不只是收集信息。调研结果直接影响后续任务的拆解和方向（通过 replan feedback），需要 Opus 级别的推理能力。

## 为什么用独立 session 而不是同 session 切模型？

调研发现 Claude Code CLI 支持 `--resume <session_id> --model sonnet` 无损切模型（对话历史完整保留）。甚至有原生的 `opusplan` 别名。

**但放弃了这个方案**，原因是成本：
- 切模型时 prompt cache 失效（跨模型不共享 cache）
- 整个对话历史以新模型全价重新计费（$5/M 而非 cached $0.50/M）
- Opus audit 阶段会把 Opus plan + Sonnet execute 的全部历史以 $5/M 重新吃一遍

**独立 session 更省**：每个 phase 只带最小上下文。Plan 文件就是"压缩后的上下文桥梁"——架构师不需要把全部思考过程复制给工程师，一份清晰的技术方案就够了。

## 为什么不用 Effort Level？

调研了 Opus 4.6 的 effort level（low/medium/high/max）：
- medium effort 的 Opus ≈ Sonnet 的 SWE-bench 分数，输出 token 减少 76%
- 看起来很诱人，但**只支持 Opus**，Sonnet/Haiku 不支持

所以 effort level 不能替代模型选择。它是"Opus 内部的省钱旋钮"，可以叠加使用（比如 audit 用 Opus medium），但不是主方案。暂不实现，留作后续优化。

## 为什么不学 Claude Flow 的 Swarm 模式？

调研了 Claude Flow（13.4k stars）。它把 87+ MCP 工具交给 Claude，让 LLM 自己编排。

**放弃原因**：
- 编排质量完全取决于 LLM 推理，不可预测、不可调试
- 没有显式 DAG/Phase 依赖管理
- 实际用户反馈差（Issue #958：无法让它真正工作）
- 我们的确定性代码调度（DAG + Phase + 拓扑排序）更可靠

**借鉴了**：三层模型路由的思路（贵模型做决策、便宜模型做执行）。

## 为什么复杂度在 Goal 创建时标注？

考虑过两个时机：
1. Goal 创建时由 Opus 标注（选择）
2. Dispatch 时用 Opus 快速评估

**选择创建时**：拆任务时 Opus 已经在做深度分析，顺便标注复杂度成本为零。Dispatch 时评估需要额外一次 API 调用。

**默认 simple**：不确定时标 simple。宁可让 Sonnet 尝试执行失败后由 audit 捕获，也不要所有任务都走 complex 浪费 Opus plan 成本。

## 为什么 Audit 失败后让 Sonnet 修复而不是直接升级 Opus？

三个选项：Sonnet 修复 / 直接 Opus / 标记失败等人工。

**选择 Sonnet 修复（≤2 次）**：
- Audit 失败通常是具体的 bug 或遗漏，Opus 会提供明确的修复指令
- Sonnet 按指令修复这类问题绑绑有余，不需要 Opus 级别的推理
- 最多 2 次重试控制成本，避免无限循环
- 仍然失败则标记 failed 等人工（兜底）

## 为什么 audit 结果默认 pass？

如果 Opus audit session 没有写出 verdict 文件（正常退出但没留下问题），默认 pass。理由：Opus 没有主动报告问题 = 没发现问题。假阳性 failure 比假阳性 pass 的危害更大（会触发不必要的重试循环和成本浪费）。
