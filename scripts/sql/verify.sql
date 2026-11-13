-- Post-restore / periodic integrity checks. Every line should read "ok".
select set_config('app.system', 'true', false);
select 'schema version ' || max(version) from public.schema_migrations;
select case when count(*) = 0 then 'ok   stock balances match ledger'
            else 'FAIL stock balances differ from ledger for ' || count(*) || ' item/warehouse pairs' end
  from (select l.warehouse_id, l.item_id, sum(l.qty_in - l.qty_out) q from inv.stock_ledger l group by 1,2) l
  full join inv.stock_balances b using (warehouse_id, item_id)
 where coalesce(l.q, 0) <> coalesce(b.qty_on_hand, 0);
select case when count(*) = 0 then 'ok   posted journals balanced' else 'FAIL unbalanced posted journals: ' || count(*) end
  from (select e.id from acct.journal_entries e join acct.journal_lines l on l.entry_id = e.id
         where e.status in ('posted','reversed') group by e.id having sum(l.debit) <> sum(l.credit)) x;
select case when count(*) = 0 then 'ok   no tenant table without RLS' else 'FAIL tables without RLS: ' || string_agg(t, ', ') end
  from (select c.table_schema || '.' || c.table_name t from information_schema.columns c
          join pg_class pc on pc.relname = c.table_name join pg_namespace pn on pn.oid = pc.relnamespace and pn.nspname = c.table_schema
         where c.column_name = 'company_id' and pc.relkind = 'r' and not pc.relrowsecurity) x;
select 'ok   ' || count(*) || ' audit entries, ' || (select count(*) from sync.outbox where status in ('pending','failed')) || ' pending sync events' from audit.audit_log;
