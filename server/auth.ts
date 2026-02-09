import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import type { AuthPayload } from './types.js';

const JWT_EXPIRY = '24h';
const BCRYPT_ROUNDS = 12; // 更高的安全性（2^12 = 4096 iterations）

let passwordHash: string | null = null;
let jwtSecret: string = '';

/**
 * 验证密码强度
 * 要求：至少 8 字符，包含大小写字母、数字
 */
function validatePasswordStrength(password: string): { valid: boolean; error?: string } {
  if (password.length < 8) {
    return { valid: false, error: 'Password must be at least 8 characters' };
  }
  if (!/[a-z]/.test(password)) {
    return { valid: false, error: 'Password must contain lowercase letters' };
  }
  if (!/[A-Z]/.test(password)) {
    return { valid: false, error: 'Password must contain uppercase letters' };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, error: 'Password must contain numbers' };
  }
  return { valid: true };
}

export async function initAuth() {
  // JWT secret - 生产环境强制要求安全的 secret
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      console.error('FATAL: JWT_SECRET must be set in production. Exiting.');
      process.exit(1);
    }
    // 开发环境生成随机 secret（每次启动不同，不影响开发）
    jwtSecret = crypto.randomBytes(32).toString('hex');
    console.warn('WARNING: Generated random JWT secret for development. Set JWT_SECRET in .env for persistence.');
  } else if (secret.length < 32) {
    console.error('FATAL: JWT_SECRET must be at least 32 characters. Exiting.');
    process.exit(1);
  } else {
    jwtSecret = secret;
  }

  // Password hash - 验证强度并安全存储
  const password = process.env.PASSWORD;
  if (!password) {
    console.error('FATAL: PASSWORD environment variable is required');
    process.exit(1);
  }

  const validation = validatePasswordStrength(password);
  if (!validation.valid) {
    console.error(`FATAL: Weak password - ${validation.error}`);
    process.exit(1);
  }

  // 使用更高的 bcrypt rounds (12 = 4096 iterations)
  passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  // 立即清除环境变量中的明文密码
  delete process.env.PASSWORD;

  console.log('Auth initialized (bcrypt rounds: ' + BCRYPT_ROUNDS + ')');
}

export async function verifyPassword(password: string): Promise<boolean> {
  if (!passwordHash) return false;
  return bcrypt.compare(password, passwordHash);
}

export function signToken(): string {
  return jwt.sign({}, jwtSecret, { expiresIn: JWT_EXPIRY });
}

export function verifyToken(token: string): AuthPayload | null {
  try {
    return jwt.verify(token, jwtSecret) as AuthPayload;
  } catch {
    return null;
  }
}

// Express middleware
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const token = authHeader.slice(7);
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }
  next();
}
