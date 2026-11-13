import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTx } from '../../db/pool.js';
import { auth } from '../../plugins/auth.js';
import { idParam } from '../../lib/crud.js';
import { notFound, badRequest } from '../../lib/errors.js';
import { newToken, sha256 } from '../../lib/password.js';
import { writeAudit } from '../../lib/audit.js';
import { uuidv7 } from '../../lib/uuid.js';

export default async function syncRoutes(app: FastifyInstance) {
  /** Register a POS terminal / KDS screen / waiter device. The secret is returned once and only its hash is stored. */
  app.post('/sync/devices', async (req, reply) => {
    const a = auth(req);
    const companyId = a.requireCompany();
    const b = z.object({
      branchId: z.string().uuid(), code: z.string().trim().min(2).max(30).regex(/^[A-Za-z0-9_-]+$/),
      name: z.string().trim().min(2).max(80),
      deviceType: z.enum(['pos_terminal', 'kds_screen', 'waiter_device', 'rider_device', 'kiosk', 'printer_bridge', 'back_office']),
      fingerprint: z.string().max(200).optional(), appVersion: z.string().max(40).optional(),
    }).strict().parse(req.body);
    a.require('sync.device.register', b.branchId);
    const id = uuidv7();
    const secret = newToken(32);
    await withTx(a.db(), async (tx) => {
      // branch must be visible to this user (RLS) - other tenants' branches look non-existent
      if (!(await tx.query('select 1 from org.branches where id = $1', [b.branchId])).rowCount) throw notFound('branch not found');
      return tx.query(
      `insert into sync.devices(id, company_id, branch_id, code, name, device_type, fingerprint, app_version, secret_hash, registered_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, companyId, b.branchId, b.code, b.name, b.deviceType, b.fingerprint ?? null, b.appVersion ?? null, sha256(secret), a.userId]);
    });
    reply.code(201);
    return { id, status: 'pending', deviceSecret: secret, note: 'store the secret in the device keystore; it is not retrievable again' };
  });

  app.get('/sync/devices', async (req) => {
    const a = auth(req);
    const { branchId } = z.object({ branchId: z.string().uuid().optional() }).parse(req.query);
    a.require('sync.status.view', branchId);
    const rows = await withTx(a.db(), (tx) => tx.query(
      `select id, branch_id, code, name, device_type, status, last_seen_at, app_version, approved_at, created_at, row_version
         from sync.devices where ($1::uuid is null or branch_id = $1) order by branch_id, code`, [branchId ?? null]).then((r) => r.rows));
    return { data: rows.filter((d) => a.can('sync.status.view', d.branch_id)) };
  });

  for (const [action, status] of [['approve', 'active'], ['block', 'blocked'], ['retire', 'retired']] as const) {
    app.post(`/sync/devices/:id/${action}`, async (req) => {
      const a = auth(req);
      const { id } = idParam.parse(req.params);
      const { reason } = z.object({ reason: z.string().max(300).optional() }).strict().parse(req.body ?? {});
      return withTx(a.db({ reasonText: reason }), async (tx) => {
        const d = (await tx.query('select * from sync.devices where id = $1 for update', [id])).rows[0];
        if (!d) throw notFound('device not found');
        a.require('sync.device.approve', d.branch_id);
        if (d.status === 'retired') throw badRequest('retired devices cannot change status');
        const r = await tx.query(
          `update sync.devices set status = $2, approved_by = case when $2 = 'active' then $3::uuid else approved_by end,
             approved_at = case when $2 = 'active' then now() else approved_at end where id = $1
           returning id, status, approved_at`, [id, status, a.userId]);
        if (status !== 'active') {
          await tx.query(`update iam.sessions set revoked_at = now(), revoke_reason = 'device_${status}' where device_id = $1 and revoked_at is null`, [id]);
        }
        await writeAudit(tx, { action: `sync.device.${action}`, companyId: a.companyId, branchId: d.branch_id, userId: a.userId, entityTable: 'sync.devices', entityId: id, reasonText: reason, ip: a.ip });
        return r.rows[0];
      });
    });
  }

  /** Data for the offline/sync indicators shown on every screen. */
  app.get('/sync/status', async (req) => {
    const a = auth(req);
    a.require('sync.status.view');
    return withTx(a.db(), async (tx) => {
      const node = (await tx.query('select node_id, node_type, branch_id from sync.local_node')).rows[0] ?? null;
      const outbox = (await tx.query(
        `select count(*) filter (where status = 'pending') pending, count(*) filter (where status = 'failed') failed,
                count(*) filter (where status = 'dead') dead, min(created_at) filter (where status in ('pending','failed')) oldest_pending_at
           from sync.outbox`)).rows[0];
      const checkpoints = (await tx.query('select peer_node_id, direction, last_success_at, last_error, updated_at from sync.checkpoints order by direction')).rows;
      const conflicts = (await tx.query(`select count(*) n from sync.conflicts where status = 'open'`)).rows[0];
      const lastSuccess = checkpoints.map((c) => c.last_success_at).filter(Boolean).sort().at(-1) ?? null;
      return {
        node,
        branchServerConnected: true,                     // this response came from the node itself
        cloudConnected: node?.node_type === 'cloud' ? true : checkpoints.some((c) => c.last_success_at && Date.now() - new Date(c.last_success_at).getTime() < 120_000),
        pendingEvents: Number(outbox.pending), failedEvents: Number(outbox.failed), deadEvents: Number(outbox.dead),
        oldestPendingAt: outbox.oldest_pending_at, openConflicts: Number(conflicts.n), lastSuccessfulSync: lastSuccess, checkpoints,
      };
    });
  });
}
