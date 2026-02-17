-- Seed script: Task Readiness Check Prompts
-- 插入任务完成自检的 prompt 模板

-- Execute 阶段的自检 prompt
INSERT OR REPLACE INTO prompt_configs (
  key,
  category,
  name,
  description,
  template,
  variables,
  parent_key,
  sort_order,
  created_at,
  updated_at
) VALUES (
  'orchestrator.task_readiness_check.execute',
  'orchestrator',
  'Task Readiness Check - Execute Phase',
  '任务完成自检（Execute 阶段）- 检查任务是否完成、自审是否通过、代码是否提交',
  '**任务完成自查**

当前任务: {{TASK_DESCRIPTION}}
任务标签: {{TASK_LABEL}}
阶段: {{PIPELINE_PHASE}}

请回答以下问题（用 yes/no 格式）：

1. 任务是否完成？（所有需求都已实现）
2. 自我审查是否通过？（代码质量符合标准，无明显问题）
3. 代码是否已提交？（已 git commit）

请按以下格式回答：
```
1. yes/no
2. yes/no
3. yes/no
```

如果有任何一项为 no，请说明原因并继续完成工作。',
  '["TASK_DESCRIPTION", "TASK_ID", "TASK_LABEL", "PIPELINE_PHASE"]',
  NULL,
  0,
  strftime('%s', 'now') * 1000,
  strftime('%s', 'now') * 1000
);

-- Audit 阶段的自检 prompt
INSERT OR REPLACE INTO prompt_configs (
  key,
  category,
  name,
  description,
  template,
  variables,
  parent_key,
  sort_order,
  created_at,
  updated_at
) VALUES (
  'orchestrator.task_readiness_check.audit',
  'orchestrator',
  'Task Readiness Check - Audit Phase',
  '任务完成自检（Audit 阶段）- 检查 audit 建议是否修复、代码是否提交、是否准备 merge',
  '**Audit 阶段完成检查**

当前任务: {{TASK_DESCRIPTION}}
任务标签: {{TASK_LABEL}}

Audit 阶段已完成，请确认：

1. 所有 audit 建议都已修复？
2. 代码已更新并提交？
3. 是否准备好 merge？

请按以下格式回答：
```
1. yes/no
2. yes/no
3. yes/no
```

如果有任何一项为 no，请说明原因并继续完成工作。',
  '["TASK_DESCRIPTION", "TASK_ID", "TASK_LABEL", "PIPELINE_PHASE"]',
  NULL,
  0,
  strftime('%s', 'now') * 1000,
  strftime('%s', 'now') * 1000
);
