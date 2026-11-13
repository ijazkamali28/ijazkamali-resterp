import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authenticate } from '../auth/service.js';
import type { AuthContext } from '../auth/context.js';
import { AppError, unauthorized } from '../lib/errors.js';

declare module 'fastify' {
  interface FastifyRequest { auth: AuthContext | null }
  interface FastifyContextConfig { public?: boolean }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every route is authenticated unless it declares config: { public: true }. */
export default fp(async (app: FastifyInstance) => {
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req: FastifyRequest) => {
    if (req.routeOptions.config?.public || !req.routeOptions.url) return;
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized();
    const companyHeader = req.headers['x-company-id'];
    const requestedCompanyId = typeof companyHeader === 'string' && UUID_RE.test(companyHeader) ? companyHeader : undefined;
    req.auth = await authenticate(header.slice(7).trim(), { requestedCompanyId, requestId: String(req.id), ip: req.ip });
    if (req.auth.mustChangePassword && !req.routeOptions.url.includes('/auth/')) {
      throw new AppError(403, 'password_change_required', 'you must change your password before continuing');
    }
  });
});

export function auth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}
