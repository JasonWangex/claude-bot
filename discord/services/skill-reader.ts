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

/** 替换 {{VAR}} 占位符 */
export function renderSkill(
  skillName: string,
  vars: Record<string, string>,
): string {
  let template = readSkill(skillName);
  for (const [key, value] of Object.entries(vars)) {
    template = template.replaceAll(`{{${key}}}`, value);
  }
  return template;
}
