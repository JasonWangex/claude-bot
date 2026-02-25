// 根据项目名自动生成稳定的 Tag 颜色，同一项目始终返回相同颜色
const PROJECT_COLORS = [
  'blue',
  'purple',
  'cyan',
  'green',
  'magenta',
  'volcano',
  'gold',
  'geekblue',
  'lime',
  'orange',
];

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function getProjectColor(project: string | null | undefined): string {
  if (!project) return 'default';
  return PROJECT_COLORS[hashString(project) % PROJECT_COLORS.length];
}
