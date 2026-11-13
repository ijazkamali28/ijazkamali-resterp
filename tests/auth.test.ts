import { describe, it, expect } from 'vitest';
import { api, login, systemQuery, S, PW } from './helpers.js';

describe('authentication & sessions', () => {
  it('logs in with valid credentials and returns an opaque token (stored only as a hash)', async () => {
    const token = await login('cashier.jbr@demo.ae');
    expect(token.length).toBeGreaterThan(30);
    const stored = await systemQuery(`select count(*)::int n from iam.sessions where token_hash = sha256($1::bytea)`, [Buffer.from(token)]);
    expect(stored.rows[0].n).toBe(1);
    const leaked = await systemQuery(`select count(*)::int n from iam.sessions where encode(token_hash,'escape') like $1`, [`%${token}%`]);
    expect(leaked.rows[0].n).toBe(0);
  });

  it('rejects wrong passwords and unknown users with the same generic error', async () => {
    const a = await api(null, 'POST', '/auth/login', { email: 'cashier.jbr@demo.ae', password: 'nope' });
    const b = await api(null, 'POST', '/auth/login', { email: 'ghost@demo.ae', password: 'nope' });
    expect(a.statusCode).toBe(401); expect(b.statusCode).toBe(401);
    expect(a.json().message).toBe(b.json().message);
  });

  it('stores passwords as salted scrypt hashes', async () => {
    const r = await systemQuery(`select password_hash from iam.users where email in ('owner@demo.ae','gm@demo.ae')`);
    expect(r.rows[0].password_hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(r.rows[0].password_hash).not.toBe(r.rows[1].password_hash);
  });

  it('locks the account after repeated failures and audits it', async () => {
    for (let i = 0; i < 5; i++) await api(null, 'POST', '/auth/login', { email: 'rider.jbr@demo.ae', password: 'bad' });
    const r = await api(null, 'POST', '/auth/login', { email: 'rider.jbr@demo.ae', password: PW });
    expect(r.statusCode).toBe(423);
    const audit = await systemQuery(`select count(*)::int n from audit.audit_log where action = 'auth.account_locked' and user_id = $1`, [S.users['rider.jbr']]);
    expect(audit.rows[0].n).toBe(1);
    await systemQuery(`update iam.users set locked_until = null, failed_login_count = 0 where id = $1`, [S.users['rider.jbr']]);
  });

  it('requires a token for protected routes', async () => {
    expect((await api(null, 'GET', '/auth/me')).statusCode).toBe(401);
    expect((await api('garbage', 'GET', '/auth/me')).statusCode).toBe(401);
  });

  it('logout revokes the session', async () => {
    const t = await login('waiter.jbr@demo.ae');
    expect((await api(t, 'GET', '/auth/me')).statusCode).toBe(200);
    expect((await api(t, 'POST', '/auth/logout')).statusCode).toBe(204);
    expect((await api(t, 'GET', '/auth/me')).statusCode).toBe(401);
  });

  it('expires idle sessions', async () => {
    const t = await login('chef.jbr@demo.ae');
    await systemQuery(`update iam.sessions set last_seen_at = now() - interval '2 hours' where user_id = $1`, [S.users['chef.jbr']]);
    const r = await api(t, 'GET', '/auth/me');
    expect(r.statusCode).toBe(401);
    expect(r.json().message).toMatch(/inactivity/);
  });

  it('enforces password policy and revokes other sessions on change', async () => {
    const t1 = await login('marketing@demo.ae');
    const t2 = await login('marketing@demo.ae');
    const weak = await api(t1, 'POST', '/auth/change-password', { currentPassword: PW, newPassword: 'short' });
    expect(weak.statusCode).toBe(400);
    const ok = await api(t1, 'POST', '/auth/change-password', { currentPassword: PW, newPassword: 'NewStrong#Pass1' });
    expect(ok.statusCode).toBe(204);
    expect((await api(t2, 'GET', '/auth/me')).statusCode).toBe(401);
    expect((await api(t1, 'GET', '/auth/me')).statusCode).toBe(200);
    await api(t1, 'POST', '/auth/change-password', { currentPassword: 'NewStrong#Pass1', newPassword: PW });
  });

  it('forces a password change for users created with a temporary password', async () => {
    const owner = await login('owner@demo.ae');
    const cashierRole = (await api(owner, 'GET', '/iam/roles')).json().data.find((r: any) => r.code === 'CASHIER');
    const created = await api(owner, 'POST', '/iam/users', {
      email: 'new.cashier@demo.ae', fullName: 'New Cashier', password: 'Temp#Pass2026', roles: [{ roleId: cashierRole.id, branchId: S.branches.JBR }],
    });
    expect(created.statusCode).toBe(201);
    const t = await login('new.cashier@demo.ae', 'Temp#Pass2026');
    const blocked = await api(t, 'GET', '/meta/navigation');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toBe('password_change_required');
    expect((await api(t, 'POST', '/auth/change-password', { currentPassword: 'Temp#Pass2026', newPassword: 'Mine#Pass2026x' })).statusCode).toBe(204);
    expect((await api(t, 'GET', '/meta/navigation')).statusCode).toBe(200);
  });
});

describe('device authorization', () => {
  it('a POS terminal must be registered and approved before it can open sessions', async () => {
    const bm = await login('bm.jbr@demo.ae');
    const reg = await api(bm, 'POST', '/sync/devices', { branchId: S.branches.JBR, code: 'POS-01', name: 'Front counter', deviceType: 'pos_terminal' });
    expect(reg.statusCode).toBe(201);
    const { id, deviceSecret } = reg.json();
    const pending = await api(null, 'POST', '/auth/login', { email: 'cashier.jbr@demo.ae', password: PW, deviceId: id, deviceSecret });
    expect(pending.statusCode).toBe(403);
    const approved = await api(bm, 'POST', `/sync/devices/${id}/approve`, {});
    expect(approved.statusCode, approved.body).toBe(200);
    const wrongSecret = await api(null, 'POST', '/auth/login', { email: 'cashier.jbr@demo.ae', password: PW, deviceId: id, deviceSecret: 'x' });
    expect(wrongSecret.statusCode).toBe(403);
    const t = await login('cashier.jbr@demo.ae', PW, { deviceId: id, deviceSecret });
    expect((await api(t, 'GET', '/auth/me')).json().deviceId).toBe(id);
    // blocking the device kills its sessions
    expect((await api(bm, 'POST', `/sync/devices/${id}/block`, { reason: 'stolen' })).statusCode).toBe(200);
    expect((await api(t, 'GET', '/auth/me')).statusCode).toBe(401);
  });

  it('a branch manager cannot register devices for another branch', async () => {
    const bm = await login('bm.jbr@demo.ae');
    const r = await api(bm, 'POST', '/sync/devices', { branchId: S.branches.KHL, code: 'POS-X', name: 'Khalidiya till', deviceType: 'pos_terminal' });
    expect(r.statusCode).toBe(403);
  });
});
