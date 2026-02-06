import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import type { Request, Response, NextFunction } from 'express';
import type { AuthPayload } from './types.js';

const JWT_EXPIRY = '24h';

let passwordHash: string | null = null;

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret === 'change-me-to-a-random-secret') {
    if (process.env.NODE_ENV === 'production') {
      console.error('FATAL: JWT_SECRET must be set in production. Exiting.');
      process.exit(1);
    }
    console.warn('WARNING: Using default JWT secret. Set JWT_SECRET in .env for production.');
    return 'claude-web-default-secret-change-me';
  }
  return secret;
}

export async function initAuth() {
  const password = process.env.PASSWORD;
  if (!password) {
    console.error('ERROR: PASSWORD environment variable is required');
    process.exit(1);
  }
  passwordHash = await bcrypt.hash(password, 10);
  console.log('Auth initialized');
}

export async function verifyPassword(password: string): Promise<boolean> {
  if (!passwordHash) return false;
  return bcrypt.compare(password, passwordHash);
}

export function signToken(): string {
  return jwt.sign({}, getJwtSecret(), { expiresIn: JWT_EXPIRY });
}

export function verifyToken(token: string): AuthPayload | null {
  try {
    return jwt.verify(token, getJwtSecret()) as AuthPayload;
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
