-- =====================================================================
-- 0005 TRACEABILITY & BALANCE VIEWS (security_invoker => RLS applies)
-- =====================================================================
create view inv.v_stock_reconciliation with (security_invoker = true) as
select l.company_id, l.branch_id, l.warehouse_id, l.item_id,
       sum(l.qty_in)  filter (where l.movement_type = 'opening')                         as opening_qty,
       sum(l.qty_in)  filter (where l.movement_type = 'purchase_receipt')
         - coalesce(sum(l.qty_out) filter (where l.movement_type = 'purchase_return'),0) as net_purchases_qty,
       sum(l.qty_in)  filter (where l.movement_type = 'transfer_in')                     as transfers_in_qty,
       sum(l.qty_out) filter (where l.movement_type = 'transfer_out')                    as transfers_out_qty,
       sum(l.qty_out) filter (where l.movement_type = 'sale_consumption')
         - coalesce(sum(l.qty_in) filter (where l.movement_type = 'sale_reversal'),0)    as net_consumption_qty,
       sum(l.qty_out) filter (where l.movement_type in ('wastage','expiry'))             as wastage_qty,
       sum(l.qty_in) - sum(l.qty_out)                                                    as expected_closing_qty,
       sum(l.value_in) - sum(l.value_out)                                                as ledger_value
from inv.stock_ledger l
group by l.company_id, l.branch_id, l.warehouse_id, l.item_id;

create view acct.v_trial_balance with (security_invoker = true) as
select l.company_id, l.account_id, a.code, a.name, a.account_type,
       sum(l.debit) as total_debit, sum(l.credit) as total_credit, sum(l.debit - l.credit) as balance
from acct.journal_lines l
join acct.journal_entries e on e.id = l.entry_id and e.status in ('posted','reversed')
join acct.accounts a on a.id = l.account_id
group by l.company_id, l.account_id, a.code, a.name, a.account_type;

create view loy.v_account_balances with (security_invoker = true) as
select a.company_id, a.id as account_id, a.customer_id, coalesce(sum(t.points),0) as points_balance,
       coalesce(sum(t.points) filter (where t.points > 0),0) as lifetime_points
from loy.accounts a left join loy.transactions t on t.account_id = a.id
group by a.company_id, a.id, a.customer_id;

-- one row per posting caused by a source document: the traceability chain
create view audit.v_document_trace with (security_invoker = true) as
select company_id, branch_id, source_doc_type, source_doc_id, 'inventory' as posting_kind, id as posting_id, posted_at as posted_at,
       (value_in - value_out) as amount
from inv.stock_ledger
union all
select e.company_id, e.branch_id, e.source_doc_type, e.source_doc_id, 'journal', e.id, e.posted_at,
       (select sum(debit) from acct.journal_lines jl where jl.entry_id = e.id)
from acct.journal_entries e
union all
select company_id, branch_id, 'pos.order', order_id, 'payment', id, created_at,
       case when kind = 'refund' then -amount else amount end
from pay.payments
union all
select company_id, branch_id, 'pos.order', order_id, 'loyalty', id, created_at, points
from loy.transactions where order_id is not null;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'pos_app') then
    grant select on inv.v_stock_reconciliation, acct.v_trial_balance, loy.v_account_balances, audit.v_document_trace to pos_app;
  end if;
end $$;
