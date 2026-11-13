import { readFileSync } from 'node:fs';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { withTx, type DbContext, type Tx } from '../src/db/pool.js';
import type { SeedResult } from '../db/seeds/seed.js';

export const S: SeedResult = JSON.parse(readFileSync(new URL('./.seed.json', import.meta.url), 'utf8'));
export const PW = 'Demo@Pass2026';

let app: FastifyInstance | null = null;
export async function getApp() {
  if (!app) { app = await buildApp({ logger: false }); await app.ready(); }
  return app;
}

export async function login(email: string, password = PW, extra: Record<string, unknown> = {}) {
  const a = await getApp();
  const r = await a.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password, ...extra } });
  if (r.statusCode !== 200) throw new Error(`login ${email} failed: ${r.statusCode} ${r.body}`);
  return r.json().token as string;
}

export async function api(token: string | null, method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const a = await getApp();
  return a.inject({ method: method as any, url: `/api/v1${url}`, payload: payload as any,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
}

/** Run SQL as the least-privilege runtime role with a given tenant context (RLS applies). */
export const asApp = <T>(ctx: DbContext, fn: (tx: Tx) => Promise<T>) => withTx(ctx, fn);

/** Owner connection for test fixtures that must bypass the API (still subject to forced RLS unless system ctx). */
export async function ownerQuery(sql: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL });
  await c.connect();
  try { return await c.query(sql, params); } finally { await c.end(); }
}

export const demo = (ctx: Partial<DbContext> = {}): DbContext => ({ companyId: S.companyId, allBranches: true, ...ctx });

/** Expect a promise to reject with a PostgreSQL error code. */
export async function pgError(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e: any) { return { code: e.code, message: e.message }; }
  throw new Error('expected database error, but the statement succeeded');
}

/** Fixture SQL in a trusted system context (forced RLS applies to the owner too). */
export async function systemQuery(sql: string, params: unknown[] = []) {
  const c = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL });
  await c.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('app.system', 'true', true)`);
    const r = await c.query(sql, params);
    await c.query('commit');
    return r;
  } finally { await c.end(); }
}
