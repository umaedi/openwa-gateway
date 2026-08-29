import { INestApplication } from '@nestjs/common';
import helmet from 'helmet';
import { Request, Response, NextFunction, json, urlencoded } from 'express';
import { randomBytes } from 'crypto';
import { createInflightBodyBudget, resolveInflightBodyBudgetBytes } from './config/inflight-body-budget';
import { requestContextMiddleware } from './common/middleware/request-context.middleware';
import { resolveCorsPolicy, isUpgradeInsecureRequestsEnabled, resolveBodyLimit } from './config/bootstrap-security';

export interface AppliedBodyCaps {
  bodyLimit: string;
  inflightBudgetBytes: number;
}

export function configureApp(app: INestApplication): AppliedBodyCaps {
  const inflightBudgetBytes = resolveInflightBodyBudgetBytes(
    process.env.INFLIGHT_BODY_BUDGET_BYTES,
    process.env.BODY_SIZE_LIMIT,
  );
  app.use(
    createInflightBodyBudget(inflightBudgetBytes, {
      trustedProxies: (process.env.TRUSTED_PROXIES || '')
        .split(',')
        .map(p => p.trim())
        .filter(Boolean),
    }).middleware,
  );

  const bodyLimit = resolveBodyLimit(process.env.BODY_SIZE_LIMIT);
  app.use(
    json({
      limit: bodyLimit,
      inflate: false,
      verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use(
    urlencoded({
      extended: true,
      limit: bodyLimit,
      inflate: false,
      verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );

  app.use(requestContextMiddleware);

  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.locals.cspNonce = randomBytes(18).toString('base64url');
    next();
  });

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
          mediaSrc: ["'self'", 'data:', 'blob:', 'https:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          upgradeInsecureRequests: isUpgradeInsecureRequestsEnabled(
            process.env.CSP_UPGRADE_INSECURE_REQUESTS,
            process.env.NODE_ENV,
          )
            ? []
            : null,
        },
      },
      hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true,
      },
      noSniff: true,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  const corsPolicy = resolveCorsPolicy(process.env.CORS_ORIGINS, process.env.NODE_ENV);
  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      if (!origin) return callback(null, true);
      if (corsPolicy.allowAnyOrigin || corsPolicy.origins.includes(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    credentials: corsPolicy.credentials,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-API-Key', 'Authorization', 'X-Request-ID'],
    exposedHeaders: [
      'X-RateLimit-Limit-short',
      'X-RateLimit-Remaining-short',
      'X-RateLimit-Reset-short',
      'X-RateLimit-Limit-medium',
      'X-RateLimit-Remaining-medium',
      'X-RateLimit-Reset-medium',
      'X-RateLimit-Limit-long',
      'X-RateLimit-Remaining-long',
      'X-RateLimit-Reset-long',
      'Retry-After-short',
      'Retry-After-medium',
      'Retry-After-long',
    ],
    maxAge: 86400,
  });

  return { bodyLimit, inflightBudgetBytes };
}
