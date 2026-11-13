/**
 * Forward-only SQL migration runner.
 *  - migrations live in db/migrations as NNNN_name.sql, applied in order, each in its own transaction
 *  - checksums are recorded; editing an applied migration is detected and refused
 *  - `--reset` drops all application schemas (development/test only; refused when NODE_ENV=production)
 */
import 'dotenv/config';
import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../db/migrations');
export const APP_SCHEMAS = ['app', 'org', 'iam', 'audit', 'sync', 'crm', 'menu', 'recipe', 'inv', 'supl', 'proc', 'pos', 'pay', 'kds', 'dlv', 'agg', 'loy', 'mkt', 'exp', 'acct'];

export async function migrate(connectionString: string, opts: { reset?: boolean; log?: (m: string) => void } = {}) {
  const log = opts.log ?? console.log;
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    if (opts.reset) {
      if (process.env.NODE_ENV === 'production') throw new Error('refusing to reset a production database');
      await client.query(`drop schema if exists ${APP_SCHEMAS.join(', ')} cascade`);
      await client.query('drop table if exists public.schema_migrations');
      log('reset: dropped application schemas');
    }
    await client.query(`create table if not exists public.schema_migrations (
      version text primary key, name text not null, checksum text not null,
      applied_at timestamptz not null default now(), applied_by text not null default current_user)`);
    const applied = new Map<string, string>(
      (await client.query('select version, checksum from public.schema_migrations')).rows.map((r) => [r.version, r.checksum]),
    );
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    for (const file of files) {
      const version = file.slice(0, 4);
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      if (applied.has(version)) {
        if (applied.get(version) !== checksum) throw new Error(`migration ${file} was modified after being applied (checksum mismatch)`);
        continue;
      }
      log(`applying ${file}`);
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into public.schema_migrations(version, name, checksum) values ($1,$2,$3)', [version, file, checksum]);
        await client.query('commit');
      } catch (e: any) {
        await client.query('rollback');
        throw new Error(`migration ${file} failed: ${e.message}${e.position ? ` (position ${e.position})` : ''}`);
      }
    }
    await client.query(`do $$ begin if exists (select 1 from pg_roles where rolname = 'pos_app') then
      grant select on public.schema_migrations to pos_app; end if; end $$`);
    log('migrations up to date');
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_OWNER_URL;
  if (!url) { console.error('DATABASE_OWNER_URL is required'); process.exit(1); }
  migrate(url, { reset: process.argv.includes('--reset') }).catch((e) => { console.error(e.message); process.exit(1); });
}
