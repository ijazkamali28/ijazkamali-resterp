import type { FastifyInstance } from 'fastify';
import { auth } from '../../plugins/auth.js';
import { NAVIGATION, filterNavigation } from './navigation.js';
import { PERMISSIONS, ROLES } from '../../auth/permissions.js';
import { pool } from '../../db/pool.js';

export default async function metaRoutes(app: FastifyInstance) {
  app.get('/meta/navigation', async (req) => {
    const a = auth(req);
    return { data: filterNavigation(NAVIGATION, (p) => a.can(p)) };
  });

  app.get('/meta/permission-matrix', async (req) => {
    auth(req).require('iam.role.view');
    return {
      roles: ROLES.map((r) => ({ code: r.code, name: r.name, scope: r.scope })),
      permissions: PERMISSIONS.map((p) => ({ ...p, roles: ROLES.filter((r) => r.permissions.includes(p.code)).map((r) => r.code) })),
    };
  });

  app.get('/health/live', { config: { public: true } }, async () => ({ status: 'ok' }));
  app.get('/health/ready', { config: { public: true } }, async (_req, reply) => {
    try {
      const r = await pool.query(`select (select max(version) from public.schema_migrations) as schema_version`);
      return { status: 'ok', schemaVersion: r.rows[0].schema_version };
    } catch {
      reply.code(503);
      return { status: 'unavailable' };
    }
  });
}
