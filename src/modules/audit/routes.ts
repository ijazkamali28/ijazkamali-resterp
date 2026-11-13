import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTx } from '../../db/pool.js';
import { auth } from '../../plugins/auth.js';

const q = z.object({
  from: z.string().datetime().optional(), to: z.string().datetime().optional(),
  action: z.string().max(80).optional(), userId: z.string().uuid().optional(), branchId: z.string().uuid().optional(),
  entityTable: z.string().max(80).optional(), entityId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0),
});

export default async function auditRoutes(app: FastifyInstance) {
  app.get('/audit/logs', async (req) => {
    const a = auth(req);
    const f = q.parse(req.query);
    a.require('audit.log.view', f.branchId);
    const rows = await withTx(a.db(), (tx) => tx.query(
      `select l.*, u.full_name as user_name from audit.audit_log l left join iam.users u on u.id = l.user_id
        where ($1::timestamptz is null or l.occurred_at >= $1) and ($2::timestamptz is null or l.occurred_at < $2)
          and ($3::text is null or l.action like $3 || '%') and ($4::uuid is null or l.user_id = $4)
          and ($5::uuid is null or l.branch_id = $5) and ($6::text is null or l.entity_table = $6) and ($7::uuid is null or l.entity_id = $7)
          and ($8::boolean or l.branch_id = any($9::uuid[]))
        order by l.occurred_at desc limit $10 offset $11`,
      [f.from ?? null, f.to ?? null, f.action ?? null, f.userId ?? null, f.branchId ?? null, f.entityTable ?? null, f.entityId ?? null,
       a.allBranches, a.branchIds, f.limit, f.offset]).then((r) => r.rows));
    return { data: rows };
  });

  /** Source document -> every inventory, journal, payment and loyalty posting it produced. */
  app.get('/audit/trace/:docType/:docId', async (req) => {
    const a = auth(req);
    const p = z.object({ docType: z.string().regex(/^[a-z_]+\.[a-z_]+$/), docId: z.string().uuid() }).parse(req.params);
    a.require('audit.log.view');
    const rows = await withTx(a.db(), (tx) => tx.query(
      `select * from audit.v_document_trace where source_doc_type = $1 and source_doc_id = $2 order by posted_at`, [p.docType, p.docId]).then((r) => r.rows));
    return { data: rows };
  });
}
