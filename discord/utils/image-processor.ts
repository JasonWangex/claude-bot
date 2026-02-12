/**
 * 图片下载与压缩处理
 * 从 Discord CDN URL 下载图片，使用 sharp 压缩后返回 base64 编码数据
 */

import sharp from 'sharp';
import { logger } from './logger.js';

export interface ImageAttachment {
  data: string;        // base64 encoded
  mediaType: string;   // image/jpeg | image/png
}

// Claude 推荐的最佳图片尺寸（超过此尺寸会被 API 内部缩放，浪费传输带宽）
const MAX_DIMENSION = 1568;
const JPEG_QUALITY = 80;
// 小图片阈值：低于此大小且尺寸合适的 PNG 不转换格式
const SMALL_IMAGE_BYTES = 200 * 1024;

/**
 * 从 URL 下载图片并压缩处理
 * - 超过 MAX_DIMENSION 的图片按比例缩放
 * - 大图片转为 JPEG 压缩
 * - 小尺寸 PNG 保持原格式
 */
export async function downloadAndProcessImage(
  fileUrl: string,
): Promise<ImageAttachment> {
  // 下载图片
  const response = await fetch(fileUrl);
  if (!response.ok) {
    throw new Error(`下载图片失败: HTTP ${response.status}`);
  }
  const rawBuffer = Buffer.from(await response.arrayBuffer());
  logger.debug(`Image downloaded: ${rawBuffer.length} bytes`);

  // 获取元数据
  const metadata = await sharp(rawBuffer).metadata();
  const { width = 0, height = 0, format } = metadata;

  const needsResize = width > MAX_DIMENSION || height > MAX_DIMENSION;
  const isSmallPng = format === 'png' && rawBuffer.length < SMALL_IMAGE_BYTES && !needsResize;

  if (isSmallPng) {
    // 小 PNG（截图等）保持原格式，不压缩
    logger.debug(`Image kept as PNG: ${width}x${height}, ${rawBuffer.length} bytes`);
    return {
      data: rawBuffer.toString('base64'),
      mediaType: 'image/png',
    };
  }

  // 压缩处理：缩放 + 转 JPEG
  let pipeline = sharp(rawBuffer);
  if (needsResize) {
    pipeline = pipeline.resize(MAX_DIMENSION, MAX_DIMENSION, {
      fit: 'inside',
      withoutEnlargement: true,
    });
  }
  const outputBuffer = await pipeline.jpeg({ quality: JPEG_QUALITY }).toBuffer();

  logger.debug(`Image compressed: ${width}x${height} → JPEG ${outputBuffer.length} bytes`);
  return {
    data: outputBuffer.toString('base64'),
    mediaType: 'image/jpeg',
  };
}
