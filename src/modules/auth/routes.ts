import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { login, logout, changePassword } from '../../auth/service.js';
import { auth } from '../../plugins/auth.js';
import { withTx } from '../../db/pool.js';
import { config } from '../../config.js';

const loginBody = z.object({
  email: z.string().email().max(254).transform((s) => s.toLowerCase()),
  password: z.string().min(1).max(200),
  deviceId: z.string().uuid().optional(),
  deviceSecret: z.string().max(200).optional(),
}).strict();

export default async function authRoutes(app: FastifyInstance) {
  app.post('/auth/login', {
    config: {
      public: true,
      rateLimit: {
        max: config.LOGIN_RATE_LIMIT_PER_MINUTE, timeWindow: '1 minute', hook: 'preHandler',
        keyGenerator: (req: any) => `${req.ip}:${String(req.body?.email ?? '').toLowerCase()}`,
      },
    },
  }, async (req) => {
    const body = loginBody.parse(req.body);
    return login({ ...body, ip: req.ip, userAgent: req.headers['user-agent'] });
  });

  app.post('/auth/logout', async (req, reply) => {
    await logout(auth(req));
    reply.code(204);
  });

  app.get('/auth/me', async (req) => {
    const a = auth(req);
    const user = await withTx(a.db(), (tx) => tx.query(
      `select id, email, full_name, company_id, default_branch_id, locale, must_change_password, last_login_at from iam.users where id = $1`,
      [a.userId]).then((r) => r.rows[0]));
    const branches = await withTx(a.db(), (tx) => tx.query(`select id, code, name, status from org.branches order by code`).then((r) => r.rows));
    return {
      user,
      companyId: a.companyId,
      isPlatformAdmin: a.isPlatformAdmin,
      deviceId: a.deviceId,
      branches,
      grants: a.grants.map((g) => ({ role: g.roleCode, branchId: g.branchId })),
      permissions: [...a.permissions].sort(),
    };
  });

  app.post('/auth/change-password', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(1).max(200) }).strict().parse(req.body);
    await changePassword(auth(req), body.currentPassword, body.newPassword);
    reply.code(204);
  });
}
