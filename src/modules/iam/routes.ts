import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTx, type Tx } from '../../db/pool.js';
import { auth } from '../../plugins/auth.js';
import type { AuthContext } from '../../auth/context.js';
import { idParam, listQuery } from '../../lib/crud.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { hashSecret, passwordPolicyErrors } from '../../lib/password.js';
import { writeAudit } from '../../lib/audit.js';
import { uuidv7 } from '../../lib/uuid.js';
import { PERMISSIONS } from '../../auth/permissions.js';

const grantInput = z.object({ roleId: z.string().uuid(), branchId: z.string().uuid().nullable() }).strict();

/**
 * Privilege-escalation guard: a user may only grant a role whose every permission
 * they themselves hold for the same branch scope, and never to themselves.
 */
async function assertCanGrant(tx: Tx, a: AuthContext, targetUserId: string, roleId: string, branchId: string | null) {
  a.require('iam.user.assign_roles', branchId);
  if (targetUserId === a.userId && !a.isPlatformAdmin) throw forbidden('you cannot change your own roles');
  if (branchId === null && !a.allBranches) throw forbidden('company-wide roles can only be granted by company-wide administrators');
  const role = (await tx.query(
    `select r.id, r.company_id, r.scope, r.status, coalesce(array_agg(rp.permission_code) filter (where rp.permission_code is not null), '{}') perms
       from iam.roles r left join iam.role_permissions rp on rp.role_id = r.id where r.id = $1 group by r.id`, [roleId])).rows[0];
  if (!role || role.status !== 'active') throw badRequest('role not found or inactive');
  if (role.company_id === null && !a.isPlatformAdmin) throw forbidden('platform roles cannot be granted');
  if (role.company_id !== null && role.company_id !== a.companyId) throw forbidden('role belongs to another company');
  const missing = (role.perms as string[]).filter((p) => !a.can(p, branchId));
  if (missing.length) throw forbidden('you cannot grant permissions you do not hold', { missing });
}

async function assertManageableUser(tx: Tx, a: AuthContext, userId: string) {
  const u = (await tx.query('select * from iam.users where id = $1', [userId])).rows[0];
  if (!u) throw notFound('user not found');
  if (!a.allBranches) {
    // branch-scoped admins may only manage users whose grants are all inside branches they administer
    const grants = (await tx.query('select branch_id from iam.user_roles where user_id = $1 and (valid_to is null or valid_to > now())', [userId])).rows;
    if (!grants.length || grants.some((g) => g.branch_id === null || !a.can('iam.user.manage', g.branch_id))) {
      throw forbidden('this user is outside your branch scope');
    }
  } else {
    a.require('iam.user.manage');
  }
  return u;
}

const safeUser = (u: any) => { const { password_hash, pin_hash, ...rest } = u; return rest; };

export default async function iamRoutes(app: FastifyInstance) {
  app.get('/iam/permissions', async (req) => {
    auth(req).require('iam.role.view');
    return { data: PERMISSIONS };
  });

  // ---------------- roles
  app.get('/iam/roles', async (req) => {
    const a = auth(req);
    a.require('iam.role.view');
    const rows = await withTx(a.db(), (tx) => tx.query(
      `select r.*, coalesce(array_agg(rp.permission_code order by rp.permission_code) filter (where rp.permission_code is not null), '{}') as permissions
         from iam.roles r left join iam.role_permissions rp on rp.role_id = r.id
        where r.company_id = $1 or (r.company_id is null and $2::boolean)
        group by r.id order by r.is_system desc, r.name`, [a.companyId, a.isPlatformAdmin]).then((r) => r.rows));
    return { data: rows };
  });

  const roleBody = z.object({
    code: z.string().trim().min(2).max(40).regex(/^[A-Z0-9_]+$/, 'UPPER_SNAKE_CASE'),
    name: z.string().trim().min(2).max(80),
    description: z.string().max(300).optional(),
    scope: z.enum(['company', 'branch']).default('branch'),
    permissions: z.array(z.string()).max(500),
  }).strict();

  const assertPermsGrantable = (a: AuthContext, perms: string[]) => {
    const known = new Set(PERMISSIONS.map((p) => p.code));
    const unknown = perms.filter((p) => !known.has(p));
    if (unknown.length) throw badRequest('unknown permissions', { unknown });
    if (!a.allBranches) throw forbidden('role management requires a company-wide role');
    const missing = perms.filter((p) => !a.can(p));
    if (missing.length) throw forbidden('you cannot assign permissions you do not hold', { missing });
  };

  app.post('/iam/roles', async (req, reply) => {
    const a = auth(req);
    const companyId = a.requireCompany();
    a.require('iam.role.manage');
    const b = roleBody.parse(req.body);
    assertPermsGrantable(a, b.permissions);
    const id = uuidv7();
    await withTx(a.db(), async (tx) => {
      await tx.query(`insert into iam.roles(id, company_id, code, name, description, scope) values ($1,$2,$3,$4,$5,$6)`,
        [id, companyId, b.code, b.name, b.description ?? null, b.scope]);
      await tx.query(`insert into iam.role_permissions(role_id, permission_code, company_id) select $1, unnest($2::text[]), $3`, [id, [...new Set(b.permissions)], companyId]);
    });
    reply.code(201);
    return { id };
  });

  app.put('/iam/roles/:id/permissions', async (req) => {
    const a = auth(req);
    const { id } = idParam.parse(req.params);
    a.require('iam.role.manage');
    const { permissions, reason } = z.object({ permissions: z.array(z.string()).max(500), reason: z.string().min(3).max(300) }).strict().parse(req.body);
    assertPermsGrantable(a, permissions);
    return withTx(a.db({ reasonText: reason }), async (tx) => {
      const role = (await tx.query('select * from iam.roles where id = $1 for update', [id])).rows[0];
      if (!role || role.company_id !== a.companyId) throw notFound('role not found');
      if (a.grants.some((g) => g.roleCode === role.code) && !a.isPlatformAdmin) throw forbidden('you cannot edit a role you hold');
      const current = new Set<string>((await tx.query('select permission_code from iam.role_permissions where role_id = $1', [id])).rows.map((r) => r.permission_code));
      const next = new Set(permissions);
      const removed = [...current].filter((p) => !next.has(p));
      const added = [...next].filter((p) => !current.has(p));
      if (removed.length) await tx.query('delete from iam.role_permissions where role_id = $1 and permission_code = any($2)', [id, removed]);
      if (added.length) await tx.query('insert into iam.role_permissions(role_id, permission_code, company_id) select $1, unnest($2::text[]), $3', [id, added, a.companyId]);
      await tx.query('update iam.roles set updated_at = now() where id = $1', [id]);
      await writeAudit(tx, { action: 'iam.role.permissions_changed', companyId: a.companyId, userId: a.userId, entityTable: 'iam.roles', entityId: id,
        reasonText: reason, newData: { added, removed }, ip: a.ip });
      return { id, added, removed };
    });
  });

  // ---------------- users
  app.get('/iam/users', async (req) => {
    const a = auth(req);
    const q = listQuery.parse(req.query);
    a.require('iam.user.view', q.branchId);
    const rows = await withTx(a.db(), (tx) => tx.query(
      `select u.id, u.email, u.username, u.full_name, u.mobile, u.status, u.last_login_at, u.default_branch_id, u.row_version, u.locked_until,
              coalesce(json_agg(json_build_object('grantId', ur.id, 'roleId', r.id, 'role', r.code, 'branchId', ur.branch_id))
                 filter (where ur.id is not null), '[]') as grants,
              count(*) over() as _total
         from iam.users u
         left join iam.user_roles ur on ur.user_id = u.id and (ur.valid_to is null or ur.valid_to > now())
         left join iam.roles r on r.id = ur.role_id
        where u.company_id = $1
          and ($2::text is null or u.full_name ilike $2 or u.email::text ilike $2)
          and ($3::text is null or u.status = $3)
          and ($4::boolean or exists (select 1 from iam.user_roles x where x.user_id = u.id and x.branch_id = any($5::uuid[])))
          and ($6::uuid is null or exists (select 1 from iam.user_roles x where x.user_id = u.id and (x.branch_id = $6 or x.branch_id is null)))
        group by u.id order by u.full_name limit $7 offset $8`,
      [a.companyId, q.q ? `%${q.q}%` : null, q.status ?? null, a.allBranches, a.branchIds, q.branchId ?? null, q.limit, q.offset]).then((r) => r.rows));
    return { data: rows.map(({ _total, ...r }) => r), total: rows[0] ? Number(rows[0]._total) : 0 };
  });

  const userCreate = z.object({
    email: z.string().email().max(254).transform((s) => s.toLowerCase()),
    fullName: z.string().trim().min(2).max(120),
    username: z.string().trim().min(2).max(40).optional(),
    mobile: z.string().regex(/^\+?[0-9]{7,15}$/).optional(),
    password: z.string().min(1).max(200),
    pin: z.string().regex(/^[0-9]{4,6}$/).optional(),
    defaultBranchId: z.string().uuid().optional(),
    roles: z.array(grantInput).min(1).max(50),
  }).strict();

  app.post('/iam/users', async (req, reply) => {
    const a = auth(req);
    const companyId = a.requireCompany();
    const b = userCreate.parse(req.body);
    const policy = passwordPolicyErrors(b.password);
    if (policy.length) throw badRequest(`password must contain ${policy.join(', ')}`);
    const id = uuidv7();
    const [pwHash, pinHash] = await Promise.all([hashSecret(b.password), b.pin ? hashSecret(b.pin) : Promise.resolve(null)]);
    await withTx(a.db(), async (tx) => {
      for (const g of b.roles) { a.require('iam.user.manage', g.branchId); await assertCanGrant(tx, a, id, g.roleId, g.branchId); }
      await tx.query(
        `insert into iam.users(id, company_id, email, username, full_name, mobile, password_hash, pin_hash, must_change_password, default_branch_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,true,$9)`,
        [id, companyId, b.email, b.username ?? null, b.fullName, b.mobile ?? null, pwHash, pinHash, b.defaultBranchId ?? null]);
      for (const g of b.roles) {
        await tx.query(`insert into iam.user_roles(id, user_id, role_id, company_id, branch_id) values ($1,$2,$3,$4,$5)`, [uuidv7(), id, g.roleId, companyId, g.branchId]);
      }
    });
    reply.code(201);
    return { id };
  });

  app.patch('/iam/users/:id', async (req) => {
    const a = auth(req);
    const { id } = idParam.parse(req.params);
    const b = z.object({
      fullName: z.string().trim().min(2).max(120).optional(), mobile: z.string().regex(/^\+?[0-9]{7,15}$/).nullable().optional(),
      status: z.enum(['active', 'inactive']).optional(), defaultBranchId: z.string().uuid().nullable().optional(),
      rowVersion: z.number().int().positive(),
    }).strict().parse(req.body);
    return withTx(a.db(), async (tx) => {
      const u = await assertManageableUser(tx, a, id);
      if (id === a.userId && b.status === 'inactive') throw badRequest('you cannot deactivate yourself');
      if (Number(u.row_version) !== b.rowVersion) throw conflict('record was modified by someone else; reload and retry');
      const r = await tx.query(
        `update iam.users set full_name = coalesce($2, full_name), mobile = case when $3::boolean then $4 else mobile end,
           status = coalesce($5, status), default_branch_id = case when $6::boolean then $7::uuid else default_branch_id end,
           failed_login_count = case when $5 = 'active' then 0 else failed_login_count end,
           locked_until = case when $5 = 'active' then null else locked_until end
         where id = $1 returning *`,
        [id, b.fullName ?? null, b.mobile !== undefined, b.mobile ?? null, b.status ?? null, b.defaultBranchId !== undefined, b.defaultBranchId ?? null]);
      if (b.status === 'inactive') {
        await tx.query(`update iam.sessions set revoked_at = now(), revoke_reason = 'user_deactivated' where user_id = $1 and revoked_at is null`, [id]);
      }
      return safeUser(r.rows[0]);
    });
  });

  app.post('/iam/users/:id/reset-password', async (req, reply) => {
    const a = auth(req);
    const { id } = idParam.parse(req.params);
    const { temporaryPassword } = z.object({ temporaryPassword: z.string().min(1).max(200) }).strict().parse(req.body);
    const policy = passwordPolicyErrors(temporaryPassword);
    if (policy.length) throw badRequest(`password must contain ${policy.join(', ')}`);
    const hash = await hashSecret(temporaryPassword);
    await withTx(a.db(), async (tx) => {
      await assertManageableUser(tx, a, id);
      if (id === a.userId) throw badRequest('use change-password for your own account');
      await tx.query(`update iam.users set password_hash = $2, must_change_password = true, password_changed_at = now(), failed_login_count = 0, locked_until = null where id = $1`, [id, hash]);
      await tx.query(`update iam.sessions set revoked_at = now(), revoke_reason = 'password_reset' where user_id = $1 and revoked_at is null`, [id]);
      await writeAudit(tx, { action: 'iam.user.password_reset', companyId: a.companyId, userId: a.userId, entityTable: 'iam.users', entityId: id, ip: a.ip });
    });
    reply.code(204);
  });

  app.post('/iam/users/:id/roles', async (req, reply) => {
    const a = auth(req);
    const { id } = idParam.parse(req.params);
    const g = grantInput.extend({ validTo: z.string().datetime().optional() }).strict().parse(req.body);
    const grantId = uuidv7();
    await withTx(a.db(), async (tx) => {
      const u = (await tx.query('select company_id from iam.users where id = $1', [id])).rows[0];
      if (!u) throw notFound('user not found');
      await assertCanGrant(tx, a, id, g.roleId, g.branchId);
      await tx.query(`insert into iam.user_roles(id, user_id, role_id, company_id, branch_id, valid_to) values ($1,$2,$3,$4,$5,$6)`,
        [grantId, id, g.roleId, u.company_id, g.branchId, g.validTo ?? null]);
    });
    reply.code(201);
    return { grantId };
  });

  app.delete('/iam/users/:id/roles/:grantId', async (req, reply) => {
    const a = auth(req);
    const { id, grantId } = z.object({ id: z.string().uuid(), grantId: z.string().uuid() }).parse(req.params);
    await withTx(a.db(), async (tx) => {
      const g = (await tx.query('select * from iam.user_roles where id = $1 and user_id = $2 and (valid_to is null or valid_to > now())', [grantId, id])).rows[0];
      if (!g) throw notFound('grant not found');
      await assertCanGrant(tx, a, id, g.role_id, g.branch_id);   // same rule to revoke as to grant
      await tx.query('update iam.user_roles set valid_to = now() where id = $1', [grantId]);  // end-dated, keeps history
    });
    reply.code(204);
  });
}
