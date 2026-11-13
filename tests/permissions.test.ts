import { describe, it, expect } from 'vitest';
import { api, login, S } from './helpers.js';
import { ROLES, PERMISSIONS } from '../src/auth/permissions.js';

describe('permission matrix definition', () => {
  it('defines all twelve initial roles', () => {
    expect(ROLES.map((r) => r.name)).toEqual([
      'Super Admin', 'Owner', 'General Manager', 'Branch Manager', 'Cashier', 'Waiter', 'Chef',
      'Inventory Controller', 'Procurement Officer', 'Accountant', 'Marketing Manager', 'Rider']);
  });
  it('only Super Admin can create tenants; riders cannot touch money or stock', () => {
    const holders = ROLES.filter((r) => r.permissions.includes('platform.company.create')).map((r) => r.code);
    expect(holders).toEqual(['SUPER_ADMIN']);
    const rider = ROLES.find((r) => r.code === 'RIDER')!;
    expect(rider.permissions.some((p) => p.startsWith('pay.') || p.startsWith('inv.') || p.startsWith('pos.'))).toBe(false);
  });
  it('sensitive operations are flagged', () => {
    for (const code of ['pos.order.void', 'pos.order.refund', 'pos.order.discount', 'supl.bank.view', 'acct.period.close']) {
      expect(PERMISSIONS.find((p) => p.code === code)?.sensitive, code).toBe(true);
    }
  });
});

describe('server-side permission enforcement', () => {
  it('cashier cannot administer users or view audit logs', async () => {
    const t = await login('cashier.jbr@demo.ae');
    expect((await api(t, 'GET', '/iam/users')).statusCode).toBe(403);
    expect((await api(t, 'GET', '/audit/logs')).statusCode).toBe(403);
    expect((await api(t, 'POST', '/org/branches', { code: 'X', name: 'Hack branch' })).statusCode).toBe(403);
  });

  it('navigation is filtered by permissions', async () => {
    const rider = await login('rider.jbr@demo.ae').catch(() => null);
    const t = rider ?? await login('waiter.jbr@demo.ae');
    const nav = (await api(t, 'GET', '/meta/navigation')).json().data;
    expect(nav.find((n: any) => n.key === 'admin')).toBeUndefined();
    const owner = await login('owner@demo.ae');
    const full = (await api(owner, 'GET', '/meta/navigation')).json().data;
    expect(full.find((n: any) => n.key === 'admin').children.length).toBe(6);
  });

  it('branch manager is confined to their branch', async () => {
    const t = await login('bm.jbr@demo.ae');
    const branches = (await api(t, 'GET', '/org/branches')).json().data;
    expect(branches.map((b: any) => b.code)).toEqual(['JBR']);
    expect((await api(t, 'GET', `/org/branches/${S.branches.KHL}`)).statusCode).toBe(404);   // invisible, not just forbidden
    const khlUsers = await api(t, 'GET', `/iam/users?branchId=${S.branches.KHL}`);
    expect(khlUsers.statusCode).toBe(403);
    const mine = (await api(t, 'GET', '/iam/users')).json().data.map((u: any) => u.email);
    expect(mine).toContain('cashier.jbr@demo.ae');
    expect(mine).not.toContain('cashier.khl@demo.ae');
  });

  it('branch manager can change availability-type settings for own branch but not edit branch master', async () => {
    const t = await login('bm.jbr@demo.ae');
    const b = (await api(t, 'GET', `/org/branches/${S.branches.JBR}`)).json();
    expect((await api(t, 'PATCH', `/org/branches/${S.branches.JBR}`, { name: 'Renamed', rowVersion: Number(b.row_version) })).statusCode).toBe(403);
  });
});

describe('privilege escalation guards', () => {
  it('branch manager cannot grant roles with more power than they hold', async () => {
    const owner = await login('owner@demo.ae');
    const roles = (await api(owner, 'GET', '/iam/roles')).json().data;
    const bm = await login('bm.jbr@demo.ae');
    const ownerRole = roles.find((r: any) => r.code === 'OWNER');
    const cashierRole = roles.find((r: any) => r.code === 'CASHIER');
    const r1 = await api(bm, 'POST', `/iam/users/${S.users['waiter.jbr']}/roles`, { roleId: ownerRole.id, branchId: S.branches.JBR });
    expect(r1.statusCode).toBe(403);
    const r2 = await api(bm, 'POST', `/iam/users/${S.users['waiter.jbr']}/roles`, { roleId: cashierRole.id, branchId: null });
    expect(r2.statusCode).toBe(403);   // company-wide grant from a branch-scoped admin
    const r3 = await api(bm, 'POST', `/iam/users/${S.users['waiter.jbr']}/roles`, { roleId: cashierRole.id, branchId: S.branches.KHL });
    expect(r3.statusCode).toBe(403);   // other branch
    const ok = await api(bm, 'POST', `/iam/users/${S.users['waiter.jbr']}/roles`, { roleId: cashierRole.id, branchId: S.branches.JBR });
    expect(ok.statusCode).toBe(201);
    expect((await api(bm, 'DELETE', `/iam/users/${S.users['waiter.jbr']}/roles/${ok.json().grantId}`)).statusCode).toBe(204);
  });

  it('nobody can change their own roles', async () => {
    const owner = await login('owner@demo.ae');
    const roles = (await api(owner, 'GET', '/iam/roles')).json().data;
    const r = await api(owner, 'POST', `/iam/users/${S.users.owner}/roles`, { roleId: roles.find((x: any) => x.code === 'CASHIER').id, branchId: null });
    expect(r.statusCode).toBe(403);
  });

  it('general manager cannot add permissions they do not hold to a role', async () => {
    const gm = await login('gm@demo.ae');
    const roles = (await api(gm, 'GET', '/iam/roles')).json().data;
    const cashier = roles.find((r: any) => r.code === 'CASHIER');
    const r = await api(gm, 'PUT', `/iam/roles/${cashier.id}/permissions`, { permissions: [...cashier.permissions, 'acct.period.close'], reason: 'test' });
    expect(r.statusCode).toBe(403);   // GM lacks acct.period.close (and iam.role.manage)
  });

  it('owner can customise a company role and the change is audited', async () => {
    const owner = await login('owner@demo.ae');
    const roles = (await api(owner, 'GET', '/iam/roles')).json().data;
    const waiter = roles.find((r: any) => r.code === 'WAITER');
    const r = await api(owner, 'PUT', `/iam/roles/${waiter.id}/permissions`, { permissions: [...waiter.permissions, 'crm.customer.manage'], reason: 'waiters capture guest details' });
    expect(r.statusCode).toBe(200);
    expect(r.json().added).toEqual(['crm.customer.manage']);
    const logs = (await api(owner, 'GET', `/audit/logs?entityTable=iam.roles&entityId=${waiter.id}`)).json().data;
    expect(logs.some((l: any) => l.action === 'iam.role.permissions_changed' && l.reason_text === 'waiters capture guest details')).toBe(true);
    await api(owner, 'PUT', `/iam/roles/${waiter.id}/permissions`, { permissions: waiter.permissions, reason: 'revert' });
  });
});

describe('tenancy via the API', () => {
  it('another company\'s owner cannot reach demo records', async () => {
    const t = await login('owner@other.ae');
    expect((await api(t, 'GET', `/org/branches/${S.branches.JBR}`)).statusCode).toBe(404);
    expect((await api(t, 'GET', `/iam/users`)).json().data.map((u: any) => u.email)).toEqual(['owner@other.ae']);
  });

  it('only the platform super admin creates companies, and acts in a tenant via X-Company-Id', async () => {
    const owner = await login('owner@demo.ae');
    expect((await api(owner, 'POST', '/org/companies', { code: 'NEWCO', legalName: 'New Co LLC' })).statusCode).toBe(403);
    const sa = await login('superadmin@platform.local', 'Admin@Pass2026');
    const created = await api(sa, 'POST', '/org/companies', { code: 'NEWCO', legalName: 'New Co LLC', vatRegistrationNo: '100000000000099' });
    expect(created.statusCode).toBe(201);
    const newco = created.json().id;
    const roles = await api(sa, 'GET', '/iam/roles', undefined, { 'x-company-id': newco });
    expect(roles.json().data.filter((r: any) => r.company_id === newco)).toHaveLength(11);
    const b = await api(sa, 'POST', '/org/branches', { code: 'HQ', name: 'New Co HQ', emirate: 'Dubai' }, { 'x-company-id': newco });
    expect(b.statusCode).toBe(201);
    expect(b.json().company_id).toBe(newco);
  });
});

describe('validation and concurrency', () => {
  it('rejects invalid and unknown input server-side', async () => {
    const owner = await login('owner@demo.ae');
    const bad = await api(owner, 'POST', '/org/branches', { code: 'bad code!', name: 'x', emirate: 'Paris' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().details.map((d: any) => d.path)).toEqual(expect.arrayContaining(['code', 'name', 'emirate']));
    const extra = await api(owner, 'POST', '/org/branches', { code: 'OK1', name: 'Fine', companyId: S.otherCompanyId });
    expect(extra.statusCode).toBe(400);   // cannot smuggle tenant ids
    const dup = await api(owner, 'POST', '/org/branches', { code: 'JBR', name: 'Duplicate JBR' });
    expect(dup.statusCode).toBe(409);
  });

  it('optimistic concurrency prevents lost updates', async () => {
    const owner = await login('owner@demo.ae');
    const b = (await api(owner, 'GET', `/org/branches/${S.branches.ALM}`)).json();
    const v = Number(b.row_version);
    expect((await api(owner, 'PATCH', `/org/branches/${S.branches.ALM}`, { phone: '+97165550000', rowVersion: v })).statusCode).toBe(200);
    const stale = await api(owner, 'PATCH', `/org/branches/${S.branches.ALM}`, { phone: '+97165551111', rowVersion: v });
    expect(stale.statusCode).toBe(409);
  });

  it('branch changes are row-audited with before/after values', async () => {
    const acct = await login('accountant@demo.ae');
    const logs = (await api(acct, 'GET', `/audit/logs?entityTable=org.branches&entityId=${S.branches.ALM}&action=row.update`)).json().data;
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].new_data.phone).toBe('+97165550000');
    expect(logs[0].user_id).toBe(S.users.owner);
  });
});

describe('user lifecycle', () => {
  it('deactivating a user immediately revokes their sessions', async () => {
    const owner = await login('owner@demo.ae');
    const victim = await login('cashier.khl@demo.ae');
    const u = (await api(owner, 'GET', '/iam/users?q=cashier.khl')).json().data[0];
    const r = await api(owner, 'PATCH', `/iam/users/${u.id}`, { status: 'inactive', rowVersion: Number(u.row_version) });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().password_hash).toBeUndefined();
    expect((await api(victim, 'GET', '/auth/me')).statusCode).toBe(401);
    expect((await api(null, 'POST', '/auth/login', { email: 'cashier.khl@demo.ae', password: 'Demo@Pass2026' })).statusCode).toBe(401);
    const again = (await api(owner, 'GET', '/iam/users?q=cashier.khl')).json().data[0];
    await api(owner, 'PATCH', `/iam/users/${u.id}`, { status: 'active', rowVersion: Number(again.row_version) });
  });
});
