/**
 * 消息格式化工具
 */

/**
 * 转义 Telegram MarkdownV2 特殊字符
 */
export function escapeMarkdown(text: string): string {
  const specialChars = /[_*\[\]()~`>#+=|{}.!-]/g;
  return text.replace(specialChars, '\\$&');
}

/**
 * 将长消息分段（Telegram 限制 4096 字符）
 */
export function splitMessage(text: string, maxLength: number = 4000): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  const lines = text.split('\n');
  let currentChunk = '';

  for (const line of lines) {
    // 如果单行就超过限制，强制分割
    if (line.length > maxLength) {
      if (currentChunk) {
        chunks.push(currentChunk);
        currentChunk = '';
      }

      // 按字符强制分割长行
      for (let i = 0; i < line.length; i += maxLength) {
        chunks.push(line.substring(i, i + maxLength));
      }
      continue;
    }

    // 检查添加这一行后是否会超过限制
    if (currentChunk.length + line.length + 1 > maxLength) {
      chunks.push(currentChunk);
      currentChunk = line;
    } else {
      currentChunk += (currentChunk ? '\n' : '') + line;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * 格式化代码块
 */
export function formatCodeBlock(code: string, language: string = ''): string {
  return '```' + language + '\n' + code + '\n```';
}

/**
 * 添加消息分段标记
 */
export function addChunkMarker(text: string, index: number, total: number): string {
  if (total <= 1) return text;
  return `[${index + 1}/${total}]\n${text}`;
}
