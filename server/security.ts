import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cors from 'cors';
import type { Express } from 'express';

export function setupSecurity(app: Express) {
  const isDev = process.env.NODE_ENV !== 'production';

  // Helmet security headers - strict in production, relaxed in dev
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: isDev
            ? ["'self'", "'unsafe-inline'", "'unsafe-eval'"]
            : ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          connectSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          fontSrc: ["'self'", 'data:'],
        },
      },
    })
  );

  // CORS
  const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',')
    : ['http://localhost:5173', 'http://localhost:9000', 'http://100.70.48.58:5173', 'http://100.70.48.58:9000'];

  app.use(
    cors({
      origin: allowedOrigins,
      credentials: true,
    })
  );

  // Rate limiting for login
  const loginLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 5,
    message: { error: 'Too many login attempts, please try again later' },
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use('/api/login', loginLimiter);

  // General API rate limiting
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
  });
  app.use('/api/', apiLimiter);
}
