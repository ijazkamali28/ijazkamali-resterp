-- Re-apply runtime grants (dumps are taken with --no-privileges) for the least-privilege API role.
do $$
declare s text; t text;
begin
  if not exists (select 1 from pg_roles where rolname = 'pos_app') then
    raise notice 'role pos_app missing: create it (LOGIN NOSUPERUSER NOBYPASSRLS) and re-run this file'; return;
  end if;
  foreach s in array array['app','org','iam','audit','sync','crm','menu','recipe','inv','supl','proc','pos','pay','kds','dlv','agg','loy','mkt','exp','acct'] loop
    execute format('grant usage on schema %I to pos_app', s);
    execute format('grant select, insert, update, delete on all tables in schema %I to pos_app', s);
    execute format('grant usage, select on all sequences in schema %I to pos_app', s);
    execute format('grant execute on all functions in schema %I to pos_app', s);
  end loop;
  foreach t in array array['audit.audit_log','inv.stock_ledger','pay.payments','pay.cash_movements','pos.order_events','kds.events','loy.transactions','mkt.consents'] loop
    execute format('revoke update, delete on %s from pos_app', t);
  end loop;
  revoke insert, update, delete on iam.permissions, sync.local_node, sync.tracked_tables from pos_app;
  revoke delete on pos.orders, acct.journal_entries, acct.journal_lines, pos.shifts, inv.documents,
                   proc.purchase_orders, proc.grns, proc.purchase_invoices, org.companies, org.branches, iam.users from pos_app;
  grant select on public.schema_migrations to pos_app;
end $$;
