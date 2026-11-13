/**
 * Reusable CRUD route factory for master-data tables.
 *  - server-side validation with zod (unknown fields rejected)
 *  - permission checks (branch-aware for branch-scoped tables)
 *  - RLS enforced by the database for tenant/branch isolation
 *  - optimistic concurrency via row_version
 *  - no physical deletes: records are activated/deactivated
 */
import type { FastifyInstance } from 'fastify';
import { z, type ZodObject, type ZodRawShape } from 'zod';
import { withTx } from '../db/pool.js';
import { auth } from '../plugins/auth.js';
import { badRequest, conflict, notFound } from './errors.js';
import { uuidv7 } from './uuid.js';

export interface CrudOptions {
  table: string;                       // schema.table
  path: string;                        // e.g. /org/branches
  viewPermission: string;
  managePermission: string;
  create: ZodObject<ZodRawShape>;
  update: ZodObject<ZodRawShape>;
  branchScoped?: boolean;              // row has branch_id
  branchIsId?: boolean;                // the table IS org.branches
  searchColumns?: string[];
  orderBy?: string;
  statusValues?: [string, string];     // [active, inactive]
  hiddenColumns?: string[];
  customCreate?: boolean;              // POST handled by a bespoke route
}

export const ident = (s: string) => s.split('.').map((p) => `"${p.replace(/"/g, '')}"`).join('.');
export const toSnake = (k: string) => k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase());
const isJson = (v: unknown) => v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v);
const dbValue = (v: unknown) => (isJson(v) ? JSON.stringify(v) : v);

export const idParam = z.object({ id: z.string().uuid() });

export const listQuery = z.object({
  q: z.string().max(100).optional(),
  status: z.string().max(20).optional(),
  branchId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export function registerCrud(app: FastifyInstance, o: CrudOptions) {
  const table = ident(o.table);
  const [active, inactive] = o.statusValues ?? ['active', 'inactive'];
  const hidden = new Set(o.hiddenColumns ?? []);
  const strip = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([k]) => !hidden.has(k) && k !== '_total'));
  const rowBranch = (row: any): string | null => (o.branchIsId ? row.id : o.branchScoped ? row.branch_id : null);

  app.get(o.path, async (req) => {
    const a = auth(req);
    const q = listQuery.parse(req.query);
    a.require(o.viewPermission, q.branchId);
    const where: string[] = []; const params: unknown[] = [];
    if (q.q && o.searchColumns?.length) {
      params.push(`%${q.q}%`);
      where.push('(' + o.searchColumns.map((c) => `${ident(c)}::text ilike $${params.length}`).join(' or ') + ')');
    }
    if (q.status) { params.push(q.status); where.push(`status = $${params.length}`); }
    if (q.branchId && (o.branchScoped || o.branchIsId)) { params.push(q.branchId); where.push(`${o.branchIsId ? 'id' : 'branch_id'} = $${params.length}`); }
    params.push(q.limit, q.offset);
    const sql = `select *, count(*) over() as _total from ${table} ${where.length ? 'where ' + where.join(' and ') : ''}
                 order by ${o.orderBy ?? 'code'} limit $${params.length - 1} offset $${params.length}`;
    const rows = await withTx(a.db(), (tx) => tx.query(sql, params).then((r) => r.rows));
    // branch-scoped lists only return branches where the user actually holds the view permission
    const visible = o.branchScoped || o.branchIsId ? rows.filter((r) => a.can(o.viewPermission, rowBranch(r))) : rows;
    return { data: visible.map(strip), total: rows[0] ? Number(rows[0]._total) : 0, limit: q.limit, offset: q.offset };
  });

  app.get(`${o.path}/:id`, async (req) => {
    const a = auth(req);
    const { id } = idParam.parse(req.params);
    const row = await withTx(a.db(), (tx) => tx.query(`select * from ${table} where id = $1`, [id]).then((r) => r.rows[0]));
    if (!row) throw notFound();
    a.require(o.viewPermission, rowBranch(row));
    return strip(row);
  });

  if (!o.customCreate) app.post(o.path, async (req, reply) => {
    const a = auth(req);
    const companyId = a.requireCompany();
    const body = o.create.strict().parse(req.body) as Record<string, unknown>;
    const branchId = o.branchScoped ? (body.branchId as string) : null;
    a.require(o.managePermission, branchId);
    const data: Record<string, unknown> = { id: (body.id as string) ?? uuidv7(), company_id: companyId };
    for (const [k, v] of Object.entries(body)) if (k !== 'id' && v !== undefined) data[toSnake(k)] = dbValue(v);
    const cols = Object.keys(data);
    const row = await withTx(a.db(), (tx) => tx.query(
      `insert into ${table} (${cols.map(ident).join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')}) returning *`,
      Object.values(data)).then((r) => r.rows[0]));
    reply.code(201);
    return strip(row);
  });

  app.patch(`${o.path}/:id`, async (req) => {
    const a = auth(req);
    const { id } = idParam.parse(req.params);
    const body = o.update.extend({ rowVersion: z.coerce.number().int().positive() }).strict().parse(req.body) as Record<string, unknown>;
    const { rowVersion, ...changes } = body;
    const entries = Object.entries(changes).filter(([, v]) => v !== undefined);
    if (!entries.length) throw badRequest('no changes supplied');
    return withTx(a.db(), async (tx) => {
      const cur = (await tx.query(`select * from ${table} where id = $1 for update`, [id])).rows[0];
      if (!cur) throw notFound();
      a.require(o.managePermission, rowBranch(cur));
      if (Number(cur.row_version) !== rowVersion) throw conflict('record was modified by someone else; reload and retry', { currentVersion: Number(cur.row_version) });
      const sets = entries.map(([k], i) => `${ident(toSnake(k))} = $${i + 2}`);
      const row = (await tx.query(`update ${table} set ${sets.join(', ')} where id = $1 returning *`, [id, ...entries.map(([, v]) => dbValue(v))])).rows[0];
      return strip(row);
    });
  });

  for (const [action, status] of [['activate', active], ['deactivate', inactive]] as const) {
    app.post(`${o.path}/:id/${action}`, async (req) => {
      const a = auth(req);
      const { id } = idParam.parse(req.params);
      return withTx(a.db(), async (tx) => {
        const cur = (await tx.query(`select * from ${table} where id = $1 for update`, [id])).rows[0];
        if (!cur) throw notFound();
        a.require(o.managePermission, rowBranch(cur));
        return strip((await tx.query(`update ${table} set status = $2 where id = $1 returning *`, [id, status])).rows[0]);
      });
    });
  }
}
