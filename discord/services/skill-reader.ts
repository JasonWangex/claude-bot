import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** 读取 SKILL.md 并剥离 frontmatter */
export function readSkill(skillName: string): string {
  const raw = readFileSync(
    join(homedir(), '.claude/skills', skillName, 'SKILL.md'), 'utf-8',
  );
  const match = raw.match(/^---[\s\S]*?---\s*([\s\S]*)$/);
  return match ? match[1] : raw;
}

/**
 * 替换模板变量。
 * - {{KEY}} — bot 专用模板语法（如 {{THREAD_ID}}）
 * - $KEY — Claude Code 原生 skill 语法（如 $ARGUMENTS），仅在模板中无 {{KEY}} 时使用
 */
export function renderSkill(
  skillName: string,
  vars: Record<string, string>,
): string {
  let template = readSkill(skillName);
  for (const [key, value] of Object.entries(vars)) {
    if (template.includes(`{{${key}}}`)) {
      template = template.replaceAll(`{{${key}}}`, value);
    } else {
      template = template.replaceAll(`$${key}`, value);
    }
  }
  return template;
}
