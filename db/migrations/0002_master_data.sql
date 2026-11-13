-- =====================================================================
-- 0002 MASTER DATA DOMAINS: accounting & tax masters, customers, kitchen
-- stations, menu & pricing, inventory masters, suppliers, recipes.
-- Owned by cloud (authored centrally, replicated to branch servers),
-- except customers which are 'shared'.
-- =====================================================================

-- ---------------------------------------------------------------- ACCOUNTING MASTERS
create table acct.accounts (                          -- chart of accounts
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references org.companies(id),
  code         citext not null,
  name         text not null,
  account_type text not null check (account_type in ('asset','liability','equity','revenue','expense')),
  parent_id    uuid references acct.accounts(id),
  is_postable  boolean not null default true,         -- false = header/group account
  system_key   text,                                  -- e.g. 'cash','vat_output','inventory','cogs' for posting rules
  status       text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  unique (company_id, code),
  unique (company_id, id)
);
create unique index accounts_system_key_uq on acct.accounts(company_id, system_key) where system_key is not null;
create index accounts_parent_idx on acct.accounts(parent_id);

create table acct.tax_rates (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references org.companies(id),
  code        citext not null,                       -- 'VAT5', 'ZERO', 'EXEMPT'
  name        text not null,
  rate        numeric(9,6) not null check (rate >= 0 and rate < 1),   -- 0.05 = 5%
  tax_type    text not null default 'vat' check (tax_type in ('vat','municipality','service_charge','other')),
  output_account_id uuid references acct.accounts(id),
  input_account_id  uuid references acct.accounts(id),
  effective_from date not null default current_date,
  effective_to   date,
  status      text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  unique (company_id, code),
  check (effective_to is null or effective_to >= effective_from)
);

create table acct.branch_tax_settings (               -- branch-specific tax configuration
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references org.companies(id),
  branch_id   uuid not null,
  default_tax_rate_id uuid not null references acct.tax_rates(id),
  prices_include_tax boolean not null default true,
  rounding_mode text not null default 'half_up' check (rounding_mode in ('half_up','half_even','down','up')),
  rounding_increment numeric(9,4) not null default 0.01,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id),
  unique (branch_id)
);

create table acct.fiscal_periods (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references org.companies(id),
  code        citext not null,                       -- '2026-11'
  start_date  date not null,
  end_date    date not null,
  status      text not null default 'open' check (status in ('open','soft_closed','closed')),
  closed_by   uuid, closed_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  unique (company_id, code),
  check (end_date >= start_date)
);

-- ---------------------------------------------------------------- CUSTOMERS
create table crm.customers (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references org.companies(id),
  code          citext not null,
  full_name     text not null,
  mobile        text,                                 -- E.164, e.g. +9715XXXXXXXX
  whatsapp_number text,
  email         citext,
  birth_date    date,
  gender        text check (gender in ('male','female','other','unspecified')),
  segment       text,
  home_branch_id uuid,
  notes         text,
  -- aggregates maintained by CRM jobs (never used as source of truth for finance)
  lifetime_value numeric(18,4) not null default 0,
  order_count   int not null default 0,
  last_order_at timestamptz,
  status        text not null default 'active' check (status in ('active','inactive','blocked')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  unique (company_id, code),
  foreign key (company_id, home_branch_id) references org.branches(company_id, id)
);
create unique index customers_mobile_uq on crm.customers(company_id, mobile) where mobile is not null;
create index customers_name_idx on crm.customers(company_id, lower(full_name));

create table crm.customer_addresses (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references org.companies(id),
  customer_id  uuid not null references crm.customers(id) on delete cascade,
  label        text not null default 'home',
  address_line text not null,
  building     text, flat text, area text, city text, emirate text,
  landmark     text,
  latitude     numeric(9,6), longitude numeric(9,6),
  is_default   boolean not null default false,
  status       text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1
);
create index customer_addresses_customer_idx on crm.customer_addresses(customer_id);
create unique index customer_addresses_default_uq on crm.customer_addresses(customer_id) where is_default;

-- ---------------------------------------------------------------- KITCHEN STATIONS
create table kds.stations (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references org.companies(id),
  branch_id   uuid not null,
  code        citext not null,
  name        text not null,
  station_type text not null check (station_type in ('hot','bbq','grill','seafood','cold','beverage','dessert','packing','other')),
  printer_name text,
  target_prep_seconds int not null default 900 check (target_prep_seconds > 0),
  sort_order  int not null default 0,
  status      text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id),
  unique (branch_id, code),
  unique (company_id, id)
);

-- ---------------------------------------------------------------- INVENTORY MASTERS
create table inv.uoms (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references org.companies(id),
  code        citext not null,                       -- 'KG','G','L','ML','PCS','BOX'
  name        text not null,
  dimension   text not null check (dimension in ('mass','volume','count','length')),
  status      text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  unique (company_id, code)
);

create table inv.stock_categories (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references org.companies(id),
  code        citext not null,
  name        text not null,
  parent_id   uuid references inv.stock_categories(id),
  status      text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  unique (company_id, code)
);

create table inv.items (                              -- ingredients, raw materials, packaging, prepared (sub-recipe) items
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references org.companies(id),
  code          citext not null,
  name          text not null,
  item_type     text not null check (item_type in ('ingredient','raw_material','packaging','prepared','consumable')),
  category_id   uuid references inv.stock_categories(id),
  base_uom_id   uuid not null references inv.uoms(id),   -- stock is always held in base UoM
  purchase_uom_id uuid references inv.uoms(id),
  is_batch_tracked boolean not null default false,
  is_expiry_tracked boolean not null default false,
  shelf_life_days int check (shelf_life_days is null or shelf_life_days > 0),
  reorder_level numeric(18,6) check (reorder_level is null or reorder_level >= 0),
  tax_rate_id   uuid references acct.tax_rates(id),
  inventory_account_id uuid references acct.accounts(id),
  cogs_account_id uuid references acct.accounts(id),
  barcode       text,
  status        text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  unique (company_id, code)
);
create index inv_items_category_idx on inv.items(category_id);
create unique index inv_items_barcode_uq on inv.items(company_id, barcode) where barcode is not null;

create table inv.uom_conversions (                    -- item_id null = generic (KG->G); item-specific overrides (BOX of tomatoes)
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references org.companies(id),
  item_id      uuid references inv.items(id),
  from_uom_id  uuid not null references inv.uoms(id),
  to_uom_id    uuid not null references inv.uoms(id),
  factor       numeric(20,10) not null check (factor > 0),   -- qty_to = qty_from * factor
  status       text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  check (from_uom_id <> to_uom_id)
);
create unique index uom_conversions_uq on inv.uom_conversions(company_id, coalesce(item_id, '00000000-0000-0000-0000-000000000000'::uuid), from_uom_id, to_uom_id);

create table inv.warehouses (                         -- branch-specific stores (main store, kitchen, bar)
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references org.companies(id),
  branch_id   uuid not null,
  code        citext not null,
  name        text not null,
  warehouse_type text not null default 'store' check (warehouse_type in ('store','kitchen','bar','central_kitchen','transit')),
  allow_negative_stock boolean not null default false,
  status      text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id),
  unique (company_id, code),
  unique (company_id, id)
);
create index warehouses_branch_idx on inv.warehouses(branch_id);

create table inv.storage_locations (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references org.companies(id),
  branch_id    uuid not null,
  warehouse_id uuid not null references inv.warehouses(id),
  code         citext not null,
  name         text not null,
  storage_type text not null default 'dry' check (storage_type in ('dry','chiller','freezer','ambient','other')),
  status       text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id),
  unique (warehouse_id, code)
);

-- ---------------------------------------------------------------- SUPPLIERS
create table supl.suppliers (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references org.companies(id),
  code            citext not null,
  name            text not null,
  category        text,
  contact_person  text,
  mobile          text,
  phone           text,
  email           citext,
  address         text,
  vat_registration_no text check (vat_registration_no is null or vat_registration_no ~ '^[0-9]{15}$'),
  payment_terms_days int not null default 0 check (payment_terms_days >= 0),
  credit_limit    numeric(18,4) check (credit_limit is null or credit_limit >= 0),
  payable_account_id uuid references acct.accounts(id),
  status          text not null default 'active' check (status in ('active','inactive','blocked')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  unique (company_id, code)
);
create unique index suppliers_trn_uq on supl.suppliers(company_id, vat_registration_no) where vat_registration_no is not null;

-- restricted table: separate permission 'supplier.bank.view', never replicated to branch servers
create table supl.supplier_bank_accounts (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references org.companies(id),
  supplier_id   uuid not null references supl.suppliers(id),
  bank_name     text not null,
  account_name  text not null,
  iban          text not null check (iban ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$'),
  swift_code    text,
  is_primary    boolean not null default false,
  status        text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  unique (supplier_id, iban)
);

-- ---------------------------------------------------------------- MENU
create table menu.categories (                        -- parent_id null = category, set = subcategory
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references org.companies(id),
  code        citext not null,
  name        text not null,
  name_ar     text,
  parent_id   uuid references menu.categories(id),
  image_url   text,
  sort_order  int not null default 0,
  status      text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  unique (company_id, code),
  check (parent_id is null or parent_id <> id)
);
create index menu_categories_parent_idx on menu.categories(parent_id);

create table menu.items (                             -- dishes, beverages, combos
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references org.companies(id),
  code          citext not null,
  name          text not null,
  name_ar       text,
  description   text,
  category_id   uuid not null references menu.categories(id),
  item_kind     text not null default 'dish' check (item_kind in ('dish','beverage','combo','addon','service')),
  station_type  text check (station_type in ('hot','bbq','grill','seafood','cold','beverage','dessert','packing','other')),  -- routed to branch station of this type
  tax_rate_id   uuid references acct.tax_rates(id),
  revenue_account_id uuid references acct.accounts(id),
  image_url     text,
  prep_time_seconds int check (prep_time_seconds is null or prep_time_seconds > 0),
  is_open_price boolean not null default false,
  track_inventory boolean not null default true,
  sort_order    int not null default 0,
  status        text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  unique (company_id, code)
);
create index menu_items_category_idx on menu.items(category_id);
create index menu_items_name_idx on menu.items(company_id, lower(name));

create table menu.item_variants (                     -- portion sizes (Regular/Large/Half/Full)
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references org.companies(id),
  item_id     uuid not null references menu.items(id) on delete cascade,
  code        citext not null,
  name        text not null,
  is_default  boolean not null default false,
  sort_order  int not null default 0,
  status      text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  unique (item_id, code)
);
create unique index item_variants_default_uq on menu.item_variants(item_id) where is_default;

create table menu.modifier_groups (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references org.companies(id),
  code        citext not null,
  name        text not null,
  min_select  int not null default 0 check (min_select >= 0),
  max_select  int check (max_select is null or max_select >= 1),
  status      text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  unique (company_id, code),
  check (max_select is null or max_select >= min_select)
);

create table menu.modifiers (                         -- modifier options & add-ons
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references org.companies(id),
  group_id    uuid not null references menu.modifier_groups(id),
  code        citext not null,
  name        text not null,
  price_delta numeric(18,4) not null default 0,
  inv_item_id uuid references inv.items(id),         -- optional stock consumption
  inv_qty     numeric(18,6) check (inv_qty is null or inv_qty > 0),
  sort_order  int not null default 0,
  status      text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  unique (group_id, code)
);

create table menu.item_modifier_groups (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references org.companies(id),
  item_id     uuid not null references menu.items(id) on delete cascade,
  group_id    uuid not null references menu.modifier_groups(id),
  sort_order  int not null default 0,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  unique (item_id, group_id)
);

create table menu.combo_components (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references org.companies(id),
  combo_item_id uuid not null references menu.items(id) on delete cascade,
  component_item_id uuid not null references menu.items(id),
  component_variant_id uuid references menu.item_variants(id),
  quantity      numeric(18,6) not null default 1 check (quantity > 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  check (combo_item_id <> component_item_id)
);
create index combo_components_combo_idx on menu.combo_components(combo_item_id);

create table menu.item_branch_availability (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references org.companies(id),
  branch_id   uuid not null,
  item_id     uuid not null references menu.items(id) on delete cascade,
  is_available boolean not null default true,
  available_from time, available_to time,             -- e.g. breakfast hours
  station_id  uuid references kds.stations(id),       -- branch override of routing
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id),
  unique (branch_id, item_id)
);

-- Sales channels; aggregators are channels too (one row per aggregator)
create table menu.sales_channels (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references org.companies(id),
  code        citext not null,                       -- DINE_IN, TAKEAWAY, DELIVERY, ONLINE, TALABAT, DELIVEROO ...
  name        text not null,
  channel_type text not null check (channel_type in ('dine_in','takeaway','delivery','online','aggregator')),
  status      text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  unique (company_id, code)
);

-- Price records are never overwritten: a change creates a new row with a new effective_from.
create table menu.item_prices (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references org.companies(id),
  branch_id     uuid,                                -- null = all branches
  channel_id    uuid,                                -- null = all channels
  item_id       uuid not null references menu.items(id),
  variant_id    uuid references menu.item_variants(id),
  price         numeric(18,4) not null check (price >= 0),
  price_includes_tax boolean not null default true,
  effective_from timestamptz not null default now(),
  effective_to  timestamptz,
  approval_status text not null default 'approved' check (approval_status in ('pending','approved','rejected')),
  requested_by  uuid, approved_by uuid, approved_at timestamptz,
  change_reason text,
  status        text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  foreign key (company_id, branch_id) references org.branches(company_id, id),
  foreign key (channel_id) references menu.sales_channels(id),
  check (effective_to is null or effective_to > effective_from)
);
create index item_prices_lookup_idx on menu.item_prices(company_id, item_id, variant_id, branch_id, channel_id, effective_from desc);

-- ---------------------------------------------------------------- RECIPES
create table recipe.recipes (                         -- versioned; one active version per output per period
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references org.companies(id),
  code          citext not null,
  name          text not null,
  menu_item_id  uuid references menu.items(id),      -- dish recipe
  variant_id    uuid references menu.item_variants(id),
  output_item_id uuid references inv.items(id),      -- sub-recipe / production recipe producing a stock item
  version_no    int not null default 1 check (version_no > 0),
  yield_qty     numeric(18,6) not null default 1 check (yield_qty > 0),
  yield_uom_id  uuid references inv.uoms(id),
  portion_count numeric(18,6) not null default 1 check (portion_count > 0),
  effective_from timestamptz not null default now(),
  effective_to  timestamptz,
  approved_by   uuid, approved_at timestamptz,
  notes         text,
  status        text not null default 'draft' check (status in ('draft','active','retired')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  unique (company_id, code, version_no),
  check (menu_item_id is not null or output_item_id is not null)
);
create index recipes_menu_item_idx on recipe.recipes(menu_item_id, variant_id, status);
create index recipes_output_item_idx on recipe.recipes(output_item_id, status);

create table recipe.recipe_lines (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references org.companies(id),
  recipe_id     uuid not null references recipe.recipes(id) on delete cascade,
  line_no       int not null,
  inv_item_id   uuid not null references inv.items(id),   -- prepared items expand via their own recipe
  quantity      numeric(18,6) not null check (quantity > 0),
  uom_id        uuid not null references inv.uoms(id),
  prep_loss_pct numeric(9,6) not null default 0 check (prep_loss_pct >= 0 and prep_loss_pct < 1),
  cooking_loss_pct numeric(9,6) not null default 0 check (cooking_loss_pct >= 0 and cooking_loss_pct < 1),
  is_optional   boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid, updated_by uuid, row_version bigint not null default 1,
  unique (recipe_id, line_no)
);
create index recipe_lines_item_idx on recipe.recipe_lines(inv_item_id);
