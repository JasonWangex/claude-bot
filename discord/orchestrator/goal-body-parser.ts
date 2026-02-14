/**
 * Goal Body Parser
 *
 * 从 Goal body markdown 中提取子任务详细计划
 *
 * 格式规范（来自 SKILL.md）：
 *
 * ### t1: 功能点描述
 *
 * **目标**: 一句话说明要做什么。
 *
 * **为什么**: 解释设计意图和选择原因，帮助执行者理解上下文。
 *
 * **实现**:
 * - 新增/修改的文件清单
 * - 关键数据结构和接口定义
 * - 核心逻辑要点
 *
 * **注意事项**:
 * - 可选的特殊说明
 */

export interface TaskDetailPlan {
  taskId: string;
  goal?: string;           // 目标
  why?: string;            // 为什么（设计意图）
  implementation?: string; // 实现
  notes?: string;          // 注意事项
  rawSection: string;      // 原始 section 文本（完整内容）
}

/**
 * 从 Goal body markdown 中解析子任务详细计划
 *
 * @param body Goal body markdown 文本
 * @returns Map<taskId, TaskDetailPlan>
 */
export function parseTaskDetailPlans(body: string | null): Map<string, TaskDetailPlan> {
  const plans = new Map<string, TaskDetailPlan>();
  if (!body) return plans;

  // 匹配 ### tX: 标题 到下一个 ### 或 ## 或文件末尾
  // 使用 dotAll (s flag) 让 . 匹配换行符
  const sectionRegex = /###\s+(t\d+):\s*[^\n]*\n([\s\S]*?)(?=\n###|\n##|$)/g;

  let match;
  while ((match = sectionRegex.exec(body)) !== null) {
    const taskId = match[1];
    const rawSection = match[0];
    const sectionContent = match[2];

    const plan: TaskDetailPlan = { taskId, rawSection };

    // 提取各字段（使用正则匹配 **目标**: 、**为什么**: 等）
    // 允许中文冒号或英文冒号，允许可选空格
    const goalMatch = sectionContent.match(/\*\*目标\*\*\s*[:：]\s*([^\n]+)/);
    if (goalMatch) plan.goal = goalMatch[1].trim();

    const whyMatch = sectionContent.match(/\*\*为什么\*\*\s*[:：]\s*([\s\S]*?)(?=\n\*\*|$)/);
    if (whyMatch) plan.why = whyMatch[1].trim();

    const implMatch = sectionContent.match(/\*\*实现\*\*\s*[:：]\s*([\s\S]*?)(?=\n\*\*|$)/);
    if (implMatch) plan.implementation = implMatch[1].trim();

    const notesMatch = sectionContent.match(/\*\*注意事项\*\*\s*[:：]\s*([\s\S]*?)(?=\n\*\*|$)/);
    if (notesMatch) plan.notes = notesMatch[1].trim();

    plans.set(taskId, plan);
  }

  return plans;
}

/**
 * 将 TaskDetailPlan 格式化为适合注入 prompt 的文本
 *
 * @param plan 任务详细计划
 * @returns 格式化的 markdown 文本
 */
export function formatDetailPlanForPrompt(plan: TaskDetailPlan): string {
  const lines: string[] = [`## Detailed Plan from Goal`];

  if (plan.goal) {
    lines.push(``, `**Goal**: ${plan.goal}`);
  }

  if (plan.why) {
    lines.push(``, `**Why (Design Intent)**: ${plan.why}`);
  }

  if (plan.implementation) {
    lines.push(``, `**Implementation**: ${plan.implementation}`);
  }

  if (plan.notes) {
    lines.push(``, `**Notes**: ${plan.notes}`);
  }

  return lines.join('\n');
}
