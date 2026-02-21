/**
 * Prompt 需求注册表
 *
 * 代码中所有使用 prompt 的地方在此声明依赖。
 * 启动时校验这些声明与数据库的匹配性。
 */

import type { PromptRequirement } from './prompt-config-service.js';

export const PROMPT_REQUIREMENTS: PromptRequirement[] = [
  // ================================================================
  // Orchestrator 层 — 主模板
  // ================================================================
  { key: 'orchestrator.task',                   variables: ['GOAL_NAME', 'TASK_LABEL', 'TASK_TYPE', 'TASK_DESCRIPTION'] },
  { key: 'orchestrator.replan',                 variables: ['GOAL_NAME', 'GOAL_BODY', 'COMPLETION_CRITERIA', 'CURRENT_TASKS', 'TRIGGER_TASK_ID', 'FEEDBACK_TYPE', 'FEEDBACK_REASON', 'FEEDBACK_DETAILS', 'COMPLETED_DIFF_STATS', 'IMMUTABLE_COMPLETED', 'IMMUTABLE_RUNNING'] },
  { key: 'orchestrator.conflict_resolver',      variables: ['SUBTASK_BRANCH', 'TASK_DESCRIPTION', 'CONFLICT_FILES'] },
  { key: 'orchestrator.check_in',               variables: ['TASK_LABEL', 'REVIEW_ISSUES'] },
  { key: 'orchestrator.phase_review',            variables: ['PHASE_NUMBER', 'GOAL_NAME', 'TASK_REVIEW_SUMMARIES', 'PROGRESS_SUMMARY', 'PHASE_TASK_ID'] },

  // ================================================================
  // Orchestrator 层 — Section 子模板（可选）
  // ================================================================

  // task sections
  { key: 'orchestrator.task.detail_plan',       variables: ['DETAIL_PLAN_TEXT'],   optional: true },
  { key: 'orchestrator.task.requirements',      variables: [],                     optional: true },
  { key: 'orchestrator.task.feedback_protocol', variables: ['TASK_ID'],            optional: true },
  { key: 'orchestrator.task.research_rules',    variables: ['TASK_ID'],            optional: true },
  { key: 'orchestrator.task.placeholder_rules', variables: [],                     optional: true },
];
