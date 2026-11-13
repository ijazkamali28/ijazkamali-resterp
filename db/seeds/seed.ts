/**
 * Initial data: permission catalogue, platform role, platform super admin and a demo tenant
 * ("Demo Restaurants LLC", 3 UAE branches) with one user per standard role, plus a second
 * tenant used to prove company isolation. Sample menu/inventory records are ordinary
 * editable master data; opening stock is posted through the real inventory ledger.
 *
 * DEVELOPMENT/DEMO ONLY - refuses to run when NODE_ENV=production.
 */
import 'dotenv/config';
import pg from 'pg';
import { fileURLToPath } from 'node:url';
import { PERMISSIONS, ROLES } from '../../src/auth/permissions.js';
import { applyContext } from '../../src/db/pool.js';
import { createCompany, createBranchDefaults } from '../../src/modules/org/bootstrap.js';
import { hashSecret } from '../../src/lib/password.js';
import { uuidv7 } from '../../src/lib/uuid.js';

export const DEMO_PASSWORD = 'Demo@Pass2026';
export const ADMIN_PASSWORD = 'Admin@Pass2026';

export interface SeedResult {
  companyId: string; otherCompanyId: string;
  branches: Record<string, string>; users: Record<string, string>; roles: Record<string, string>;
}

export async function seed(ownerUrl: string, opts: { nodeType?: 'cloud' | 'branch_server'; log?: (m: string) => void } = {}): Promise<SeedResult> {
  if (process.env.NODE_ENV === 'production') throw new Error('demo seed must not run in production');
  const log = opts.log ?? console.log;
  const db = new pg.Client({ connectionString: ownerUrl });
  await db.connect();
  const q = (sql: string, params: unknown[] = []) => db.query(sql, params);
  try {
    await q('begin');
    await applyContext(db as any, { system: true });

    // ---- node identity + permission catalogue + platform role (owner-only tables)
    await q(`insert into sync.local_node(node_id, node_type) values ($1, $2) on conflict (singleton) do nothing`, [uuidv7(), opts.nodeType ?? 'cloud']);
    for (const p of PERMISSIONS) {
      await q(`insert into iam.permissions(code, module, description, is_sensitive) values ($1,$2,$3,$4)
               on conflict (code) do update set module = excluded.module, description = excluded.description, is_sensitive = excluded.is_sensitive`,
        [p.code, p.module, p.description, !!p.sensitive]);
    }
    const existing = await q(`select id from org.companies where code = 'DEMO'`);
    if (existing.rowCount) throw new Error('demo data already present; run `npm run db:reset` to rebuild');

    const superRole = uuidv7();
    await q(`insert into iam.roles(id, company_id, code, name, description, is_system, scope) values ($1, null, 'SUPER_ADMIN', 'Super Admin', 'Platform operator', true, 'platform')`, [superRole]);
    await q(`insert into iam.role_permissions(role_id, permission_code) select $1, code from iam.permissions`, [superRole]);

    const demoHash = () => hashSecret(DEMO_PASSWORD);   // fresh salt per user
    const adminId = uuidv7();
    await q(`insert into iam.users(id, company_id, email, full_name, password_hash) values ($1, null, 'superadmin@platform.local', 'Platform Super Admin', $2)`,
      [adminId, await hashSecret(ADMIN_PASSWORD)]);
    await q(`insert into iam.user_roles(id, user_id, role_id) values ($1,$2,$3)`, [uuidv7(), adminId, superRole]);

    // ---- tenant 1
    const companyId = await createCompany(db as any, {
      code: 'DEMO', legalName: 'Demo Restaurants LLC', tradeName: 'Al Bait Kitchen', vatRegistrationNo: '100000000000003',
    });
    const branches: Record<string, string> = {};
    for (const [code, name, city, emirate] of [
      ['JBR', 'Al Bait Kitchen - JBR', 'Dubai Marina', 'Dubai'],
      ['KHL', 'Al Bait Kitchen - Khalidiya', 'Abu Dhabi', 'Abu Dhabi'],
      ['ALM', 'Al Bait Kitchen - Al Majaz', 'Sharjah', 'Sharjah'],
    ]) {
      branches[code] = uuidv7();
      await q(`insert into org.branches(id, company_id, code, name, city, emirate, phone) values ($1,$2,$3,$4,$5,$6,'+97140000000')`,
        [branches[code], companyId, code, name, city, emirate]);
      await createBranchDefaults(db as any, companyId, branches[code], code);
    }

    const roles: Record<string, string> = Object.fromEntries(
      (await q('select code, id from iam.roles where company_id = $1', [companyId])).rows.map((r) => [r.code, r.id]));
    roles.SUPER_ADMIN = superRole;

    const users: Record<string, string> = { superadmin: adminId };
    const people: [string, string, string, string | null][] = [
      ['owner', 'Omar Owner', 'OWNER', null], ['gm', 'Grace General Manager', 'GENERAL_MANAGER', null],
      ['bm.jbr', 'Bilal Branch Manager JBR', 'BRANCH_MANAGER', 'JBR'], ['bm.khl', 'Khalid Branch Manager KHL', 'BRANCH_MANAGER', 'KHL'],
      ['cashier.jbr', 'Carla Cashier JBR', 'CASHIER', 'JBR'], ['cashier.khl', 'Kiran Cashier KHL', 'CASHIER', 'KHL'],
      ['waiter.jbr', 'Wael Waiter JBR', 'WAITER', 'JBR'], ['chef.jbr', 'Chen Chef JBR', 'CHEF', 'JBR'],
      ['inventory', 'Ivan Inventory Controller', 'INVENTORY_CONTROLLER', null], ['procurement', 'Priya Procurement Officer', 'PROCUREMENT_OFFICER', null],
      ['accountant', 'Amal Accountant', 'ACCOUNTANT', null], ['marketing', 'Maya Marketing Manager', 'MARKETING_MANAGER', null],
      ['rider.jbr', 'Rashid Rider JBR', 'RIDER', 'JBR'],
    ];
    for (const [key, name, role, branch] of people) {
      const id = uuidv7();
      users[key] = id;
      await q(`insert into iam.users(id, company_id, email, full_name, password_hash, default_branch_id) values ($1,$2,$3,$4,$5,$6)`,
        [id, companyId, `${key}@demo.ae`, name, await demoHash(), branch ? branches[branch] : null]);
      await q(`insert into iam.user_roles(id, user_id, role_id, company_id, branch_id) values ($1,$2,$3,$4,$5)`,
        [uuidv7(), id, roles[role], companyId, branch ? branches[branch] : null]);
    }

    // ---- kitchen stations, floor plan, devices
    for (const [bcode, bid] of Object.entries(branches)) {
      for (const [code, name, type, secs] of [['HOT', 'Hot kitchen', 'hot', 900], ['GRILL', 'Grill', 'grill', 1200], ['BBQ', 'BBQ', 'bbq', 1200],
        ['COLD', 'Cold kitchen', 'cold', 420], ['BEV', 'Beverage', 'beverage', 240], ['DESSERT', 'Dessert', 'dessert', 480], ['PACK', 'Packing', 'packing', 180]] as const) {
        await q(`insert into kds.stations(id, company_id, branch_id, code, name, station_type, target_prep_seconds, sort_order) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [uuidv7(), companyId, bid, code, name, type, secs, 0]);
      }
      const area = uuidv7();
      await q(`insert into pos.floor_areas(id, company_id, branch_id, code, name) values ($1,$2,$3,'MAIN','Main hall')`, [area, companyId, bid]);
      for (let t = 1; t <= 8; t++) {
        await q(`insert into pos.dining_tables(id, company_id, branch_id, floor_area_id, code, seats, layout) values ($1,$2,$3,$4,$5,$6,$7)`,
          [uuidv7(), companyId, bid, area, `T${t}`, t <= 4 ? 2 : 4, JSON.stringify({ x: ((t - 1) % 4) * 120, y: Math.floor((t - 1) / 4) * 120, shape: 'square' })]);
      }
      await q(`insert into dlv.zones(id, company_id, branch_id, code, name, delivery_fee, min_order_amount, est_minutes) values ($1,$2,$3,'Z1','Within 3 km',5,30,30),($4,$2,$3,'Z2','3-6 km',10,50,45)`,
        [uuidv7(), companyId, bid, uuidv7()]);
      await q(`insert into org.document_sequences(id, company_id, branch_id, doc_type, prefix) values ($1,$2,$3,'order',$4),($5,$2,$3,'inv_document',$6)`,
        [uuidv7(), companyId, bid, `${bcode}-`, uuidv7(), `${bcode}-INV-`]);
    }

    // ---- inventory masters
    const uom: Record<string, string> = Object.fromEntries((await q('select code, id from inv.uoms where company_id = $1', [companyId])).rows.map((r) => [r.code, r.id]));
    const cat = uuidv7();
    await q(`insert into inv.stock_categories(id, company_id, code, name) values ($1,$2,'FOOD','Food ingredients'),($3,$2,'PACK','Packaging')`, [cat, companyId, uuidv7()]);
    const inv: Record<string, string> = {};
    for (const [code, name, type, base] of [
      ['CHK', 'Chicken whole (cleaned)', 'ingredient', 'KG'], ['RICE', 'Basmati rice', 'raw_material', 'KG'], ['CHKP', 'Chickpeas (dry)', 'raw_material', 'KG'],
      ['TAH', 'Tahini', 'ingredient', 'KG'], ['LEM', 'Lemon', 'ingredient', 'PCS'], ['MINT', 'Fresh mint', 'ingredient', 'KG'],
      ['LAMB', 'Lamb (boneless)', 'ingredient', 'KG'], ['MILK', 'Fresh milk', 'ingredient', 'L'], ['SUGAR', 'Sugar', 'raw_material', 'KG'],
      ['BOX-M', 'Takeaway box (medium)', 'packaging', 'PCS'],
    ] as const) {
      inv[code] = uuidv7();
      await q(`insert into inv.items(id, company_id, code, name, item_type, category_id, base_uom_id, is_expiry_tracked) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [inv[code], companyId, code, name, type, cat, uom[base], type === 'ingredient']);
    }

    await q(`insert into supl.suppliers(id, company_id, code, name, category, contact_person, mobile, email, vat_registration_no, payment_terms_days)
             values ($1,$2,'SUP-FRESH','Emirates Fresh Produce Trading LLC','Produce','Sameer','+971500000001','orders@example.ae','100000000000011',30)`,
      [uuidv7(), companyId]);

    // ---- menu
    const tax = (await q(`select id from acct.tax_rates where company_id = $1 and code = 'VAT5'`, [companyId])).rows[0].id;
    const ch: Record<string, string> = Object.fromEntries((await q('select code, id from menu.sales_channels where company_id = $1', [companyId])).rows.map((r) => [r.code, r.id]));
    const mcat: Record<string, string> = {};
    for (const [code, name] of [['MAINS', 'Mains'], ['GRILLS', 'Grills'], ['STARTERS', 'Starters'], ['BEV', 'Beverages'], ['DESSERT', 'Desserts']]) {
      mcat[code] = uuidv7();
      await q(`insert into menu.categories(id, company_id, code, name) values ($1,$2,$3,$4)`, [mcat[code], companyId, code, name]);
    }
    const dish: Record<string, string> = {};
    for (const [code, name, catCode, station, price] of [
      ['MACHBOOS', 'Chicken Machboos', 'MAINS', 'hot', 42], ['MIXGRILL', 'Mixed Grill Platter', 'GRILLS', 'grill', 68],
      ['HUMMUS', 'Hummus', 'STARTERS', 'cold', 18], ['LEMINT', 'Fresh Lemon Mint', 'BEV', 'beverage', 16], ['UMMALI', 'Umm Ali', 'DESSERT', 'dessert', 22],
    ] as const) {
      dish[code] = uuidv7();
      await q(`insert into menu.items(id, company_id, code, name, category_id, station_type, tax_rate_id, item_kind) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [dish[code], companyId, code, name, mcat[catCode], station, tax, catCode === 'BEV' ? 'beverage' : 'dish']);
      // base price (all branches/channels) + aggregator uplift as separate price records
      await q(`insert into menu.item_prices(id, company_id, item_id, price, effective_from) values ($1,$2,$3,$4,'2026-01-01')`, [uuidv7(), companyId, dish[code], price]);
      await q(`insert into menu.item_prices(id, company_id, channel_id, item_id, price, effective_from) values ($1,$2,$3,$4,$5,'2026-01-01')`,
        [uuidv7(), companyId, ch.TALABAT, dish[code], Math.round(price * 1.15)]);
    }
    const sizes = (await q(`insert into menu.item_variants(id, company_id, item_id, code, name, is_default) values ($1,$2,$3,'REG','Regular',true),($4,$2,$3,'LRG','Large',false) returning id, code`,
      [uuidv7(), companyId, dish.LEMINT, uuidv7()])).rows;
    await q(`insert into menu.item_prices(id, company_id, item_id, variant_id, price, effective_from) values ($1,$2,$3,$4,22,'2026-01-01')`,
      [uuidv7(), companyId, dish.LEMINT, sizes.find((s) => s.code === 'LRG').id]);
    const mg = uuidv7();
    await q(`insert into menu.modifier_groups(id, company_id, code, name, min_select, max_select) values ($1,$2,'SPICE','Spice level',0,1)`, [mg, companyId]);
    await q(`insert into menu.modifiers(id, company_id, group_id, code, name) values ($1,$2,$3,'MILD','Mild'),($4,$2,$3,'HOT','Hot')`, [uuidv7(), companyId, mg, uuidv7()]);
    await q(`insert into menu.item_modifier_groups(id, company_id, item_id, group_id) values ($1,$2,$3,$4)`, [uuidv7(), companyId, dish.MACHBOOS, mg]);

    // ---- recipes (version 1, active)
    const recipes: [string, [string, number, string, number, number][]][] = [
      ['MACHBOOS', [['CHK', 250, 'G', 0.05, 0.2], ['RICE', 150, 'G', 0, 0], ['LEM', 0.5, 'PCS', 0, 0]]],
      ['HUMMUS', [['CHKP', 80, 'G', 0, 0], ['TAH', 30, 'G', 0, 0], ['LEM', 0.5, 'PCS', 0, 0]]],
      ['LEMINT', [['LEM', 2, 'PCS', 0, 0], ['MINT', 10, 'G', 0.1, 0], ['SUGAR', 20, 'G', 0, 0]]],
    ];
    for (const [d, lines] of recipes) {
      const rid = uuidv7();
      await q(`insert into recipe.recipes(id, company_id, code, name, menu_item_id, version_no, status, effective_from, approved_by, approved_at)
               values ($1,$2,$3,$4,$5,1,'active','2026-01-01',$6,now())`, [rid, companyId, `RCP-${d}`, `${d} standard recipe`, dish[d], users.gm]);
      let n = 1;
      for (const [item, qty, u, prep, cook] of lines) {
        await q(`insert into recipe.recipe_lines(id, company_id, recipe_id, line_no, inv_item_id, quantity, uom_id, prep_loss_pct, cooking_loss_pct) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [uuidv7(), companyId, rid, n++, inv[item], qty, uom[u], prep, cook]);
      }
    }

    // ---- opening stock (JBR main store) posted through the ledger, traceable to an inventory document
    const wh = (await q(`select id from inv.warehouses where branch_id = $1 and code = 'JBR-MAIN'`, [branches.JBR])).rows[0].id;
    const docId = uuidv7();
    await q(`insert into inv.documents(id, company_id, branch_id, doc_no, doc_type, doc_date, warehouse_id, status, posted_at, posted_by, approved_by, approved_at)
             values ($1,$2,$3,'JBR-INV-000001','opening','2026-11-01',$4,'posted',now(),$5,$5,now())`, [docId, companyId, branches.JBR, wh, users.inventory]);
    let ln = 1;
    for (const [item, qty, u, cost] of [['CHK', 40, 'KG', 18.5], ['RICE', 50, 'KG', 7.25], ['CHKP', 20, 'KG', 6], ['TAH', 10, 'KG', 22], ['LEM', 300, 'PCS', 0.35],
      ['MINT', 5, 'KG', 14], ['SUGAR', 25, 'KG', 3.8], ['BOX-M', 500, 'PCS', 0.9]] as const) {
      const lineId = uuidv7();
      await q(`insert into inv.document_lines(id, company_id, branch_id, document_id, line_no, item_id, quantity, uom_id, base_quantity, unit_cost) values ($1,$2,$3,$4,$5,$6,$7,$8,$7,$9)`,
        [lineId, companyId, branches.JBR, docId, ln++, inv[item], qty, uom[u], cost]);
      await q(`insert into inv.stock_ledger(company_id, branch_id, warehouse_id, item_id, movement_type, qty_in, unit_cost, business_date, source_doc_type, source_doc_id, source_line_id, idempotency_key, posted_by)
               values ($1,$2,$3,$4,'opening',$5,$6,'2026-11-01','inv.document',$7,$8,$9,$10)`,
        [companyId, branches.JBR, wh, inv[item], qty, cost, docId, lineId, `opening:${lineId}`, users.inventory]);
    }

    // ---- CRM + loyalty
    const cust = uuidv7();
    await q(`insert into crm.customers(id, company_id, code, full_name, mobile, whatsapp_number, email, birth_date, home_branch_id) values ($1,$2,'C000001','Sara Ahmed','+971501234567','+971501234567','sara@example.ae','1990-05-14',$3)`,
      [cust, companyId, branches.JBR]);
    await q(`insert into mkt.consents(id, company_id, customer_id, channel, opted_in, source) values ($1,$2,$3,'whatsapp',true,'pos')`, [uuidv7(), companyId, cust]);
    await q(`insert into loy.programs(id, company_id, code, name, points_per_currency, currency_per_point, points_expiry_days, welcome_bonus_points) values ($1,$2,'REWARDS','Al Bait Rewards',1,0.05,365,50)`,
      [uuidv7(), companyId]);

    // ---- tenant 2 (isolation)
    const otherCompanyId = await createCompany(db as any, { code: 'OTHER', legalName: 'Other Hospitality Group LLC' });
    const ob = uuidv7();
    branches.OTHER_DXB = ob;
    await q(`insert into org.branches(id, company_id, code, name, city, emirate) values ($1,$2,'DXB','Other Group - Downtown','Dubai','Dubai')`, [ob, otherCompanyId]);
    await createBranchDefaults(db as any, otherCompanyId, ob, 'DXB');
    const otherOwnerRole = (await q(`select id from iam.roles where company_id = $1 and code = 'OWNER'`, [otherCompanyId])).rows[0].id;
    users['owner.other'] = uuidv7();
    await q(`insert into iam.users(id, company_id, email, full_name, password_hash) values ($1,$2,'owner@other.ae','Other Owner',$3)`, [users['owner.other'], otherCompanyId, await demoHash()]);
    await q(`insert into iam.user_roles(id, user_id, role_id, company_id) values ($1,$2,$3,$4)`, [uuidv7(), users['owner.other'], otherOwnerRole, otherCompanyId]);
    await q(`insert into crm.customers(id, company_id, code, full_name, mobile) values ($1,$2,'C000001','Other Customer','+971509999999')`, [uuidv7(), otherCompanyId]);

    await q('commit');
    log(`seeded: 2 companies, ${Object.keys(branches).length} branches, ${Object.keys(users).length} users`);
    return { companyId, otherCompanyId, branches, users, roles };
  } catch (e) {
    await q('rollback');
    throw e;
  } finally {
    await db.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_OWNER_URL;
  if (!url) { console.error('DATABASE_OWNER_URL is required'); process.exit(1); }
  const ifEmpty = process.argv.includes('--if-empty');   // used by the Docker entrypoint on every start
  seed(url, { nodeType: (process.env.NODE_TYPE as any) ?? 'cloud' })
    .then(() => console.log(`demo users: <role>@demo.ae / ${DEMO_PASSWORD}; superadmin@platform.local / ${ADMIN_PASSWORD}`))
    .catch((e) => {
      if (ifEmpty && /demo data already present/.test(String(e?.message))) { console.log('demo data already present; skipping'); return; }
      console.error(e); process.exit(1);
    });
}
