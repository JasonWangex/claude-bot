/**
 * 阿里云 OSS 文件上传工具
 * 可选功能：配置后文件上传到 OSS 并发送签名链接，未配置则静默禁用
 */

import OSS from 'ali-oss';
import { randomBytes } from 'crypto';
import { logger } from './logger.js';

let ossClient: OSS | null = null;

export function initOss(): void {
  const region = process.env.OSS_REGION;
  const bucket = process.env.OSS_BUCKET;
  const accessKeyId = process.env.OSS_ACCESS_KEY_ID;
  const accessKeySecret = process.env.OSS_ACCESS_KEY_SECRET;
  const endpoint = process.env.OSS_ENDPOINT;

  if (!region || !bucket || !accessKeyId || !accessKeySecret) {
    logger.info('OSS not configured, files will be sent as attachments');
    return;
  }

  ossClient = new OSS({
    region,
    bucket,
    accessKeyId,
    accessKeySecret,
    secure: true,
    timeout: 120_000,
    ...(endpoint ? { endpoint } : {}),
  });
  logger.info(`OSS enabled: region=${region}, bucket=${bucket}`);
}

export function isOssEnabled(): boolean {
  return ossClient !== null;
}

const SIGNED_URL_EXPIRES = 86400; // 24 hours

const MAX_UPLOAD_RETRIES = 2;

export async function uploadToOss(content: string, filename: string): Promise<string> {
  if (!ossClient) throw new Error('OSS client not initialized');

  const now = new Date();
  const datePath = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
  const uniqueId = `${Date.now()}-${randomBytes(4).toString('hex')}`;
  const objectKey = `bot-files/${datePath}/${uniqueId}-${filename}`;
  const buffer = Buffer.from(content, 'utf-8');

  const contentType = filename.endsWith('.html')
    ? 'text/html; charset=utf-8'
    : filename.endsWith('.md')
      ? 'text/markdown; charset=utf-8'
      : 'text/plain; charset=utf-8';

  for (let attempt = 0; attempt <= MAX_UPLOAD_RETRIES; attempt++) {
    try {
      await ossClient.put(objectKey, buffer, {
        headers: {
          'Content-Type': contentType,
          'Content-Disposition': `inline; filename="${filename}"`,
        },
      });
      break;
    } catch (err: any) {
      if (attempt < MAX_UPLOAD_RETRIES) {
        logger.warn(`OSS put failed (attempt ${attempt + 1}), retrying: ${err.message}`);
        continue;
      }
      throw err;
    }
  }

  const signedUrl = ossClient.signatureUrl(objectKey, {
    expires: SIGNED_URL_EXPIRES,
    response: { 'content-disposition': `inline; filename="${filename}"` },
  });

  logger.debug(`OSS uploaded: ${objectKey} (${buffer.length} bytes)`);
  return signedUrl;
}
