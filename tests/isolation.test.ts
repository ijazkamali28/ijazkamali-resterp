import { describe, it, expect } from 'vitest';
import { asApp, S, demo, pgError } from './helpers.js';
import { uuidv7 } from '../src/lib/uuid.js';

describe('company isolation (database RLS)', () => {
  it('without a tenant context nothing is visible', async () => {
    const n = await asApp({}, (tx) => tx.query('select count(*)::int n from crm.customers').then((r) => r.rows[0].n));
    expect(n).toBe(0);
  });

  it('a tenant only sees its own rows', async () => {
    const demoRows = await asApp(demo(), (tx) => tx.query('select distinct company_id from crm.customers').then((r) => r.rows));
    expect(demoRows).toEqual([{ company_id: S.companyId }]);
    const otherRows = await asApp({ companyId: S.otherCompanyId, allBranches: true }, (tx) => tx.query('select full_name from crm.customers').then((r) => r.rows));
    expect(otherRows.map((r) => r.full_name)).toEqual(['Other Customer']);
  });

  it('cannot read another tenant by id', async () => {
    const r = await asApp({ companyId: S.otherCompanyId, allBranches: true }, (tx) =>
      tx.query('select * from org.branches where id = $1', [S.branches.JBR]).then((x) => x.rows));
    expect(r).toEqual([]);
  });

  it('cannot write rows into another tenant', async () => {
    const err = await pgError(asApp({ companyId: S.otherCompanyId, allBranches: true }, (tx) =>
      tx.query(`insert into crm.customers(id, company_id, code, full_name) values ($1,$2,'HACK','x')`, [uuidv7(), S.companyId])));
    expect(err.code).toBe('42501');
  });

  it('composite foreign keys stop a row from pointing at another tenant\'s branch', async () => {
    const err = await pgError(asApp({ system: true }, (tx) =>
      tx.query(`insert into inv.warehouses(id, company_id, branch_id, code, name) values ($1,$2,$3,'X','x')`, [uuidv7(), S.otherCompanyId, S.branches.JBR])));
    expect(err.code).toBe('23503');
  });

  it('cannot move a row to another tenant via update', async () => {
    const err = await pgError(asApp(demo(), (tx) => tx.query(`update crm.customers set company_id = $1`, [S.otherCompanyId])));
    expect(err.code).toBe('42501');
  });
});

describe('branch isolation (database RLS)', () => {
  const jbrOnly = demo({ allBranches: false, branchIds: [S.branches.JBR] });

  it('branch-scoped users only see their branch\'s operational rows', async () => {
    const rows = await asApp(jbrOnly, (tx) => tx.query('select distinct branch_id from inv.warehouses').then((r) => r.rows));
    expect(rows).toEqual([{ branch_id: S.branches.JBR }]);
    const branches = await asApp(jbrOnly, (tx) => tx.query('select code from org.branches').then((r) => r.rows));
    expect(branches.map((b) => b.code)).toEqual(['JBR']);
  });

  it('branch-scoped users cannot write into other branches', async () => {
    const err = await pgError(asApp(jbrOnly, (tx) =>
      tx.query(`insert into kds.stations(id, company_id, branch_id, code, name, station_type) values ($1,$2,$3,'NEW','x','hot')`, [uuidv7(), S.companyId, S.branches.KHL])));
    expect(err.code).toBe('42501');
  });

  it('company-wide masters remain visible to branch users', async () => {
    const n = await asApp(jbrOnly, (tx) => tx.query('select count(*)::int n from menu.items').then((r) => r.rows[0].n));
    expect(n).toBeGreaterThan(0);
  });
});
