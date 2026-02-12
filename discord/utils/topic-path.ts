/**
 * Topic 工作目录路径推导工具
 */

import { stat, mkdir } from 'fs/promises';
import { join, resolve, isAbsolute } from 'path';

/**
 * 将 Topic 名称标准化为目录名
 *
 * @param name - Topic 名称
 * @param strategy - 命名策略
 * @returns 标准化后的目录名
 */
export function normalizeTopicName(
  name: string,
  strategy: 'kebab-case' | 'snake_case' | 'original'
): string {
  // 移除前后空格
  let normalized = name.trim();

  // 替换路径分隔符和特殊字符
  normalized = normalized.replace(/[\/\\:*?"<>|]/g, '-');

  // 根据策略转换
  switch (strategy) {
    case 'kebab-case':
      // 将空格和下划线转为连字符，转为小写
      normalized = normalized
        .replace(/[\s_]+/g, '-')
        .toLowerCase()
        .replace(/--+/g, '-')  // 多个连字符合并为一个
        .replace(/^-|-$/g, ''); // 移除首尾连字符
      break;

    case 'snake_case':
      // 将空格和连字符转为下划线，转为小写
      normalized = normalized
        .replace(/[\s-]+/g, '_')
        .toLowerCase()
        .replace(/__+/g, '_')  // 多个下划线合并为一个
        .replace(/^_|_$/g, ''); // 移除首尾下划线
      break;

    case 'original':
      // 保持原样，只替换非法字符
      normalized = normalized.replace(/\s+/g, '-');
      break;
  }

  // 确保不为空
  if (!normalized) {
    normalized = 'untitled';
  }

  return normalized;
}

/**
 * 检查目录是否存在
 *
 * @param path - 目录路径
 * @returns 如果存在且为目录返回 true
 */
async function directoryExists(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * 确保项目目录存在
 *
 * @param path - 目录路径
 * @param autoCreate - 是否自动创建
 * @returns { exists: 是否存在, created: 是否新创建 }
 */
export async function ensureProjectDir(
  path: string,
  autoCreate: boolean
): Promise<{ exists: boolean; created: boolean }> {
  const exists = await directoryExists(path);

  if (exists) {
    return { exists: true, created: false };
  }

  if (!autoCreate) {
    return { exists: false, created: false };
  }

  try {
    await mkdir(path, { recursive: true });
    return { exists: true, created: true };
  } catch (error: any) {
    throw new Error(`无法创建目录 ${path}: ${error.message}`);
  }
}

/**
 * 解析 Topic 工作目录路径
 * 如果目录已被占用，自动添加后缀 -2, -3 等
 *
 * @param topicName - Topic 名称
 * @param projectsRoot - 项目根目录
 * @param strategy - 命名策略
 * @param occupiedPaths - 已被其他 Topic 占用的路径集合（可选）
 * @returns 解析后的工作目录路径
 */
export async function resolveTopicWorkDir(
  topicName: string,
  projectsRoot: string,
  strategy: 'kebab-case' | 'snake_case' | 'original',
  occupiedPaths?: Set<string>
): Promise<string> {
  const normalized = normalizeTopicName(topicName, strategy);
  let basePath = join(projectsRoot, normalized);

  // 检查路径是否被占用
  const isOccupied = async (path: string): Promise<boolean> => {
    // 如果提供了占用路径集合，先检查
    if (occupiedPaths && occupiedPaths.has(path)) {
      return true;
    }
    // 检查目录是否存在（存在即视为被占用）
    return await directoryExists(path);
  };

  // 如果未被占用，直接返回
  if (!(await isOccupied(basePath))) {
    return basePath;
  }

  // 被占用，尝试添加后缀
  let suffix = 2;
  let candidatePath = `${basePath}-${suffix}`;

  while (await isOccupied(candidatePath)) {
    suffix++;
    candidatePath = `${basePath}-${suffix}`;

    // 防止无限循环（最多尝试 100 次）
    if (suffix > 100) {
      throw new Error(`无法为 Topic "${topicName}" 找到可用的工作目录路径`);
    }
  }

  return candidatePath;
}

/**
 * 验证并解析用户提供的自定义路径
 * 防止路径穿越：解析后的路径必须在 allowedRoot 下
 *
 * @param customPath - 用户提供的路径
 * @param baseCwd - 当前工作目录（用于解析相对路径）
 * @param allowedRoot - 允许的根目录（可选，不传则不限制）
 * @returns 解析后的绝对路径
 */
export function resolveCustomPath(customPath: string, baseCwd: string, allowedRoot?: string): string {
  const resolved = isAbsolute(customPath) ? resolve(customPath) : resolve(baseCwd, customPath);

  if (allowedRoot) {
    const normalizedRoot = resolve(allowedRoot);
    if (!resolved.startsWith(normalizedRoot + '/') && resolved !== normalizedRoot) {
      throw new Error(`Path "${customPath}" is outside allowed directory`);
    }
  }

  return resolved;
}
