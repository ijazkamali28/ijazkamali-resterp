import { withTx, type Tx } from '../db/pool.js';
import { config } from '../config.js';
import { hashSecret, verifySecret, DUMMY_HASH, newToken, sha256, passwordPolicyErrors } from '../lib/password.js';
import { writeAudit } from '../lib/audit.js';
import { AppError, unauthorized, badRequest } from '../lib/errors.js';
import { AuthContext, type Grant } from './context.js';
import { uuidv7 } from '../lib/uuid.js';

const SYSTEM = { system: true } as const;

export interface LoginInput { email: string; password: string; deviceId?: string; deviceSecret?: string; ip?: string | null; userAgent?: string }

export async function login(input: LoginInput) {
  return withTx(SYSTEM, async (tx) => {
    const { rows } = await tx.query(
      `select id, company_id, password_hash, status, locked_until, failed_login_count, must_change_password, full_name, email
         from iam.users where email = $1`, [input.email]);
    const user = rows[0];
    const ok = await verifySecret(input.password, user?.password_hash ?? DUMMY_HASH);

    if (!user) {
      await writeAudit(tx, { action: 'auth.login_failed', ip: input.ip, metadata: { email: input.email, reason: 'unknown_user' } });
      throw unauthorized('invalid email or password');
    }
    if (user.status !== 'active') {
      await writeAudit(tx, { action: 'auth.login_failed', companyId: user.company_id, userId: user.id, ip: input.ip, metadata: { reason: 'inactive' } });
      throw unauthorized('invalid email or password');
    }
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      await writeAudit(tx, { action: 'auth.login_blocked', companyId: user.company_id, userId: user.id, ip: input.ip, metadata: { locked_until: user.locked_until } });
      throw new AppError(423, 'account_locked', 'account temporarily locked after repeated failed attempts');
    }
    if (!ok) {
      const failed = user.failed_login_count + 1;
      const lock = failed >= config.LOGIN_MAX_FAILED;
      await tx.query(
        `update iam.users set failed_login_count = $2, locked_until = case when $3 then now() + make_interval(mins => $4) else locked_until end where id = $1`,
        [user.id, lock ? 0 : failed, lock, config.LOGIN_LOCK_MINUTES]);
      await writeAudit(tx, { action: lock ? 'auth.account_locked' : 'auth.login_failed', companyId: user.company_id, userId: user.id, ip: input.ip, metadata: { failed } });
      // commit the counter even though the request fails
      throw Object.assign(unauthorized('invalid email or password'), { commit: true });
    }

    let deviceId: string | null = null;
    if (input.deviceId) {
      const d = (await tx.query(`select id, company_id, status, secret_hash from sync.devices where id = $1`, [input.deviceId])).rows[0];
      if (!d || d.company_id !== user.company_id && user.company_id !== null || d.status !== 'active' ||
          !input.deviceSecret || !d.secret_hash || !sha256(input.deviceSecret).equals(d.secret_hash)) {
        await writeAudit(tx, { action: 'auth.device_rejected', companyId: user.company_id, userId: user.id, deviceId: input.deviceId, ip: input.ip });
        throw new AppError(403, 'device_not_authorized', 'this device is not registered or not approved');
      }
      deviceId = d.id;
      await tx.query('update sync.devices set last_seen_at = now() where id = $1', [d.id]);
    }

    const token = newToken();
    const sessionId = uuidv7();
    const expiresAt = new Date(Date.now() + config.SESSION_TTL_HOURS * 3600_000);
    await tx.query(
      `insert into iam.sessions(id, user_id, company_id, token_hash, device_id, ip_address, user_agent, expires_at, idle_timeout_seconds)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [sessionId, user.id, user.company_id, sha256(token), deviceId, input.ip ?? null, input.userAgent ?? null, expiresAt,
       Math.round(config.SESSION_IDLE_MINUTES * 60)]);
    await tx.query(`update iam.users set failed_login_count = 0, locked_until = null, last_login_at = now() where id = $1`, [user.id]);
    await writeAudit(tx, { action: 'auth.login', companyId: user.company_id, userId: user.id, sessionId, deviceId, ip: input.ip });
    return {
      token, expiresAt, sessionId,
      user: { id: user.id, email: user.email, fullName: user.full_name, companyId: user.company_id, mustChangePassword: user.must_change_password },
    };
  });
}

/** Resolve a bearer token into an AuthContext. Enforces revocation, absolute expiry and idle timeout. */
export async function authenticate(token: string, opts: { requestedCompanyId?: string; requestId: string; ip: string | null }): Promise<AuthContext> {
  return withTx(SYSTEM, async (tx) => {
    const { rows } = await tx.query(
      `select s.id as session_id, s.user_id, s.device_id, s.expires_at, s.last_seen_at, s.idle_timeout_seconds, s.revoked_at,
              u.company_id, u.status as user_status, u.must_change_password, d.status as device_status
         from iam.sessions s join iam.users u on u.id = s.user_id
         left join sync.devices d on d.id = s.device_id
        where s.token_hash = $1`, [sha256(token)]);
    const s = rows[0];
    if (!s || s.revoked_at) throw unauthorized('session is invalid');
    const now = Date.now();
    if (new Date(s.expires_at).getTime() <= now) throw unauthorized('session expired');
    if (new Date(s.last_seen_at).getTime() + s.idle_timeout_seconds * 1000 <= now) {
      await tx.query(`update iam.sessions set revoked_at = now(), revoke_reason = 'idle_timeout' where id = $1`, [s.session_id]);
      throw Object.assign(unauthorized('session expired due to inactivity'), { commit: true });
    }
    if (s.user_status !== 'active') throw unauthorized('user is not active');
    if (s.device_id && s.device_status !== 'active') throw unauthorized('device is no longer authorized');
    if (now - new Date(s.last_seen_at).getTime() > 60_000) {
      await tx.query('update iam.sessions set last_seen_at = now() where id = $1', [s.session_id]);
    }

    const grantRows = (await tx.query(
      `select ur.branch_id, r.code, r.scope, ur.company_id, coalesce(array_agg(rp.permission_code) filter (where rp.permission_code is not null), '{}') as perms
         from iam.user_roles ur
         join iam.roles r on r.id = ur.role_id and r.status = 'active'
         left join iam.role_permissions rp on rp.role_id = r.id
         left join org.branches b on b.id = ur.branch_id
        where ur.user_id = $1 and ur.valid_from <= now() and (ur.valid_to is null or ur.valid_to > now())
          and (ur.branch_id is null or b.status = 'active')
        group by ur.id, ur.branch_id, r.code, r.scope, ur.company_id`, [s.user_id])).rows;

    const isPlatformAdmin = s.company_id === null && grantRows.some((g) => g.code === 'SUPER_ADMIN' && g.scope === 'platform');
    let companyId: string | null = s.company_id;
    if (isPlatformAdmin && opts.requestedCompanyId) {
      const c = await tx.query('select id from org.companies where id = $1', [opts.requestedCompanyId]);
      if (!c.rowCount) throw badRequest('unknown company in X-Company-Id');
      companyId = opts.requestedCompanyId;
    }
    const grants: Grant[] = grantRows
      .filter((g) => isPlatformAdmin || g.company_id === s.company_id)       // defence in depth: never honour cross-tenant grants
      .map((g) => ({ roleCode: g.code, branchId: g.branch_id, permissions: new Set<string>(g.perms) }));
    return new AuthContext(s.user_id, s.session_id, s.company_id, companyId, isPlatformAdmin, grants, s.device_id, opts.requestId, opts.ip, s.must_change_password);
  });
}

export async function logout(auth: AuthContext) {
  await withTx(auth.db(), async (tx) => {
    await tx.query(`update iam.sessions set revoked_at = now(), revoke_reason = 'logout' where id = $1 and revoked_at is null`, [auth.sessionId]);
    await writeAudit(tx, { action: 'auth.logout', companyId: auth.homeCompanyId, userId: auth.userId, sessionId: auth.sessionId, ip: auth.ip });
  });
}

export async function changePassword(auth: AuthContext, currentPassword: string, newPassword: string) {
  const policy = passwordPolicyErrors(newPassword);
  if (policy.length) throw badRequest(`password must contain ${policy.join(', ')}`);
  await withTx(SYSTEM, async (tx) => {
    const u = (await tx.query('select password_hash, company_id from iam.users where id = $1 for update', [auth.userId])).rows[0];
    if (!u || !(await verifySecret(currentPassword, u.password_hash))) throw unauthorized('current password is incorrect');
    if (await verifySecret(newPassword, u.password_hash)) throw badRequest('new password must differ from the current one');
    await setPassword(tx, auth.userId, newPassword);
    // revoke every other session of this user
    await tx.query(`update iam.sessions set revoked_at = now(), revoke_reason = 'password_changed' where user_id = $1 and id <> $2 and revoked_at is null`,
      [auth.userId, auth.sessionId]);
    await writeAudit(tx, { action: 'auth.password_changed', companyId: u.company_id, userId: auth.userId, sessionId: auth.sessionId, ip: auth.ip });
  });
}

export async function setPassword(tx: Tx, userId: string, password: string, mustChange = false) {
  await tx.query(`update iam.users set password_hash = $2, password_changed_at = now(), must_change_password = $3 where id = $1`,
    [userId, await hashSecret(password), mustChange]);
}
