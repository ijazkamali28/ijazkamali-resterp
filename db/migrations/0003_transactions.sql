-- =====================================================================
-- 0003 TRANSACTIONAL DOMAINS: POS, payments, kitchen, inventory ledger &
-- documents, procurement, delivery, aggregators, loyalty, marketing,
-- expenses, accounting journals.
-- Every financial / inventory posting carries source_doc_type +
-- source_doc_id (+ source_line_id) for end-to-end traceability.
-- =====================================================================

-- ---------------------------------------------------------------- DOCUMENT NUMBERING (offline-safe: per device)
create table org.document_sequences (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references org.companies(id),
  branch_id   uuid not null,
  device_id   uuid references sync.devices(id),     -- per-device series => no collisions while offline
  doc_type    text not null,                        -- 'order','kot','grn','po','journal', ...
  prefix      text not null,
  next_value  bigint not null default 1 check (next_value > 0),
  padding     int not null default 6,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id)
);
create unique index document_sequences_uq on org.document_sequences(branch_id, coalesce(device_id, '00000000-0000-0000-0000-000000000000'::uuid), doc_type);

-- ---------------------------------------------------------------- POS MASTERS
create table pos.reason_codes (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references org.companies(id),
  code        citext not null,
  category    text not null check (category in ('item_void','order_void','discount','complimentary','price_change','refund','cancellation','reopen','reprint','cash_variance','cash_payout','stock_adjustment','wastage','other')),
  description text not null,
  requires_approval boolean not null default true,
  status      text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  unique (company_id, code)
);

create table pos.floor_areas (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references org.companies(id),
  branch_id  uuid not null,
  code       citext not null,
  name       text not null,
  sort_order int not null default 0,
  status     text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id),
  unique (branch_id, code)
);

create table pos.dining_tables (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references org.companies(id),
  branch_id     uuid not null,
  floor_area_id uuid not null references pos.floor_areas(id),
  code          citext not null,
  seats         int not null default 4 check (seats > 0),
  layout        jsonb not null default '{}'::jsonb,   -- x, y, shape for the table plan
  occupancy     text not null default 'available' check (occupancy in ('available','occupied','reserved','cleaning','blocked')),
  status        text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id),
  unique (branch_id, code)
);

-- ---------------------------------------------------------------- PAYMENT MASTERS
create table pay.payment_methods (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references org.companies(id),
  code        citext not null,
  name        text not null,
  method_type text not null check (method_type in ('cash','card','online','gateway','aggregator','voucher','loyalty','credit')),
  account_id  uuid references acct.accounts(id),     -- clearing / cash account
  opens_drawer boolean not null default false,
  allows_change boolean not null default false,
  sort_order  int not null default 0,
  status      text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  unique (company_id, code)
);

create table pay.branch_payment_methods (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references org.companies(id),
  branch_id         uuid not null,
  payment_method_id uuid not null references pay.payment_methods(id),
  is_enabled        boolean not null default true,
  surcharge_pct     numeric(9,6) not null default 0 check (surcharge_pct >= 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id),
  unique (branch_id, payment_method_id)
);

-- ---------------------------------------------------------------- CASHIER SHIFTS
create table pos.shifts (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references org.companies(id),
  branch_id       uuid not null,
  device_id       uuid references sync.devices(id),
  cashier_id      uuid not null references iam.users(id),
  shift_no        text not null,
  business_date   date not null,
  opened_at       timestamptz not null default now(),
  opening_cash    numeric(18,4) not null check (opening_cash >= 0),
  closed_at       timestamptz,
  expected_cash   numeric(18,4),
  counted_cash    numeric(18,4) check (counted_cash is null or counted_cash >= 0),
  variance        numeric(18,4) generated always as (counted_cash - expected_cash) stored,
  variance_reason_code_id uuid references pos.reason_codes(id),
  variance_approved_by uuid references iam.users(id),
  variance_approved_at timestamptz,
  denominations   jsonb,
  status          text not null default 'open' check (status in ('open','closing','closed','approved')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id),
  unique (branch_id, shift_no)
);
create unique index shifts_one_open_per_device_uq on pos.shifts(device_id) where status in ('open','closing');
create index shifts_branch_date_idx on pos.shifts(branch_id, business_date);

-- ---------------------------------------------------------------- ORDERS
create table pos.orders (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references org.companies(id),
  branch_id       uuid not null,
  order_no        text not null,
  business_date   date not null,
  order_type      text not null check (order_type in ('dine_in','takeaway','delivery','online','aggregator')),
  channel_id      uuid not null references menu.sales_channels(id),
  table_id        uuid references pos.dining_tables(id),
  guest_count     int check (guest_count is null or guest_count > 0),
  waiter_id       uuid references iam.users(id),
  cashier_id      uuid references iam.users(id),
  shift_id        uuid references pos.shifts(id),
  device_id       uuid references sync.devices(id),
  customer_id     uuid references crm.customers(id),
  parent_order_id uuid references pos.orders(id),   -- split bill child -> parent
  merged_into_order_id uuid references pos.orders(id),
  aggregator_order_id uuid,                          -- FK added below (agg.external_orders)
  scheduled_for   timestamptz,
  notes           text,
  is_held         boolean not null default false,
  -- monetary snapshot (recomputed server-side from lines; never trusted from client)
  subtotal        numeric(18,4) not null default 0,
  discount_total  numeric(18,4) not null default 0 check (discount_total >= 0),
  service_charge  numeric(18,4) not null default 0 check (service_charge >= 0),
  delivery_fee    numeric(18,4) not null default 0 check (delivery_fee >= 0),
  tax_total       numeric(18,4) not null default 0 check (tax_total >= 0),
  rounding_adjustment numeric(18,4) not null default 0,
  grand_total     numeric(18,4) not null default 0 check (grand_total >= 0),
  paid_total      numeric(18,4) not null default 0,
  refunded_total  numeric(18,4) not null default 0 check (refunded_total >= 0),
  prices_include_tax boolean not null default true,
  status          text not null default 'draft' check (status in ('draft','open','sent','ready','served','billed','paid','closed','cancelled','voided')),
  payment_status  text not null default 'unpaid' check (payment_status in ('unpaid','partial','paid','partially_refunded','refunded')),
  kot_sent_at     timestamptz,                       -- once set, order can never be deleted
  billed_at       timestamptz,
  closed_at       timestamptz,
  cancelled_at    timestamptz,
  cancel_reason_code_id uuid references pos.reason_codes(id),
  financial_posted_at timestamptz,                   -- GL posting done
  stock_posted_at timestamptz,                       -- recipe consumption posted
  reopened_count  int not null default 0,
  print_count     int not null default 0,
  origin_node_id  uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id),
  unique (branch_id, order_no),
  check (order_type <> 'dine_in' or table_id is not null or status = 'draft')
);
create index orders_branch_date_idx on pos.orders(branch_id, business_date);
create index orders_status_idx on pos.orders(branch_id, status) where status not in ('closed','cancelled','voided');
create index orders_customer_idx on pos.orders(customer_id) where customer_id is not null;
create index orders_shift_idx on pos.orders(shift_id);
create index orders_table_open_idx on pos.orders(table_id) where status not in ('closed','cancelled','voided');

-- an order that reached the kitchen or the ledger is never physically deleted
create or replace function pos.guard_order_delete() returns trigger language plpgsql as $$
begin
  if old.status <> 'draft' or old.kot_sent_at is not null or old.financial_posted_at is not null or old.stock_posted_at is not null then
    raise exception 'order % cannot be deleted (status %, transmitted or posted); cancel/void instead', old.order_no, old.status using errcode = 'P0001';
  end if;
  return old;
end $$;
create trigger orders_guard_delete before delete on pos.orders for each row execute function pos.guard_order_delete();

create table pos.order_items (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references org.companies(id),
  branch_id       uuid not null,
  order_id        uuid not null references pos.orders(id),
  line_no         int not null,
  menu_item_id    uuid not null references menu.items(id),
  variant_id      uuid references menu.item_variants(id),
  item_name       text not null,                     -- snapshot at time of sale
  quantity        numeric(18,6) not null check (quantity > 0),
  unit_price      numeric(18,4) not null check (unit_price >= 0),
  price_id        uuid references menu.item_prices(id),  -- which price record was applied
  price_overridden boolean not null default false,
  discount_amount numeric(18,4) not null default 0 check (discount_amount >= 0),
  tax_rate_id     uuid references acct.tax_rates(id),
  tax_rate        numeric(9,6) not null default 0,
  net_amount      numeric(18,4) not null default 0,  -- excl. tax, after discount
  tax_amount      numeric(18,4) not null default 0,
  gross_amount    numeric(18,4) not null default 0,  -- incl. tax
  is_complimentary boolean not null default false,
  seat_no         int,
  course_no       int,
  station_id      uuid references kds.stations(id),
  kitchen_status  text not null default 'pending' check (kitchen_status in ('pending','new','accepted','preparing','ready','completed','cancelled')),
  recipe_id       uuid references recipe.recipes(id),   -- recipe version consumed
  theoretical_cost numeric(18,4),
  notes           text,
  sent_at         timestamptz,
  status          text not null default 'active' check (status in ('active','voided')),
  voided_at       timestamptz,
  void_reason_code_id uuid references pos.reason_codes(id),
  voided_by       uuid references iam.users(id),
  void_approved_by uuid references iam.users(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id),
  unique (order_id, line_no)
);
create index order_items_order_idx on pos.order_items(order_id);
create index order_items_menu_item_idx on pos.order_items(menu_item_id);

create table pos.order_item_modifiers (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references org.companies(id),
  branch_id     uuid not null,
  order_item_id uuid not null references pos.order_items(id),
  modifier_id   uuid not null references menu.modifiers(id),
  name          text not null,
  quantity      numeric(18,6) not null default 1 check (quantity > 0),
  price_delta   numeric(18,4) not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id)
);
create index order_item_modifiers_item_idx on pos.order_item_modifiers(order_item_id);

-- immutable history of everything that happened to an order
create table pos.order_events (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references org.companies(id),
  branch_id    uuid not null,
  order_id     uuid not null references pos.orders(id),
  order_item_id uuid references pos.order_items(id),
  event_type   text not null,                       -- created, item_added, item_voided, sent_to_kitchen, discount_applied, billed, paid, refunded, reopened, reprinted, transferred, merged, split, cancelled
  payload      jsonb not null default '{}'::jsonb,
  reason_code_id uuid references pos.reason_codes(id),
  reason_text  text,
  performed_by uuid references iam.users(id),
  approved_by  uuid references iam.users(id),
  device_id    uuid references sync.devices(id),
  occurred_at  timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  foreign key (company_id, branch_id) references org.branches(company_id, id)
);
create index order_events_order_idx on pos.order_events(order_id, occurred_at);
create trigger order_events_append_only before update or delete on pos.order_events for each row execute function app.forbid_mutation();

-- supervisor overrides for sensitive operations
create table pos.authorizations (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references org.companies(id),
  branch_id     uuid not null,
  permission_code text not null references iam.permissions(code),
  order_id      uuid references pos.orders(id),
  order_item_id uuid references pos.order_items(id),
  requested_by  uuid not null references iam.users(id),
  approved_by   uuid references iam.users(id),
  reason_code_id uuid references pos.reason_codes(id),
  reason_text   text,
  amount        numeric(18,4),
  status        text not null default 'pending' check (status in ('pending','approved','rejected','expired','consumed')),
  decided_at    timestamptz,
  expires_at    timestamptz not null default now() + interval '5 minutes',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id),
  check (approved_by is null or approved_by <> requested_by)   -- no self-approval
);
create index authorizations_order_idx on pos.authorizations(order_id);

-- ---------------------------------------------------------------- PAYMENTS (append-only)
create table pay.payment_intents (                     -- mutable gateway lifecycle; final result becomes a pay.payments row
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references org.companies(id),
  branch_id     uuid not null,
  order_id      uuid not null references pos.orders(id),
  payment_method_id uuid not null references pay.payment_methods(id),
  provider      text not null,
  provider_ref  text,
  amount        numeric(18,4) not null check (amount > 0),
  idempotency_key text not null,
  status        text not null default 'created' check (status in ('created','pending','authorized','captured','failed','cancelled')),
  last_payload  jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id),
  unique (company_id, idempotency_key)
);

create table pay.payments (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references org.companies(id),
  branch_id        uuid not null,
  order_id         uuid not null references pos.orders(id),
  shift_id         uuid references pos.shifts(id),
  payment_method_id uuid not null references pay.payment_methods(id),
  kind             text not null check (kind in ('payment','refund')),
  amount           numeric(18,4) not null check (amount > 0),     -- sign comes from kind
  tendered_amount  numeric(18,4),
  change_amount    numeric(18,4) not null default 0 check (change_amount >= 0),
  tip_amount       numeric(18,4) not null default 0 check (tip_amount >= 0),
  currency         char(3) not null default 'AED',
  reference        text,                                          -- card auth code, gateway ref
  intent_id        uuid references pay.payment_intents(id),
  refund_of_payment_id uuid references pay.payments(id),
  reason_code_id   uuid references pos.reason_codes(id),
  approved_by      uuid references iam.users(id),
  received_by      uuid references iam.users(id),
  device_id        uuid references sync.devices(id),
  idempotency_key  text not null,                                 -- client-generated, makes retries safe
  business_date    date not null,
  created_at       timestamptz not null default now(),        -- GL link: acct.journal_entries(source_doc_type='pay.payment', source_doc_id=id)
  created_by       uuid,
  foreign key (company_id, branch_id) references org.branches(company_id, id),
  unique (company_id, idempotency_key),
  check ((kind = 'refund') = (refund_of_payment_id is not null))
);
create index payments_order_idx on pay.payments(order_id);
create index payments_shift_idx on pay.payments(shift_id);
create index payments_branch_date_idx on pay.payments(branch_id, business_date);
create trigger payments_append_only before update or delete on pay.payments for each row execute function app.forbid_mutation();

create table pay.cash_movements (                      -- drawer ledger for shift reconciliation
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references org.companies(id),
  branch_id     uuid not null,
  shift_id      uuid not null references pos.shifts(id),
  movement_type text not null check (movement_type in ('opening_float','cash_sale','cash_refund','cash_expense','cash_deposit','cash_payout','float_in','rider_handover')),
  amount        numeric(18,4) not null,                -- signed: + into drawer, - out of drawer
  source_doc_type text,
  source_doc_id uuid,
  reason_code_id uuid references pos.reason_codes(id),
  notes         text,
  performed_by  uuid references iam.users(id),
  approved_by   uuid references iam.users(id),
  idempotency_key text not null,
  created_at    timestamptz not null default now(),
  created_by    uuid,
  foreign key (company_id, branch_id) references org.branches(company_id, id),
  unique (company_id, idempotency_key)
);
create index cash_movements_shift_idx on pay.cash_movements(shift_id);
create trigger cash_movements_append_only before update or delete on pay.cash_movements for each row execute function app.forbid_mutation();

-- ---------------------------------------------------------------- KITCHEN
create table kds.tickets (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references org.companies(id),
  branch_id   uuid not null,
  order_id    uuid not null references pos.orders(id),
  station_id  uuid not null references kds.stations(id),
  ticket_no   text not null,
  priority    int not null default 0,
  is_held     boolean not null default false,
  received_at timestamptz not null default now(),
  accepted_at timestamptz, started_at timestamptz, ready_at timestamptz, completed_at timestamptz,
  print_count int not null default 0,
  status      text not null default 'new' check (status in ('new','accepted','preparing','ready','completed','cancelled')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id),
  unique (branch_id, ticket_no)
);
create index kds_tickets_station_status_idx on kds.tickets(station_id, status) where status <> 'completed';
create index kds_tickets_order_idx on kds.tickets(order_id);

create table kds.ticket_items (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references org.companies(id),
  branch_id     uuid not null,
  ticket_id     uuid not null references kds.tickets(id),
  order_item_id uuid not null references pos.order_items(id),
  quantity      numeric(18,6) not null check (quantity > 0),
  status        text not null default 'new' check (status in ('new','accepted','preparing','ready','completed','cancelled')),
  started_at timestamptz, ready_at timestamptz, completed_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id)
);
create index kds_ticket_items_ticket_idx on kds.ticket_items(ticket_id);

create table kds.events (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references org.companies(id),
  branch_id   uuid not null,
  ticket_id   uuid not null references kds.tickets(id),
  ticket_item_id uuid references kds.ticket_items(id),
  from_status text, to_status text not null,
  performed_by uuid references iam.users(id),
  device_id   uuid references sync.devices(id),
  occurred_at timestamptz not null default now(),
  foreign key (company_id, branch_id) references org.branches(company_id, id)
);
create index kds_events_ticket_idx on kds.events(ticket_id, occurred_at);
create trigger kds_events_append_only before update or delete on kds.events for each row execute function app.forbid_mutation();

-- ---------------------------------------------------------------- INVENTORY DOCUMENTS & LEDGER
create table inv.batches (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references org.companies(id),
  branch_id     uuid not null,
  warehouse_id  uuid not null references inv.warehouses(id),
  item_id       uuid not null references inv.items(id),
  batch_no      text not null,
  manufactured_on date,
  expiry_date   date,
  unit_cost     numeric(18,6) not null check (unit_cost >= 0),
  received_qty  numeric(18,6) not null check (received_qty > 0),
  qty_on_hand   numeric(18,6) not null default 0,
  status        text not null default 'active' check (status in ('active','depleted','expired','quarantined')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id),
  unique (warehouse_id, item_id, batch_no)
);
create index batches_expiry_idx on inv.batches(warehouse_id, item_id, expiry_date) where status = 'active';

create table inv.documents (                          -- opening, transfer, adjustment, count, wastage, expiry, production, closing
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references org.companies(id),
  branch_id       uuid not null,
  doc_no          text not null,
  doc_type        text not null check (doc_type in ('opening','transfer','adjustment','stock_count','wastage','expiry','production','closing')),
  doc_date        date not null,
  warehouse_id    uuid not null references inv.warehouses(id),   -- source warehouse
  to_warehouse_id uuid references inv.warehouses(id),            -- transfers
  to_branch_id    uuid references org.branches(id),
  reason_code_id  uuid references pos.reason_codes(id),
  notes           text,
  submitted_by uuid, submitted_at timestamptz,
  approved_by uuid, approved_at timestamptz,
  posted_by uuid, posted_at timestamptz,
  received_by uuid, received_at timestamptz,           -- transfer receipt
  status          text not null default 'draft' check (status in ('draft','submitted','approved','in_transit','posted','cancelled')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id),
  unique (branch_id, doc_no),
  check (doc_type <> 'transfer' or to_warehouse_id is not null),
  check (to_warehouse_id is null or to_warehouse_id <> warehouse_id)
);
create index inv_documents_type_date_idx on inv.documents(branch_id, doc_type, doc_date);

create table inv.document_lines (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references org.companies(id),
  branch_id     uuid not null,
  document_id   uuid not null references inv.documents(id) on delete cascade,
  line_no       int not null,
  item_id       uuid not null references inv.items(id),
  batch_id      uuid references inv.batches(id),
  quantity      numeric(18,6) not null,                -- signed for adjustments; counted qty for stock_count
  uom_id        uuid not null references inv.uoms(id),
  base_quantity numeric(18,6) not null,                -- converted to item base UoM server-side
  system_quantity numeric(18,6),                       -- stock_count: book qty at count time
  unit_cost     numeric(18,6),
  received_quantity numeric(18,6),                     -- transfers
  notes         text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id),
  unique (document_id, line_no)
);

create table inv.stock_balances (                      -- derived cache of the ledger; rebuildable
  company_id    uuid not null references org.companies(id),
  branch_id     uuid not null,
  warehouse_id  uuid not null references inv.warehouses(id),
  item_id       uuid not null references inv.items(id),
  qty_on_hand   numeric(18,6) not null default 0,
  stock_value   numeric(18,4) not null default 0,
  avg_cost      numeric(18,6) not null default 0 check (avg_cost >= 0),
  last_movement_at timestamptz,
  updated_at    timestamptz not null default now(),
  primary key (warehouse_id, item_id),
  foreign key (company_id, branch_id) references org.branches(company_id, id)
);
create index stock_balances_item_idx on inv.stock_balances(item_id);

create table inv.stock_ledger (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references org.companies(id),
  branch_id       uuid not null,
  warehouse_id    uuid not null references inv.warehouses(id),
  item_id         uuid not null references inv.items(id),
  batch_id        uuid references inv.batches(id),
  movement_type   text not null check (movement_type in (
                    'opening','purchase_receipt','purchase_return','transfer_out','transfer_in',
                    'sale_consumption','sale_reversal','adjustment_in','adjustment_out','count_variance_in','count_variance_out',
                    'wastage','expiry','production_in','production_out')),
  qty_in          numeric(18,6) not null default 0 check (qty_in >= 0),
  qty_out         numeric(18,6) not null default 0 check (qty_out >= 0),
  unit_cost       numeric(18,6) not null default 0 check (unit_cost >= 0),  -- incoming: supplied; outgoing: avg cost at posting
  value_in        numeric(18,4) not null default 0,
  value_out       numeric(18,4) not null default 0,
  balance_qty_after numeric(18,6) not null default 0,
  avg_cost_after  numeric(18,6) not null default 0,
  business_date   date not null,
  source_doc_type text not null,                     -- 'pos.order','proc.grn','inv.document', ...
  source_doc_id   uuid not null,
  source_line_id  uuid,
  reversal_of_id  uuid references inv.stock_ledger(id),
  idempotency_key text not null,                     -- prevents double posting on retries/sync
  posted_by       uuid,
  posted_at       timestamptz not null default now(),
  origin_node_id  uuid,
  foreign key (company_id, branch_id) references org.branches(company_id, id),
  unique (company_id, idempotency_key),
  check ((qty_in > 0 and qty_out = 0) or (qty_out > 0 and qty_in = 0))
);
create index stock_ledger_item_idx on inv.stock_ledger(warehouse_id, item_id, posted_at);
create index stock_ledger_source_idx on inv.stock_ledger(source_doc_type, source_doc_id);
create index stock_ledger_date_idx on inv.stock_ledger(branch_id, business_date);
create trigger stock_ledger_append_only before update or delete on inv.stock_ledger for each row execute function app.forbid_mutation();

-- moving weighted-average costing applied atomically on every ledger insert
create or replace function inv.apply_stock_movement() returns trigger language plpgsql as $$
declare b inv.stock_balances%rowtype; v_new_qty numeric; v_allow_neg boolean;
begin
  insert into inv.stock_balances(company_id, branch_id, warehouse_id, item_id)
  values (new.company_id, new.branch_id, new.warehouse_id, new.item_id)
  on conflict (warehouse_id, item_id) do nothing;
  select * into b from inv.stock_balances where warehouse_id = new.warehouse_id and item_id = new.item_id for update;

  if new.qty_in > 0 then
    new.value_in := round(new.qty_in * new.unit_cost, 4);
    v_new_qty := b.qty_on_hand + new.qty_in;
    if b.qty_on_hand <= 0 or v_new_qty <= 0 then
      new.avg_cost_after := new.unit_cost;              -- recovering from zero/negative: adopt incoming cost
    else
      new.avg_cost_after := round((b.stock_value + new.value_in) / v_new_qty, 6);
    end if;
  else
    select allow_negative_stock into v_allow_neg from inv.warehouses where id = new.warehouse_id;
    v_new_qty := b.qty_on_hand - new.qty_out;
    if v_new_qty < 0 and not coalesce(v_allow_neg, false) and new.movement_type not in ('sale_consumption') then
      raise exception 'insufficient stock for item % in warehouse % (on hand %, requested %)',
        new.item_id, new.warehouse_id, b.qty_on_hand, new.qty_out using errcode = 'P0002';
    end if;
    if new.unit_cost = 0 then new.unit_cost := b.avg_cost; end if;  -- issues at current average
    new.value_out := round(new.qty_out * new.unit_cost, 4);
    new.avg_cost_after := b.avg_cost;
  end if;
  new.balance_qty_after := v_new_qty;

  update inv.stock_balances
     set qty_on_hand = v_new_qty,
         avg_cost = new.avg_cost_after,
         stock_value = case when v_new_qty = 0 then 0 else round(v_new_qty * new.avg_cost_after, 4) end,
         last_movement_at = new.posted_at,
         updated_at = now()
   where warehouse_id = new.warehouse_id and item_id = new.item_id;
  return new;
end $$;
create trigger stock_ledger_apply before insert on inv.stock_ledger for each row execute function inv.apply_stock_movement();

-- ---------------------------------------------------------------- PROCUREMENT
create table proc.purchase_requisitions (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references org.companies(id),
  branch_id    uuid not null,
  doc_no       text not null,
  doc_date     date not null,
  required_by  date,
  warehouse_id uuid not null references inv.warehouses(id),
  notes        text,
  approved_by uuid, approved_at timestamptz,
  status       text not null default 'draft' check (status in ('draft','submitted','approved','rejected','ordered','closed','cancelled')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id),
  unique (branch_id, doc_no)
);
create table proc.requisition_lines (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references org.companies(id),
  branch_id    uuid not null,
  requisition_id uuid not null references proc.purchase_requisitions(id) on delete cascade,
  line_no      int not null,
  item_id      uuid not null references inv.items(id),
  quantity     numeric(18,6) not null check (quantity > 0),
  uom_id       uuid not null references inv.uoms(id),
  notes        text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id),
  unique (requisition_id, line_no)
);

create table proc.purchase_orders (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references org.companies(id),
  branch_id     uuid not null,
  doc_no        text not null,
  doc_date      date not null,
  supplier_id   uuid not null references supl.suppliers(id),
  warehouse_id  uuid not null references inv.warehouses(id),
  requisition_id uuid references proc.purchase_requisitions(id),
  expected_date date,
  currency      char(3) not null default 'AED',
  subtotal      numeric(18,4) not null default 0,
  tax_total     numeric(18,4) not null default 0,
  grand_total   numeric(18,4) not null default 0,
  revision_no   int not null default 0,              -- approved PO changes create a new revision
  approved_by uuid, approved_at timestamptz,
  status        text not null default 'draft' check (status in ('draft','submitted','approved','partially_received','received','closed','cancelled')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id),
  unique (branch_id, doc_no)
);
create index purchase_orders_supplier_idx on proc.purchase_orders(supplier_id, status);

create table proc.purchase_order_lines (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references org.companies(id),
  branch_id     uuid not null,
  purchase_order_id uuid not null references proc.purchase_orders(id) on delete cascade,
  line_no       int not null,
  item_id       uuid not null references inv.items(id),
  quantity      numeric(18,6) not null check (quantity > 0),
  uom_id        uuid not null references inv.uoms(id),
  unit_price    numeric(18,6) not null check (unit_price >= 0),
  tax_rate_id   uuid references acct.tax_rates(id),
  received_qty  numeric(18,6) not null default 0 check (received_qty >= 0),
  invoiced_qty  numeric(18,6) not null default 0 check (invoiced_qty >= 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id),
  unique (purchase_order_id, line_no)
);

-- prevent edits to approved POs except via controlled status/receipt fields
create or replace function proc.guard_approved_po() returns trigger language plpgsql as $$
begin
  if old.status in ('approved','partially_received','received','closed') and
     (new.supplier_id, new.warehouse_id, new.subtotal, new.tax_total, new.grand_total, new.currency)
       is distinct from (old.supplier_id, old.warehouse_id, old.subtotal, old.tax_total, old.grand_total, old.currency)
     and new.revision_no = old.revision_no then
    raise exception 'approved purchase order % cannot be modified without a revision', old.doc_no using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger purchase_orders_guard before update on proc.purchase_orders for each row execute function proc.guard_approved_po();

create table proc.grns (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references org.companies(id),
  branch_id     uuid not null,
  doc_no        text not null,
  doc_date      date not null,
  supplier_id   uuid not null references supl.suppliers(id),
  purchase_order_id uuid references proc.purchase_orders(id),
  warehouse_id  uuid not null references inv.warehouses(id),
  supplier_delivery_note text,
  received_by uuid, posted_at timestamptz,
  status        text not null default 'draft' check (status in ('draft','posted','cancelled')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id),
  unique (branch_id, doc_no)
);
create table proc.grn_lines (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references org.companies(id),
  branch_id     uuid not null,
  grn_id        uuid not null references proc.grns(id) on delete cascade,
  line_no       int not null,
  po_line_id    uuid references proc.purchase_order_lines(id),
  item_id       uuid not null references inv.items(id),
  received_qty  numeric(18,6) not null check (received_qty >= 0),
  rejected_qty  numeric(18,6) not null default 0 check (rejected_qty >= 0),
  uom_id        uuid not null references inv.uoms(id),
  base_quantity numeric(18,6) not null,
  unit_price    numeric(18,6) not null check (unit_price >= 0),
  batch_no      text, expiry_date date,
  rejection_reason text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id),
  unique (grn_id, line_no)
);

create table proc.purchase_invoices (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references org.companies(id),
  branch_id       uuid not null,
  doc_no          text not null,
  supplier_id     uuid not null references supl.suppliers(id),
  supplier_invoice_no text not null,
  invoice_date    date not null,
  due_date        date,
  purchase_order_id uuid references proc.purchase_orders(id),
  subtotal        numeric(18,4) not null default 0,
  tax_total       numeric(18,4) not null default 0,
  grand_total     numeric(18,4) not null default 0,
  paid_total      numeric(18,4) not null default 0,
  match_status    text not null default 'unmatched' check (match_status in ('unmatched','matched','variance','approved_variance')),
  journal_entry_id uuid,
  posted_at       timestamptz,
  status          text not null default 'draft' check (status in ('draft','posted','partially_paid','paid','cancelled')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id),
  unique (branch_id, doc_no),
  unique (company_id, supplier_id, supplier_invoice_no)   -- duplicate supplier invoice protection
);
create table proc.purchase_invoice_lines (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references org.companies(id),
  branch_id     uuid not null,
  invoice_id    uuid not null references proc.purchase_invoices(id) on delete cascade,
  line_no       int not null,
  po_line_id    uuid references proc.purchase_order_lines(id),
  grn_line_id   uuid references proc.grn_lines(id),
  item_id       uuid not null references inv.items(id),
  quantity      numeric(18,6) not null check (quantity > 0),
  uom_id        uuid not null references inv.uoms(id),
  unit_price    numeric(18,6) not null check (unit_price >= 0),
  tax_rate_id   uuid references acct.tax_rates(id),
  tax_amount    numeric(18,4) not null default 0,
  line_total    numeric(18,4) not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id),
  unique (invoice_id, line_no)
);

-- ---------------------------------------------------------------- DELIVERY
create table dlv.zones (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references org.companies(id),
  branch_id     uuid not null,
  code          citext not null,
  name          text not null,
  delivery_fee  numeric(18,4) not null default 0 check (delivery_fee >= 0),
  min_order_amount numeric(18,4) not null default 0 check (min_order_amount >= 0),
  free_delivery_above numeric(18,4),
  est_minutes   int,
  polygon       jsonb,                               -- GeoJSON polygon
  status        text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id),
  unique (branch_id, code)
);

create table dlv.riders (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references org.companies(id),
  branch_id   uuid not null,
  user_id     uuid references iam.users(id),
  code        citext not null,
  full_name   text not null,
  mobile      text not null,
  vehicle_type text check (vehicle_type in ('motorbike','car','bicycle','on_foot')),
  vehicle_plate text,
  is_third_party boolean not null default false,
  status      text not null default 'active' check (status in ('active','inactive','suspended')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id),
  unique (company_id, code)
);

create table dlv.deliveries (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references org.companies(id),
  branch_id       uuid not null,
  order_id        uuid not null unique references pos.orders(id),
  zone_id         uuid references dlv.zones(id),
  customer_address_id uuid references crm.customer_addresses(id),
  address_snapshot jsonb not null,
  rider_id        uuid references dlv.riders(id),
  scheduled_for   timestamptz,
  assigned_at timestamptz, dispatched_at timestamptz, picked_up_at timestamptz, delivered_at timestamptz,
  cash_to_collect numeric(18,4) not null default 0 check (cash_to_collect >= 0),
  cash_collected  numeric(18,4) not null default 0 check (cash_collected >= 0),
  handed_over_at  timestamptz,
  failure_reason  text,
  status          text not null default 'pending' check (status in ('pending','assigned','dispatched','picked_up','delivered','undelivered','returned','cancelled')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id)
);
create index deliveries_rider_idx on dlv.deliveries(rider_id, status);

-- ---------------------------------------------------------------- AGGREGATORS
create table agg.aggregators (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references org.companies(id),
  code          citext not null,                     -- TALABAT, DELIVEROO, CAREEM, NOON
  name          text not null,
  channel_id    uuid not null references menu.sales_channels(id),
  integration_mode text not null default 'manual' check (integration_mode in ('api','webhook','manual')),
  commission_pct numeric(9,6) not null default 0 check (commission_pct >= 0 and commission_pct < 1),
  receivable_account_id uuid references acct.accounts(id),
  payment_method_id uuid references pay.payment_methods(id),
  status        text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  unique (company_id, code)
);

create table agg.branch_accounts (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references org.companies(id),
  branch_id     uuid not null,
  aggregator_id uuid not null references agg.aggregators(id),
  external_store_id text not null,
  credentials_secret_ref text,                       -- reference into the secret manager; secrets never stored here
  webhook_enabled boolean not null default false,
  status        text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id),
  unique (aggregator_id, external_store_id),
  unique (branch_id, aggregator_id)
);

create table agg.item_mappings (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references org.companies(id),
  aggregator_id  uuid not null references agg.aggregators(id),
  external_item_id text not null,
  mapping_type   text not null default 'item' check (mapping_type in ('item','variant','modifier')),
  menu_item_id   uuid references menu.items(id),
  variant_id     uuid references menu.item_variants(id),
  modifier_id    uuid references menu.modifiers(id),
  external_price numeric(18,4),
  status         text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  unique (aggregator_id, mapping_type, external_item_id),
  check (menu_item_id is not null or modifier_id is not null)
);

create table agg.external_orders (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references org.companies(id),
  branch_id       uuid not null,
  aggregator_id   uuid not null references agg.aggregators(id),
  external_order_id text not null,
  received_via    text not null check (received_via in ('webhook','api_poll','manual_import')),
  raw_payload     jsonb not null,
  order_id        uuid references pos.orders(id),
  gross_amount    numeric(18,4), commission_amount numeric(18,4), aggregator_discount numeric(18,4), net_receivable numeric(18,4),
  error_message   text,
  status          text not null default 'received' check (status in ('received','accepted','rejected','mapped','failed','cancelled')),
  received_at     timestamptz not null default now(),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id),
  unique (aggregator_id, external_order_id)            -- idempotent webhook reception
);
alter table pos.orders add constraint orders_aggregator_order_fk foreign key (aggregator_order_id) references agg.external_orders(id);

-- ---------------------------------------------------------------- LOYALTY
create table loy.programs (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references org.companies(id),
  code          citext not null,
  name          text not null,
  points_per_currency numeric(18,6) not null default 1 check (points_per_currency >= 0),
  currency_per_point  numeric(18,6) not null default 0.01 check (currency_per_point >= 0),
  points_expiry_days int,
  welcome_bonus_points numeric(18,4) not null default 0,
  referral_bonus_points numeric(18,4) not null default 0,
  birthday_bonus_points numeric(18,4) not null default 0,
  status        text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  unique (company_id, code)
);
create table loy.tiers (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references org.companies(id),
  program_id  uuid not null references loy.programs(id),
  code        citext not null,
  name        text not null,
  min_lifetime_points numeric(18,4) not null default 0,
  earn_multiplier numeric(9,4) not null default 1 check (earn_multiplier > 0),
  sort_order  int not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  unique (program_id, code)
);
create table loy.accounts (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references org.companies(id),
  program_id    uuid not null references loy.programs(id),
  customer_id   uuid not null references crm.customers(id),
  tier_id       uuid references loy.tiers(id),
  referred_by_customer_id uuid references crm.customers(id),
  enrolled_at   timestamptz not null default now(),
  status        text not null default 'active' check (status in ('active','suspended','closed')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  unique (program_id, customer_id)
);
create table loy.transactions (                        -- points ledger; balance = sum(points)
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references org.companies(id),
  branch_id     uuid,
  account_id    uuid not null references loy.accounts(id),
  txn_type      text not null check (txn_type in ('earn','redeem','expire','adjust','welcome','referral','birthday','reversal')),
  points        numeric(18,4) not null check (points <> 0),
  order_id      uuid references pos.orders(id),
  reversal_of_id uuid references loy.transactions(id),
  reason_code_id uuid references pos.reason_codes(id),
  approved_by   uuid references iam.users(id),
  expires_at    timestamptz,
  idempotency_key text not null,
  created_at    timestamptz not null default now(),
  created_by    uuid,
  unique (company_id, idempotency_key),
  -- every movement traces to an order or an authorized adjustment
  check (order_id is not null or reversal_of_id is not null or txn_type in ('welcome','referral','birthday','expire')
         or (txn_type = 'adjust' and approved_by is not null and reason_code_id is not null))
);
create index loy_txn_account_idx on loy.transactions(account_id, created_at);
create trigger loy_transactions_append_only before update or delete on loy.transactions for each row execute function app.forbid_mutation();

-- ---------------------------------------------------------------- MARKETING
create table mkt.consents (                            -- history of opt-in / opt-out (latest row wins)
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references org.companies(id),
  customer_id uuid not null references crm.customers(id),
  channel     text not null check (channel in ('whatsapp','sms','email','push')),
  opted_in    boolean not null,
  source      text not null,                          -- 'pos','online','whatsapp_reply','import'
  evidence    jsonb,
  recorded_at timestamptz not null default now(),
  created_by  uuid
);
create index consents_customer_idx on mkt.consents(customer_id, channel, recorded_at desc);
create trigger consents_append_only before update or delete on mkt.consents for each row execute function app.forbid_mutation();

create table mkt.provider_accounts (                   -- e.g. WhatsApp Business provider; secrets referenced, not stored
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references org.companies(id),
  provider    text not null,                          -- 'meta_cloud_api', 'twilio', ...
  channel     text not null check (channel in ('whatsapp','sms','email')),
  sender_id   text not null,
  credentials_secret_ref text,
  status      text not null default 'inactive' check (status in ('active','inactive')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  unique (company_id, provider, sender_id)
);
create table mkt.templates (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references org.companies(id),
  code        citext not null,
  channel     text not null check (channel in ('whatsapp','sms','email')),
  language    text not null default 'en',
  body        text not null,
  provider_template_name text,
  approval_status text not null default 'draft' check (approval_status in ('draft','submitted','approved','rejected')),
  status      text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  unique (company_id, code, language)
);
create table mkt.segments (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references org.companies(id),
  code        citext not null,
  name        text not null,
  rules       jsonb not null default '{}'::jsonb,      -- evaluated server-side
  status      text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  unique (company_id, code)
);
create table mkt.campaigns (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references org.companies(id),
  code        citext not null,
  name        text not null,
  campaign_type text not null check (campaign_type in ('promotional','birthday','inactive_customer','transactional','welcome')),
  segment_id  uuid references mkt.segments(id),
  template_id uuid not null references mkt.templates(id),
  provider_account_id uuid references mkt.provider_accounts(id),
  scheduled_at timestamptz,
  approved_by uuid, approved_at timestamptz,
  status      text not null default 'draft' check (status in ('draft','scheduled','running','completed','cancelled','failed')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  unique (company_id, code)
);
create table mkt.campaign_messages (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references org.companies(id),
  campaign_id  uuid not null references mkt.campaigns(id),
  customer_id  uuid not null references crm.customers(id),
  to_address   text not null,
  provider_message_id text,
  sent_at timestamptz, delivered_at timestamptz, read_at timestamptz, failed_at timestamptz,
  error        text,
  status       text not null default 'queued' check (status in ('queued','sent','delivered','read','failed','skipped_no_consent')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  unique (campaign_id, customer_id)
);

-- ---------------------------------------------------------------- EXPENSES
create table exp.categories (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references org.companies(id),
  code        citext not null,
  name        text not null,
  expense_account_id uuid references acct.accounts(id),
  status      text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  unique (company_id, code)
);
create table exp.expenses (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references org.companies(id),
  branch_id    uuid not null,
  doc_no       text not null,
  expense_date date not null,
  category_id  uuid not null references exp.categories(id),
  supplier_id  uuid references supl.suppliers(id),
  description  text not null,
  amount       numeric(18,4) not null check (amount > 0),
  tax_rate_id  uuid references acct.tax_rates(id),
  tax_amount   numeric(18,4) not null default 0 check (tax_amount >= 0),
  paid_from    text not null check (paid_from in ('shift_cash','petty_cash','bank','card','payable')),
  shift_id     uuid references pos.shifts(id),
  attachment_url text,
  approved_by uuid, approved_at timestamptz,
  journal_entry_id uuid,
  status       text not null default 'draft' check (status in ('draft','submitted','approved','posted','rejected','cancelled')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id),
  unique (branch_id, doc_no),
  check (paid_from <> 'shift_cash' or shift_id is not null)
);

-- ---------------------------------------------------------------- ACCOUNTING JOURNALS
create table acct.journal_entries (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references org.companies(id),
  branch_id       uuid,
  entry_no        text not null,
  entry_date      date not null,
  fiscal_period_id uuid references acct.fiscal_periods(id),
  source_doc_type text not null,                      -- 'pos.order','pay.payment','proc.purchase_invoice','exp.expense','manual'
  source_doc_id   uuid,
  description     text,
  reversal_of_id  uuid references acct.journal_entries(id),
  posted_by uuid, posted_at timestamptz,
  idempotency_key text not null,
  status          text not null default 'draft' check (status in ('draft','posted','reversed')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id),
  unique (company_id, entry_no),
  unique (company_id, idempotency_key)
);
create index journal_entries_source_idx on acct.journal_entries(source_doc_type, source_doc_id);
create index journal_entries_date_idx on acct.journal_entries(company_id, entry_date);

create table acct.journal_lines (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references org.companies(id),
  branch_id     uuid,
  entry_id      uuid not null references acct.journal_entries(id),
  line_no       int not null,
  account_id    uuid not null references acct.accounts(id),
  debit         numeric(18,4) not null default 0 check (debit >= 0),
  credit        numeric(18,4) not null default 0 check (credit >= 0),
  tax_rate_id   uuid references acct.tax_rates(id),
  description   text,
  source_line_id uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  unique (entry_id, line_no),
  check ((debit > 0 and credit = 0) or (credit > 0 and debit = 0))
);
create index journal_lines_account_idx on acct.journal_lines(account_id);

-- posted entries are immutable; posting requires balance
create or replace function acct.guard_journal_entry() returns trigger language plpgsql as $$
declare v_dr numeric; v_cr numeric; v_n int;
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then raise exception 'posted journal % cannot be deleted', old.entry_no using errcode = 'P0001'; end if;
    return old;
  end if;
  if old.status = 'posted' and not (new.status = 'reversed' and
       (new.entry_date, new.company_id, new.branch_id, new.source_doc_id) is not distinct from (old.entry_date, old.company_id, old.branch_id, old.source_doc_id)) then
    raise exception 'posted journal % is immutable; post a reversal', old.entry_no using errcode = 'P0001';
  end if;
  if old.status = 'reversed' then raise exception 'reversed journal % is immutable', old.entry_no using errcode = 'P0001'; end if;
  if new.status = 'posted' and old.status = 'draft' then
    select coalesce(sum(debit),0), coalesce(sum(credit),0), count(*) into v_dr, v_cr, v_n from acct.journal_lines where entry_id = new.id;
    if v_n < 2 or v_dr <> v_cr or v_dr = 0 then
      raise exception 'journal % is not balanced (debit %, credit %, lines %)', new.entry_no, v_dr, v_cr, v_n using errcode = 'P0003';
    end if;
    if exists (select 1 from acct.fiscal_periods fp where fp.company_id = new.company_id and fp.status = 'closed'
               and new.entry_date between fp.start_date and fp.end_date) then
      raise exception 'fiscal period for % is closed', new.entry_date using errcode = 'P0001';
    end if;
    new.posted_at := coalesce(new.posted_at, now());
    new.posted_by := coalesce(new.posted_by, app.current_user_id());
  end if;
  return new;
end $$;
create trigger journal_entries_guard before update or delete on acct.journal_entries for each row execute function acct.guard_journal_entry();

create or replace function acct.guard_journal_line() returns trigger language plpgsql as $$
declare v_status text;
begin
  select status into v_status from acct.journal_entries where id = coalesce(new.entry_id, old.entry_id);
  if v_status <> 'draft' then
    raise exception 'lines of a % journal are immutable', v_status using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end $$;
create trigger journal_lines_guard before insert or update or delete on acct.journal_lines for each row execute function acct.guard_journal_line();

alter table proc.purchase_invoices add constraint purchase_invoices_journal_fk foreign key (journal_entry_id) references acct.journal_entries(id);
alter table exp.expenses add constraint expenses_journal_fk foreign key (journal_entry_id) references acct.journal_entries(id);
