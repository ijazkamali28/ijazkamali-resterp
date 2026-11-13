import Fastify, { type FastifyError } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { config } from './config.js';
import authPlugin from './plugins/auth.js';
import { AppError, fromPgError } from './lib/errors.js';
import { uuidv7 } from './lib/uuid.js';
import authRoutes from './modules/auth/routes.js';
import orgRoutes from './modules/org/routes.js';
import iamRoutes from './modules/iam/routes.js';
import auditRoutes from './modules/audit/routes.js';
import syncRoutes from './modules/sync/routes.js';
import metaRoutes from './modules/meta/routes.js';
import consoleRoutes from './modules/meta/console.js';

export async function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger === false ? false : {
      level: config.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.body.password', 'req.body.newPassword', 'req.body.currentPassword', 'req.body.deviceSecret'],
    },
    genReqId: () => uuidv7(),
    trustProxy: true,
    bodyLimit: 1_048_576,
  });

  await app.register(helmet);
  await app.register(cors, { origin: config.CORS_ORIGINS ? config.CORS_ORIGINS.split(',') : false, credentials: false });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(authPlugin);

  app.setErrorHandler((err: FastifyError | AppError | ZodError | any, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'validation_failed', message: 'request validation failed',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    const appErr = err instanceof AppError ? err : fromPgError(err);
    if (appErr) {
      if (appErr.statusCode >= 500) req.log.error(err);
      return reply.code(appErr.statusCode).send({ error: appErr.code, message: appErr.message, details: appErr.details });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: err.code ?? 'request_error', message: err.message });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error', message: 'an unexpected error occurred', requestId: req.id });
  });

  await app.register(async (api) => {
    await api.register(authRoutes);
    await api.register(orgRoutes);
    await api.register(iamRoutes);
    await api.register(auditRoutes);
    await api.register(syncRoutes);
    await api.register(metaRoutes);
  }, { prefix: '/api/v1' });
  await app.register(consoleRoutes);

  return app;
}
