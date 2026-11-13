import pg from 'pg';
import { config } from '../config.js';

// numeric -> string (never float) to keep money exact; int8 -> string
pg.types.setTypeParser(1700, (v) => v);

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 20, idleTimeoutMillis: 30_000 });

export interface DbContext {
  companyId?: string | null;
  branchIds?: string[];
  allBranches?: boolean;
  userId?: string | null;
  system?: boolean;          // bypass tenant RLS: only for trusted server paths (login lookup, sync, platform ops)
  requestId?: string;
  reasonCode?: string;
  reasonText?: string;
}

export type Tx = pg.PoolClient;

/**
 * Runs fn inside a transaction with the tenant context applied via SET LOCAL
 * (transaction-scoped, so pooled connections never leak another tenant's context).
 */
export async function withTx<T>(ctx: DbContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await applyContext(client, ctx);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (e: any) {
    // errors flagged `commit` (e.g. failed-login counters, idle-timeout revocation) keep their side effects
    await client.query(e?.commit ? 'commit' : 'rollback').catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export async function applyContext(client: Tx, ctx: DbContext) {
  await client.query(
    `select set_config('app.company_id', $1, true), set_config('app.branch_ids', $2, true),
            set_config('app.all_branches', $3, true), set_config('app.user_id', $4, true),
            set_config('app.system', $5, true), set_config('app.request_id', $6, true),
            set_config('app.reason_code', $7, true), set_config('app.reason_text', $8, true)`,
    [
      ctx.companyId ?? '',
      `{${(ctx.branchIds ?? []).join(',')}}`,
      String(!!ctx.allBranches),
      ctx.userId ?? '',
      String(!!ctx.system),
      ctx.requestId ?? '',
      ctx.reasonCode ?? '',
      ctx.reasonText ?? '',
    ],
  );
}
