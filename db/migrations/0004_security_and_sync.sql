-- =====================================================================
-- 0004 SECURITY & SYNC WIRING
--   * touch / creator triggers on every table that has the columns
--   * created_by / updated_by foreign keys
--   * row level security: company isolation + branch isolation
--   * grants for the runtime role (pos_app) - least privilege
--   * row audit on sensitive tables
--   * sync registry + outbox capture triggers
-- =====================================================================
do $$
declare r record;
  v_schemas text[] := array['org','iam','audit','sync','crm','menu','recipe','inv','supl','proc','pos','pay','kds','dlv','agg','loy','mkt','exp','acct'];
begin
  -- touch triggers
  for r in select c.table_schema, c.table_name from information_schema.columns c
           join information_schema.tables t using (table_schema, table_name)
           where c.column_name = 'row_version' and t.table_type = 'BASE TABLE' and c.table_schema = any(v_schemas) loop
    execute format('create trigger %I before update on %I.%I for each row execute function app.touch()',
                   r.table_name || '_touch', r.table_schema, r.table_name);
  end loop;
  -- creator stamp
  for r in select c.table_schema, c.table_name from information_schema.columns c
           join information_schema.tables t using (table_schema, table_name)
           where c.column_name = 'created_by' and t.table_type = 'BASE TABLE' and c.table_schema = any(v_schemas) loop
    execute format('create trigger %I before insert on %I.%I for each row execute function app.stamp_creator()',
                   r.table_name || '_creator', r.table_schema, r.table_name);
  end loop;
  -- created_by / updated_by -> iam.users (deferrable so replicated rows can arrive in any order inside a batch)
  for r in select c.table_schema, c.table_name, c.column_name from information_schema.columns c
           join information_schema.tables t using (table_schema, table_name)
           where c.column_name in ('created_by','updated_by') and t.table_type = 'BASE TABLE'
             and c.table_schema = any(v_schemas) and not (c.table_schema = 'audit') loop
    execute format('alter table %I.%I add constraint %I foreign key (%I) references iam.users(id) deferrable initially immediate',
                   r.table_schema, r.table_name, r.table_name || '_' || r.column_name || '_fk', r.column_name);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- ROW LEVEL SECURITY
-- app.system = true is only set by trusted server code paths
-- (login lookup, sync engine, migrations/seed). Never from client input.
-- ---------------------------------------------------------------------
do $$
declare r record; v_branch_nullable text; v_has_branch boolean;
  v_schemas text[] := array['org','iam','audit','sync','crm','menu','recipe','inv','supl','proc','pos','pay','kds','dlv','agg','loy','mkt','exp','acct'];
  v_special text[] := array['org.companies','org.branches','iam.roles','iam.users','iam.role_permissions','iam.user_roles','iam.sessions','audit.audit_log','sync.outbox','sync.inbox','sync.conflicts','sync.nodes'];
begin
  for r in select c.table_schema, c.table_name from information_schema.columns c
           join information_schema.tables t using (table_schema, table_name)
           where c.column_name = 'company_id' and t.table_type = 'BASE TABLE' and c.table_schema = any(v_schemas)
             and not ((c.table_schema || '.' || c.table_name) = any(v_special)) loop
    select is_nullable into v_branch_nullable from information_schema.columns
      where table_schema = r.table_schema and table_name = r.table_name and column_name = 'branch_id';
    v_has_branch := found;
    execute format('alter table %I.%I enable row level security', r.table_schema, r.table_name);
    execute format('alter table %I.%I force row level security', r.table_schema, r.table_name);
    if v_has_branch then
      execute format($p$create policy tenant_isolation on %I.%I using (
          app.is_system() or (company_id = app.current_company_id() and (app.all_branches() or branch_id = any(app.current_branch_ids()) %s)))
        with check (
          app.is_system() or (company_id = app.current_company_id() and (app.all_branches() or branch_id = any(app.current_branch_ids()) %s)))$p$,
        r.table_schema, r.table_name,
        case when v_branch_nullable = 'YES' then 'or branch_id is null' else '' end,
        case when v_branch_nullable = 'YES' then 'or branch_id is null' else '' end);
    else
      execute format($p$create policy tenant_isolation on %I.%I using (app.is_system() or company_id = app.current_company_id())
                       with check (app.is_system() or company_id = app.current_company_id())$p$, r.table_schema, r.table_name);
    end if;
  end loop;
end $$;

alter table org.companies enable row level security;  alter table org.companies force row level security;
create policy tenant_isolation on org.companies using (app.is_system() or id = app.current_company_id())
  with check (app.is_system());                                   -- only platform can create/alter tenants
create policy tenant_update on org.companies for update using (id = app.current_company_id()) with check (id = app.current_company_id());

alter table org.branches enable row level security;  alter table org.branches force row level security;
create policy tenant_isolation on org.branches
  using (app.is_system() or (company_id = app.current_company_id() and (app.all_branches() or id = any(app.current_branch_ids()))))
  with check (app.is_system() or (company_id = app.current_company_id() and app.all_branches()));

-- platform roles (company_id null) are visible to everyone (read-only); tenant roles are isolated
alter table iam.roles enable row level security;  alter table iam.roles force row level security;
create policy roles_read on iam.roles for select using (app.is_system() or company_id is null or company_id = app.current_company_id());
create policy roles_write on iam.roles for all using (app.is_system() or company_id = app.current_company_id())
  with check (app.is_system() or company_id = app.current_company_id());

alter table iam.role_permissions enable row level security;  alter table iam.role_permissions force row level security;
create policy rp_read on iam.role_permissions for select using (app.is_system() or company_id is null or company_id = app.current_company_id());
create policy rp_write on iam.role_permissions for all using (app.is_system() or company_id = app.current_company_id())
  with check (app.is_system() or company_id = app.current_company_id());

do $$ declare t text; begin
  foreach t in array array['iam.users','iam.user_roles','sync.outbox','sync.inbox','sync.conflicts','sync.nodes'] loop
    execute format('alter table %s enable row level security', t);
    execute format('alter table %s force row level security', t);
    execute format('create policy tenant_isolation on %s using (app.is_system() or company_id = app.current_company_id()) with check (app.is_system() or company_id = app.current_company_id())', t);
  end loop;
end $$;

alter table iam.sessions enable row level security;  alter table iam.sessions force row level security;
create policy tenant_isolation on iam.sessions using (app.is_system() or user_id = app.current_user_id() or company_id = app.current_company_id())
  with check (app.is_system() or user_id = app.current_user_id() or company_id = app.current_company_id());  -- admins revoke sessions of their tenant's users

alter table audit.audit_log enable row level security;  alter table audit.audit_log force row level security;
create policy audit_read on audit.audit_log for select using (app.is_system() or company_id = app.current_company_id());
create policy audit_insert on audit.audit_log for insert with check (app.is_system() or company_id is null or company_id = app.current_company_id());

-- ---------------------------------------------------------------------
-- GRANTS for runtime role (created outside migrations: pos_app, NOBYPASSRLS)
-- ---------------------------------------------------------------------
do $$
declare s text; t text;
  v_schemas text[] := array['app','org','iam','audit','sync','crm','menu','recipe','inv','supl','proc','pos','pay','kds','dlv','agg','loy','mkt','exp','acct'];
  v_append_only text[] := array['audit.audit_log','inv.stock_ledger','pay.payments','pay.cash_movements','pos.order_events','kds.events','loy.transactions','mkt.consents'];
begin
  if not exists (select 1 from pg_roles where rolname = 'pos_app') then
    raise notice 'role pos_app does not exist; skipping grants (create it and re-run grants)';
    return;
  end if;
  foreach s in array v_schemas loop
    execute format('grant usage on schema %I to pos_app', s);
    execute format('grant select, insert, update, delete on all tables in schema %I to pos_app', s);
    execute format('grant usage, select on all sequences in schema %I to pos_app', s);
    execute format('grant execute on all functions in schema %I to pos_app', s);
  end loop;
  foreach t in array v_append_only loop
    execute format('revoke update, delete on %s from pos_app', t);
  end loop;
  revoke insert, update, delete on iam.permissions from pos_app;          -- catalogue is code-defined
  revoke insert, update, delete on sync.local_node, sync.tracked_tables from pos_app;
  revoke delete on pos.orders, acct.journal_entries, acct.journal_lines, pos.shifts, inv.documents,
                   proc.purchase_orders, proc.grns, proc.purchase_invoices, org.companies, org.branches, iam.users from pos_app;
end $$;

-- ---------------------------------------------------------------------
-- ROW AUDIT on sensitive tables
-- ---------------------------------------------------------------------
do $$ declare t text; begin
  foreach t in array array[
    'org.companies','org.branches','iam.users','iam.roles','iam.role_permissions','iam.user_roles',
    'menu.item_prices','acct.tax_rates','acct.branch_tax_settings','acct.accounts','acct.fiscal_periods',
    'pay.payment_methods','pay.branch_payment_methods','supl.suppliers','supl.supplier_bank_accounts',
    'recipe.recipes','recipe.recipe_lines','inv.documents','pos.shifts','pos.reason_codes','pos.authorizations',
    'sync.devices','proc.purchase_orders','proc.purchase_invoices','exp.expenses','loy.programs','agg.aggregators','agg.branch_accounts'] loop
    execute format('create trigger audit_row after insert or update or delete on %s for each row execute function audit.capture_row_change()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- SYNC REGISTRY + OUTBOX CAPTURE
-- ---------------------------------------------------------------------
insert into sync.tracked_tables(table_name, ownership, conflict_policy, priority) values
  -- cloud-owned master data (priority = apply order)
  ('org.companies','cloud','owner_wins',1), ('org.branches','cloud','owner_wins',2),
  ('iam.users','cloud','owner_wins',5), ('iam.roles','cloud','owner_wins',5), ('iam.role_permissions','cloud','owner_wins',6), ('iam.user_roles','cloud','owner_wins',6),
  ('acct.accounts','cloud','owner_wins',10), ('acct.tax_rates','cloud','owner_wins',11), ('acct.branch_tax_settings','cloud','owner_wins',12), ('acct.fiscal_periods','cloud','owner_wins',12),
  ('inv.uoms','cloud','owner_wins',15), ('inv.stock_categories','cloud','owner_wins',15), ('inv.items','cloud','owner_wins',16), ('inv.uom_conversions','cloud','owner_wins',17),
  ('inv.warehouses','cloud','owner_wins',17), ('inv.storage_locations','cloud','owner_wins',18),
  ('supl.suppliers','cloud','owner_wins',20),
  ('kds.stations','cloud','owner_wins',20),
  ('menu.categories','cloud','owner_wins',21), ('menu.sales_channels','cloud','owner_wins',21), ('menu.items','cloud','owner_wins',22), ('menu.item_variants','cloud','owner_wins',23),
  ('menu.modifier_groups','cloud','owner_wins',23), ('menu.modifiers','cloud','owner_wins',24), ('menu.item_modifier_groups','cloud','owner_wins',25),
  ('menu.combo_components','cloud','owner_wins',25), ('menu.item_prices','cloud','owner_wins',26),
  ('recipe.recipes','cloud','owner_wins',27), ('recipe.recipe_lines','cloud','owner_wins',28),
  ('pay.payment_methods','cloud','owner_wins',30), ('pay.branch_payment_methods','cloud','owner_wins',31), ('pos.reason_codes','cloud','owner_wins',30),
  ('pos.floor_areas','cloud','owner_wins',30), ('dlv.zones','cloud','owner_wins',30), ('dlv.riders','cloud','owner_wins',31),
  ('agg.aggregators','cloud','owner_wins',32), ('agg.branch_accounts','cloud','owner_wins',33), ('agg.item_mappings','cloud','owner_wins',33),
  ('loy.programs','cloud','owner_wins',34), ('loy.tiers','cloud','owner_wins',35), ('exp.categories','cloud','owner_wins',30),
  ('mkt.templates','cloud','owner_wins',40), ('mkt.segments','cloud','owner_wins',40), ('mkt.provider_accounts','cloud','owner_wins',40),
  ('mkt.campaigns','cloud','owner_wins',41), ('mkt.campaign_messages','cloud','owner_wins',42), ('sync.nodes','cloud','owner_wins',3),
  -- shared (either side edits; version conflicts go to sync.conflicts)
  ('crm.customers','shared','manual',50), ('crm.customer_addresses','shared','manual',51), ('loy.accounts','shared','manual',52),
  ('pos.dining_tables','shared','last_writer_wins',31), ('menu.item_branch_availability','shared','last_writer_wins',29),
  ('sync.devices','shared','manual',4), ('agg.external_orders','shared','manual',90), ('mkt.consents','shared','reject',53),
  -- branch-owned operational records (append-only or branch-authored)
  ('org.document_sequences','branch','owner_wins',60),
  ('pos.shifts','branch','owner_wins',100), ('pos.orders','branch','owner_wins',101), ('pos.order_items','branch','owner_wins',102),
  ('pos.order_item_modifiers','branch','owner_wins',103), ('pos.order_events','branch','reject',104), ('pos.authorizations','branch','owner_wins',104),
  ('pay.payment_intents','branch','owner_wins',105), ('pay.payments','branch','reject',106), ('pay.cash_movements','branch','reject',106),
  ('kds.tickets','branch','owner_wins',107), ('kds.ticket_items','branch','owner_wins',108), ('kds.events','branch','reject',109),
  ('inv.batches','branch','owner_wins',110), ('inv.documents','branch','owner_wins',111), ('inv.document_lines','branch','owner_wins',112),
  ('inv.stock_ledger','branch','reject',113),
  ('proc.purchase_requisitions','branch','owner_wins',120), ('proc.requisition_lines','branch','owner_wins',121),
  ('proc.purchase_orders','branch','owner_wins',122), ('proc.purchase_order_lines','branch','owner_wins',123),
  ('proc.grns','branch','owner_wins',124), ('proc.grn_lines','branch','owner_wins',125),
  ('proc.purchase_invoices','branch','owner_wins',126), ('proc.purchase_invoice_lines','branch','owner_wins',127),
  ('dlv.deliveries','branch','owner_wins',130), ('loy.transactions','branch','reject',131), ('exp.expenses','branch','owner_wins',132),
  ('acct.journal_entries','branch','reject',140), ('acct.journal_lines','branch','reject',141),
  ('audit.audit_log','branch','reject',200);
-- NOT replicated: iam.sessions (node-local), supl.supplier_bank_accounts (cloud only, restricted),
-- inv.stock_balances (derived; rebuilt from ledger), sync.* bookkeeping, iam.permissions (code-defined).

do $$ declare r record; begin
  for r in select table_name from sync.tracked_tables loop
    execute format('create trigger sync_capture after insert or update or delete on %s for each row execute function sync.capture_change()', r.table_name);
  end loop;
end $$;
