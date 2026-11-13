import { describe, it, expect, beforeAll } from 'vitest';
import { asApp, S, demo, pgError, systemQuery } from './helpers.js';
import { uuidv7 } from '../src/lib/uuid.js';

let wh: string; let item: string; let user: string;
const ctx = () => demo({ userId: S.users.inventory });

async function move(kind: 'in' | 'out', qty: number, cost = 0, type?: string, warehouse = wh) {
  const id = uuidv7();
  return asApp(ctx(), (tx) => tx.query(
    `insert into inv.stock_ledger(id, company_id, branch_id, warehouse_id, item_id, movement_type, qty_in, qty_out, unit_cost, business_date,
       source_doc_type, source_doc_id, idempotency_key)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,current_date,'test.doc',$10,$11) returning *`,
    [id, S.companyId, S.branches.KHL, warehouse, item, type ?? (kind === 'in' ? 'purchase_receipt' : 'wastage'),
     kind === 'in' ? qty : 0, kind === 'out' ? qty : 0, cost, uuidv7(), `test:${id}`]).then((r) => r.rows[0]));
}
const balance = () => asApp(ctx(), (tx) => tx.query('select * from inv.stock_balances where warehouse_id = $1 and item_id = $2', [wh, item]).then((r) => r.rows[0]));

beforeAll(async () => {
  wh = (await systemQuery(`select id from inv.warehouses where code = 'KHL-MAIN'`)).rows[0].id;
  item = (await systemQuery(`select id from inv.items where company_id = $1 and code = 'LAMB'`, [S.companyId])).rows[0].id;
  user = S.users.inventory;
});

describe('inventory ledger (moving weighted average)', () => {
  it('computes weighted-average cost and values issues at average', async () => {
    await move('in', 10, 40);                     // 10 kg @ 40
    await move('in', 10, 50);                     // 10 kg @ 50 -> avg 45
    let b = await balance();
    expect(b.qty_on_hand).toBe('20.000000'); expect(b.avg_cost).toBe('45.000000'); expect(b.stock_value).toBe('900.0000');
    const issue = await move('out', 4);
    expect(issue.unit_cost).toBe('45.000000'); expect(issue.value_out).toBe('180.0000'); expect(issue.balance_qty_after).toBe('16.000000');
    b = await balance();
    expect(b.qty_on_hand).toBe('16.000000'); expect(b.stock_value).toBe('720.0000');
  });

  it('blocks issues beyond stock in a non-negative warehouse', async () => {
    const err = await pgError(move('out', 1000));
    expect(err.code).toBe('P0002');
  });

  it('ledger rows are append-only; corrections are reversal entries', async () => {
    const row = await move('in', 1, 45);
    expect((await pgError(asApp(ctx(), (tx) => tx.query('update inv.stock_ledger set qty_in = 2 where id = $1', [row.id])))).code).toBe('42501');
    expect((await pgError(systemQuery('update inv.stock_ledger set qty_in = 2 where id = $1', [row.id]))).message).toMatch(/append-only/);
    expect((await pgError(systemQuery('delete from inv.stock_ledger where id = $1', [row.id]))).message).toMatch(/append-only/);
  });

  it('duplicate postings are rejected by idempotency key', async () => {
    const key = `dup:${uuidv7()}`;
    const ins = () => asApp(ctx(), (tx) => tx.query(
      `insert into inv.stock_ledger(company_id, branch_id, warehouse_id, item_id, movement_type, qty_in, unit_cost, business_date, source_doc_type, source_doc_id, idempotency_key)
       values ($1,$2,$3,$4,'purchase_receipt',1,45,current_date,'test.doc',$5,$6)`, [S.companyId, S.branches.KHL, wh, item, uuidv7(), key]));
    await ins();
    expect((await pgError(ins())).code).toBe('23505');
  });

  it('opening stock seeded through the ledger reconciles with balances and traces to its document', async () => {
    const r = await systemQuery(`
      select l.item_id, sum(l.qty_in - l.qty_out) ledger_qty, b.qty_on_hand
        from inv.stock_ledger l join inv.stock_balances b using (warehouse_id, item_id)
        join inv.warehouses w on w.id = l.warehouse_id where w.code = 'JBR-MAIN' group by l.item_id, b.qty_on_hand`);
    expect(r.rows.length).toBe(8);
    for (const row of r.rows) expect(Number(row.ledger_qty)).toBe(Number(row.qty_on_hand));
    const trace = await systemQuery(`select count(*)::int n, min(source_doc_type) t from audit.v_document_trace where source_doc_type = 'inv.document'`);
    expect(trace.rows[0]).toEqual({ n: 8, t: 'inv.document' });
  });
});

describe('accounting journals', () => {
  async function draftJournal(lines: [string, number, number][]) {
    const acc = (await systemQuery(`select system_key, id from acct.accounts where company_id = $1 and system_key is not null`, [S.companyId])).rows;
    const a = Object.fromEntries(acc.map((x) => [x.system_key, x.id]));
    const id = uuidv7();
    await asApp(demo({ userId: user }), async (tx) => {
      await tx.query(`insert into acct.journal_entries(id, company_id, branch_id, entry_no, entry_date, source_doc_type, idempotency_key) values ($1,$2,$3,$4,current_date,'manual',$5)`,
        [id, S.companyId, S.branches.JBR, `JV-${id.slice(-8)}`, `jv:${id}`]);
      let n = 1;
      for (const [key, dr, cr] of lines) {
        await tx.query(`insert into acct.journal_lines(id, company_id, branch_id, entry_id, line_no, account_id, debit, credit) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [uuidv7(), S.companyId, S.branches.JBR, id, n++, a[key], dr, cr]);
      }
    });
    return id;
  }
  const post = (id: string) => asApp(demo({ userId: user }), (tx) => tx.query(`update acct.journal_entries set status = 'posted' where id = $1`, [id]));

  it('refuses to post an unbalanced journal', async () => {
    const id = await draftJournal([['cash', 105, 0], ['sales_food', 0, 100]]);
    expect((await pgError(post(id))).code).toBe('P0003');
  });

  it('posts a balanced journal (sale with 5% VAT) and then makes it immutable', async () => {
    const id = await draftJournal([['cash', 105, 0], ['sales_food', 0, 100], ['vat_output', 0, 5]]);
    await post(id);
    expect((await pgError(asApp(demo(), (tx) => tx.query(`update acct.journal_entries set description = 'x' where id = $1`, [id])))).message).toMatch(/immutable/);
    expect((await pgError(asApp(demo(), (tx) => tx.query(`update acct.journal_lines set debit = 1 where entry_id = $1`, [id])))).message).toMatch(/immutable/);
    const tb = await asApp(demo(), (tx) => tx.query(`select sum(total_debit) d, sum(total_credit) c from acct.v_trial_balance`).then((r) => r.rows[0]));
    expect(tb.d).toBe(tb.c);
  });
});

describe('POS & payment safeguards', () => {
  let orderId: string;
  beforeAll(async () => {
    orderId = uuidv7();
    const ch = (await systemQuery(`select id from menu.sales_channels where company_id = $1 and code = 'TAKEAWAY'`, [S.companyId])).rows[0].id;
    await asApp(demo({ userId: S.users['cashier.jbr'] }), (tx) => tx.query(
      `insert into pos.orders(id, company_id, branch_id, order_no, business_date, order_type, channel_id, status, kot_sent_at, grand_total)
       values ($1,$2,$3,'JBR-T-1',current_date,'takeaway',$4,'sent',now(),42)`, [orderId, S.companyId, S.branches.JBR, ch]));
  });

  it('an order sent to the kitchen can never be deleted, even by a trusted path', async () => {
    expect((await pgError(systemQuery('delete from pos.orders where id = $1', [orderId]))).message).toMatch(/cannot be deleted/);
  });

  it('payments are append-only and idempotent; refunds must reference the original', async () => {
    const cashMethod = (await systemQuery(`select id from pay.payment_methods where company_id = $1 and code = 'CASH'`, [S.companyId])).rows[0].id;
    const pay = (key: string, extra = '') => asApp(demo({ userId: S.users['cashier.jbr'] }), (tx) => tx.query(
      `insert into pay.payments(id, company_id, branch_id, order_id, payment_method_id, kind, amount, idempotency_key, business_date${extra ? ', refund_of_payment_id' : ''})
       values ($1,$2,$3,$4,$5,$6,42,$7,current_date${extra ? ', $8' : ''}) returning id`,
      [uuidv7(), S.companyId, S.branches.JBR, orderId, cashMethod, extra ? 'refund' : 'payment', key, ...(extra ? [extra] : [])]).then((r) => r.rows[0]));
    const p = await pay('pay-1');
    expect((await pgError(pay('pay-1'))).code).toBe('23505');                  // retry from a terminal = no duplicate
    expect((await pgError(systemQuery('update pay.payments set amount = 1 where id = $1', [p.id]))).message).toMatch(/append-only/);
    await pay('refund-1', p.id);
    const badRefund = asApp(demo(), (tx) => tx.query(
      `insert into pay.payments(id, company_id, branch_id, order_id, payment_method_id, kind, amount, idempotency_key, business_date) values ($1,$2,$3,$4,$5,'refund',1,'r2',current_date)`,
      [uuidv7(), S.companyId, S.branches.JBR, orderId, cashMethod]));
    expect((await pgError(badRefund)).code).toBe('23514');
  });

  it('a supervisor cannot approve their own override request', async () => {
    const err = await pgError(asApp(demo(), (tx) => tx.query(
      `insert into pos.authorizations(company_id, branch_id, permission_code, order_id, requested_by, approved_by, status) values ($1,$2,'pos.order.void',$3,$4,$4,'approved')`,
      [S.companyId, S.branches.JBR, orderId, S.users['bm.jbr']])));
    expect(err.code).toBe('23514');
  });
});

describe('audit & sync capture', () => {
  it('audit log cannot be altered', async () => {
    // layer 1: no UPDATE/DELETE RLS policy, so even trusted paths match zero rows
    const before = (await systemQuery('select count(*)::int n from audit.audit_log')).rows[0].n;
    for (const sql of [`update audit.audit_log set action = 'x'`, `delete from audit.audit_log`]) {
      const r: any = await systemQuery(sql).catch((e) => e);
      expect(r instanceof Error ? /append-only/.test(r.message) : r.rowCount === 0).toBe(true);
    }
    expect((await systemQuery('select count(*)::int n from audit.audit_log')).rows[0].n).toBeGreaterThanOrEqual(before);
    // layer 2: the append-only trigger is installed for anything that bypasses RLS
    const trg = await systemQuery(`select count(*)::int n from pg_trigger where tgname = 'audit_log_append_only'`);
    expect(trg.rows[0].n).toBe(1);
  });

  it('every change to a replicated table is captured in the transactional outbox', async () => {
    const id = uuidv7();
    await asApp(demo({ userId: S.users['cashier.jbr'] }), (tx) => tx.query(
      `insert into crm.customers(id, company_id, code, full_name, mobile) values ($1,$2,'C-OUTBOX','Outbox Test','+971500000777')`, [id, S.companyId]));
    await asApp(demo(), (tx) => tx.query(`update crm.customers set full_name = 'Outbox Test 2' where id = $1`, [id]));
    const ev = await systemQuery(`select operation, row_version, event_id from sync.outbox where row_id = $1 order by seq`, [id]);
    expect(ev.rows.map((e) => [e.operation, Number(e.row_version)])).toEqual([['insert', 1], ['update', 2]]);
    expect(new Set(ev.rows.map((e) => e.event_id)).size).toBe(2);
  });

  it('changes applied from the inbox are not re-emitted (no sync echo loops)', async () => {
    const id = uuidv7();
    await asApp(demo(), async (tx) => {
      await tx.query(`select set_config('app.sync_applying','true',true)`);
      await tx.query(`insert into crm.customers(id, company_id, code, full_name) values ($1,$2,'C-INBOX','From cloud')`, [id, S.companyId]);
    });
    expect((await systemQuery('select count(*)::int n from sync.outbox where row_id = $1', [id])).rows[0].n).toBe(0);
  });

  it('inbox deduplicates events by event id', async () => {
    const ev = uuidv7();
    const ins = () => systemQuery(`insert into sync.inbox(event_id, origin_node_id, table_name, row_id, operation, payload) values ($1,$2,'crm.customers',$3,'insert','{}')`, [ev, uuidv7(), uuidv7()]);
    await ins();
    expect((await pgError(ins())).code).toBe('23505');
  });
});
