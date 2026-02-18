/**
 * 轻量 LLM 调用模块 — DeepSeek API（OpenAI 兼容格式）
 *
 * 用于简单的单轮文本生成（如分支名翻译），不适合多轮对话。
 * 环境变量:
 *   DEEPSEEK_API_KEY  — 必需，缺失时返回 null
 *   DEEPSEEK_BASE_URL — 可选，默认 https://api.deepseek.com
 */

import { logger } from './logger.js';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_TIMEOUT = 10_000;

interface ChatOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeout?: number;
}

/**
 * 单轮聊天补全，失败自动重试一次
 * @returns 生成的文本，API key 缺失或调用失败返回 null
 */
export async function chatCompletion(
  prompt: string,
  options: ChatOptions = {},
): Promise<string | null> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    logger.debug('[LLM] DEEPSEEK_API_KEY not set, skipping');
    return null;
  }

  const baseUrl = (process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const url = `${baseUrl}/v1/chat/completions`;
  const body = JSON.stringify({
    model: options.model || DEFAULT_MODEL,
    max_tokens: options.maxTokens ?? 64,
    temperature: options.temperature ?? 0.3,
    messages: [{ role: 'user', content: prompt }],
  });
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body,
        signal: AbortSignal.timeout(timeout),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      const data = await res.json() as any;
      const content = data.choices?.[0]?.message?.content?.trim();
      if (content) return content;
      throw new Error('Empty response from API');
    } catch (err: any) {
      if (attempt === 0) {
        logger.warn(`[LLM] Attempt 1 failed, retrying: ${err.message}`);
        continue;
      }
      logger.warn(`[LLM] Attempt 2 failed, giving up: ${err.message}`);
      return null;
    }
  }
  return null;
}

/**
 * 从描述生成简短中文 Topic 标题（≤20字）
 * 失败时截取描述前 20 字符作为 fallback
 */
export async function generateTopicTitle(description: string): Promise<string> {
  const fallback = description.slice(0, 20);
  const result = await chatCompletion(
    `将以下内容压缩为一个简短的中文标题（不超过20字，只输出标题，不要任何其他内容）:\n${description}`,
  );
  return result?.slice(0, 20) || fallback;
}

/**
 * 从会话的第一条用户消息生成 session title
 *
 * 格式: [type] 简短中文描述
 * type: fix / feat / chat / explore / plan / refactor / debug / docs / config
 *
 * 失败时 fallback 为截取消息前 40 字符
 */
export async function generateSessionTitle(firstUserMessage: string): Promise<string> {
  const fallback = `[chat] ${firstUserMessage.replace(/^#\s+/, '').slice(0, 40)}`;
  const result = await chatCompletion(
    `根据以下用户消息，生成一个简短的会话标题。

格式要求：[type] 简短中文描述（描述部分不超过20字）
type 必须是以下之一：fix, feat, chat, explore, plan, refactor, debug, docs, config
- fix: 修复bug
- feat: 新功能开发
- chat: 普通对话/问答
- explore: 代码探索/调研
- plan: 规划/设计
- refactor: 重构
- debug: 调试排查
- docs: 文档相关
- config: 配置/环境相关

只输出标题，不要任何其他内容。

用户消息:
${firstUserMessage.slice(0, 500)}`,
  );
  if (result) {
    // 验证格式 [type] xxx
    const match = result.match(/^\[(\w+)\]\s+(.+)/);
    if (match) return result.slice(0, 50);
  }
  return fallback;
}
