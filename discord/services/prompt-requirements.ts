/**
 * Prompt 需求注册表
 *
 * 代码中所有使用 prompt 的地方在此声明依赖。
 * 启动时校验这些声明与数据库的匹配性。
 */

import type { PromptRequirement } from './prompt-config-service.js';

export const PROMPT_REQUIREMENTS: PromptRequirement[] = [
  // ================================================================
  // Skill 层
  // ================================================================
  { key: 'skill.goal',   variables: ['SKILL_ARGS', 'THREAD_ID'] },
  { key: 'skill.commit', variables: ['SKILL_ARGS'] },
  { key: 'skill.review', variables: ['SKILL_ARGS'] },
  { key: 'skill.devlog', variables: ['DEVLOG_COMMIT_COUNT', 'DEVLOG_COMMIT_MESSAGES', 'DEVLOG_DIFF_STAT'] },
  { key: 'skill.idea',   variables: ['SKILL_ARGS'] },
  { key: 'skill.kb',     variables: ['SKILL_ARGS'] },
  { key: 'skill.merge',  variables: ['TARGET_TOPIC_ID', 'TARGET_BRANCH', 'TARGET_CWD', 'MAIN_CWD'] },

  // ================================================================
  // Orchestrator 层 — 主模板
  // ================================================================
  { key: 'orchestrator.task',                   variables: ['GOAL_NAME', 'TASK_LABEL', 'TASK_TYPE', 'TASK_DESCRIPTION'] },
  { key: 'orchestrator.plan',                   variables: ['GOAL_NAME', 'TASK_LABEL', 'TASK_DESCRIPTION'] },
  { key: 'orchestrator.execute_with_plan',      variables: ['GOAL_NAME', 'TASK_LABEL', 'TASK_DESCRIPTION'] },
  { key: 'orchestrator.audit',                  variables: ['GOAL_NAME', 'TASK_LABEL', 'TASK_DESCRIPTION'] },
  { key: 'orchestrator.fix',                    variables: ['GOAL_NAME', 'TASK_LABEL', 'TASK_DESCRIPTION'] },
  { key: 'orchestrator.feedback_investigation', variables: ['GOAL_NAME', 'TASK_LABEL', 'TASK_DESCRIPTION', 'FEEDBACK_TYPE', 'FEEDBACK_REASON', 'FEEDBACK_DETAILS', 'DEP_SECTION', 'GOAL_BRANCH', 'TASK_ID'] },
  { key: 'orchestrator.self_review',            variables: ['TASK_LABEL', 'TASK_DESCRIPTION', 'ISSUE_LIST', 'VERIFY_COMMANDS_SECTION', 'TASK_ID'] },
  { key: 'orchestrator.replan',                 variables: ['GOAL_NAME', 'GOAL_BODY', 'COMPLETION_CRITERIA', 'CURRENT_TASKS', 'TRIGGER_TASK_ID', 'FEEDBACK_TYPE', 'FEEDBACK_REASON', 'FEEDBACK_DETAILS', 'COMPLETED_DIFF_STATS', 'IMMUTABLE_COMPLETED', 'IMMUTABLE_RUNNING'] },
  { key: 'orchestrator.conflict_resolver',      variables: ['SUBTASK_BRANCH', 'TASK_DESCRIPTION', 'CONFLICT_FILES'] },

  // Task readiness check (自动检查任务完成状态)
  { key: 'orchestrator.task_readiness_check.execute', variables: ['TASK_DESCRIPTION', 'TASK_ID', 'TASK_LABEL', 'PIPELINE_PHASE'], optional: true },
  { key: 'orchestrator.task_readiness_check.audit',   variables: ['TASK_DESCRIPTION', 'TASK_ID', 'TASK_LABEL', 'PIPELINE_PHASE'], optional: true },

  // ================================================================
  // Orchestrator 层 — Section 子模板（可选）
  // ================================================================

  // task sections
  { key: 'orchestrator.task.detail_plan',       variables: ['DETAIL_PLAN_TEXT'],   optional: true },
  { key: 'orchestrator.task.dependencies',      variables: ['DEP_LIST'],           optional: true },
  { key: 'orchestrator.task.requirements',      variables: [],                     optional: true },
  { key: 'orchestrator.task.feedback_protocol', variables: ['TASK_ID'],            optional: true },
  { key: 'orchestrator.task.research_rules',    variables: ['TASK_ID'],            optional: true },
  { key: 'orchestrator.task.when_to_feedback',  variables: [],                     optional: true },
  { key: 'orchestrator.task.placeholder_rules', variables: [],                     optional: true },

  // plan sections
  { key: 'orchestrator.plan.detail_plan',       variables: ['DETAIL_PLAN_TEXT'],   optional: true },
  { key: 'orchestrator.plan.dependencies',      variables: ['DEP_LIST'],           optional: true },
  { key: 'orchestrator.plan.instructions',      variables: ['TASK_LABEL'],         optional: true },

  // execute_with_plan sections
  { key: 'orchestrator.execute_with_plan.detail_plan',  variables: ['DETAIL_PLAN_TEXT'], optional: true },
  { key: 'orchestrator.execute_with_plan.instructions', variables: ['TASK_ID'],          optional: true },

  // audit sections
  { key: 'orchestrator.audit.detail_plan',      variables: ['DETAIL_PLAN_TEXT'],   optional: true },
  { key: 'orchestrator.audit.instructions',     variables: ['GOAL_BRANCH', 'TASK_ID', 'TASK_LABEL'], optional: true },

  // fix sections
  { key: 'orchestrator.fix.detail_plan',        variables: ['DETAIL_PLAN_TEXT'],   optional: true },
  { key: 'orchestrator.fix.audit_summary',      variables: ['AUDIT_SUMMARY'],      optional: true },
  { key: 'orchestrator.fix.instructions',       variables: ['ISSUE_LIST'],         optional: true },
  { key: 'orchestrator.fix.verify_section',     variables: ['VERIFY_COMMANDS'],    optional: true },
  { key: 'orchestrator.fix.verify_fallback',    variables: [],                     optional: true },
  { key: 'orchestrator.fix.critical_rules',     variables: [],                     optional: true },
];
