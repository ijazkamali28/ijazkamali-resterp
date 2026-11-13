import { describe, it, expect } from 'vitest';
import { ownerQuery } from './helpers.js';

const APP_SCHEMAS = ['org', 'iam', 'audit', 'sync', 'crm', 'menu', 'recipe', 'inv', 'supl', 'proc', 'pos', 'pay', 'kds', 'dlv', 'agg', 'loy', 'mkt', 'exp', 'acct'];

describe('schema foundation', () => {
  it('covers every required domain with tables', async () => {
    const r = await ownerQuery(`select table_schema, count(*)::int n from information_schema.tables where table_type = 'BASE TABLE' and table_schema = any($1) group by 1`, [APP_SCHEMAS]);
    const found = new Map(r.rows.map((x) => [x.table_schema, x.n]));
    for (const s of APP_SCHEMAS) expect(found.get(s), `schema ${s}`).toBeGreaterThan(0);
  });

  it('every table has a primary key and uuid ids', async () => {
    const noPk = await ownerQuery(`
      select n.nspname || '.' || c.relname t from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and n.nspname = any($1) and not exists (select 1 from pg_constraint k where k.conrelid = c.oid and k.contype = 'p')`, [APP_SCHEMAS]);
    expect(noPk.rows).toEqual([]);
    const nonUuidIds = await ownerQuery(`select table_schema || '.' || table_name t, data_type from information_schema.columns
      where column_name = 'id' and table_schema = any($1) and data_type <> 'uuid'`, [APP_SCHEMAS]);
    expect(nonUuidIds.rows).toEqual([]);
  });

  it('every tenant table enforces row level security (forced)', async () => {
    const r = await ownerQuery(`
      select c.table_schema || '.' || c.table_name t from information_schema.columns c
      join pg_class pc on pc.relname = c.table_name join pg_namespace pn on pn.oid = pc.relnamespace and pn.nspname = c.table_schema
      where c.column_name = 'company_id' and pc.relkind = 'r' and c.table_schema = any($1) and not (pc.relrowsecurity and pc.relforcerowsecurity)`, [APP_SCHEMAS]);
    expect(r.rows).toEqual([]);
  });

  it('mutable tables carry timestamps and row_version; status columns are constrained', async () => {
    const r = await ownerQuery(`
      select t.table_schema || '.' || t.table_name tbl from information_schema.tables t
      where t.table_type = 'BASE TABLE' and t.table_schema = any($1)
        and exists (select 1 from information_schema.columns c where c.table_schema = t.table_schema and c.table_name = t.table_name and c.column_name = 'updated_at')
        and not exists (select 1 from information_schema.columns c where c.table_schema = t.table_schema and c.table_name = t.table_name and c.column_name = 'row_version')
        and t.table_name not in ('stock_balances', 'checkpoints')   -- derived / bookkeeping tables`, [APP_SCHEMAS]);
    expect(r.rows).toEqual([]);
    const unchecked = await ownerQuery(`
      select c.table_schema || '.' || c.table_name t from information_schema.columns c
      where c.column_name = 'status' and c.table_schema = any($1)
        and not exists (select 1 from pg_constraint k join pg_class pc on pc.oid = k.conrelid join pg_namespace pn on pn.oid = pc.relnamespace
                        where pn.nspname = c.table_schema and pc.relname = c.table_name and k.contype = 'c' and pg_get_constraintdef(k.oid) ilike '%status%')`, [APP_SCHEMAS]);
    expect(unchecked.rows).toEqual([]);
  });

  it('runtime role cannot bypass RLS and cannot mutate append-only ledgers', async () => {
    const role = await ownerQuery(`select rolsuper, rolbypassrls from pg_roles where rolname = 'pos_app'`);
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    for (const t of ['audit.audit_log', 'inv.stock_ledger', 'pay.payments', 'pos.order_events', 'loy.transactions']) {
      const r = await ownerQuery(`select has_table_privilege('pos_app', $1, 'UPDATE') u, has_table_privilege('pos_app', $1, 'DELETE') d`, [t]);
      expect(r.rows[0], t).toEqual({ u: false, d: false });
    }
  });

  it('migration history is recorded with checksums', async () => {
    const r = await ownerQuery('select version, checksum from public.schema_migrations order by version');
    expect(r.rows.length).toBeGreaterThanOrEqual(5);
    for (const row of r.rows) expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
  });
});
