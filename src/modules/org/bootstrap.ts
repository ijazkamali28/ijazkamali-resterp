/**
 * Tenant bootstrap: creates a company with its configurable starting set-up
 * (roles, sales channels, UAE VAT rates, chart of accounts, units, payment
 * methods, reason codes). These are editable master records, not hard-coded
 * values: all later calculations read them from the database.
 */
import type { Tx } from '../../db/pool.js';
import { ROLES } from '../../auth/permissions.js';
import { uuidv7 } from '../../lib/uuid.js';

export interface NewCompany {
  code: string; legalName: string; tradeName?: string; vatRegistrationNo?: string;
  baseCurrency?: string; timezone?: string; pricesIncludeTax?: boolean;
}

export async function createCompany(tx: Tx, c: NewCompany): Promise<string> {
  const id = uuidv7();
  await tx.query(
    `insert into org.companies(id, code, legal_name, trade_name, vat_registration_no, base_currency, timezone, prices_include_tax)
     values ($1,$2,$3,$4,$5,coalesce($6,'AED'),coalesce($7,'Asia/Dubai'),coalesce($8,true))`,
    [id, c.code, c.legalName, c.tradeName ?? null, c.vatRegistrationNo ?? null, c.baseCurrency ?? null, c.timezone ?? null, c.pricesIncludeTax ?? null]);

  // company-scoped copies of the standard roles (customisable per company)
  for (const r of ROLES.filter((r) => r.scope !== 'platform')) {
    const roleId = uuidv7();
    await tx.query(`insert into iam.roles(id, company_id, code, name, description, is_system, scope) values ($1,$2,$3,$4,$5,true,$6)`,
      [roleId, id, r.code, r.name, r.description, r.scope]);
    await tx.query(`insert into iam.role_permissions(role_id, permission_code, company_id) select $1, unnest($2::text[]), $3`, [roleId, r.permissions, id]);
  }

  const channels: [string, string, string][] = [
    ['DINE_IN', 'Dine-in', 'dine_in'], ['TAKEAWAY', 'Takeaway', 'takeaway'], ['DELIVERY', 'Delivery', 'delivery'], ['ONLINE', 'Online ordering', 'online'],
    ['TALABAT', 'Talabat', 'aggregator'], ['DELIVEROO', 'Deliveroo', 'aggregator'], ['CAREEM', 'Careem', 'aggregator'], ['NOON', 'Noon Food', 'aggregator'],
  ];
  for (const [code, name, type] of channels) {
    await tx.query(`insert into menu.sales_channels(id, company_id, code, name, channel_type) values ($1,$2,$3,$4,$5)`, [uuidv7(), id, code, name, type]);
  }

  // chart of accounts (minimal restaurant CoA; extend in Phase 8)
  const coa: [string, string, string, string | null, boolean][] = [
    ['1000', 'Assets', 'asset', null, false],
    ['1100', 'Cash on hand', 'asset', 'cash', true], ['1110', 'Card clearing', 'asset', 'card_clearing', true],
    ['1120', 'Online payment clearing', 'asset', 'online_clearing', true], ['1130', 'Aggregator receivables', 'asset', 'aggregator_receivable', true],
    ['1140', 'Bank', 'asset', 'bank', true], ['1200', 'Inventory', 'asset', 'inventory', true], ['1300', 'VAT input (recoverable)', 'asset', 'vat_input', true],
    ['2000', 'Liabilities', 'liability', null, false],
    ['2100', 'Accounts payable', 'liability', 'accounts_payable', true], ['2200', 'VAT output payable', 'liability', 'vat_output', true],
    ['2300', 'GRN accrual (received not invoiced)', 'liability', 'grni', true], ['2400', 'Customer deposits / gift cards', 'liability', 'customer_deposits', true],
    ['2500', 'Loyalty points liability', 'liability', 'loyalty_liability', true],
    ['3000', 'Equity', 'equity', 'equity', true],
    ['4000', 'Revenue', 'revenue', null, false],
    ['4100', 'Food sales', 'revenue', 'sales_food', true], ['4200', 'Beverage sales', 'revenue', 'sales_beverage', true],
    ['4300', 'Delivery fee income', 'revenue', 'delivery_income', true], ['4900', 'Sales discounts (contra)', 'revenue', 'sales_discounts', true],
    ['5000', 'Cost of sales', 'expense', 'cogs', true], ['5100', 'Wastage & spoilage', 'expense', 'wastage', true],
    ['5200', 'Inventory variance', 'expense', 'inventory_variance', true], ['5300', 'Purchase price variance', 'expense', 'ppv', true],
    ['6000', 'Operating expenses', 'expense', null, false],
    ['6100', 'Aggregator commissions', 'expense', 'aggregator_commission', true], ['6200', 'Card & gateway fees', 'expense', 'payment_fees', true],
    ['6300', 'Cash over/short', 'expense', 'cash_variance', true], ['6400', 'General expenses', 'expense', 'general_expense', true],
  ];
  const acc: Record<string, string> = {};
  for (const [code, name, type, key, postable] of coa) {
    const accId = uuidv7();
    acc[key ?? code] = accId;
    const parent = postable ? acc[code.slice(0, 1) + '000'] ?? null : null;
    await tx.query(`insert into acct.accounts(id, company_id, code, name, account_type, parent_id, is_postable, system_key) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [accId, id, code, name, type, parent, postable, key]);
  }

  await tx.query(
    `insert into acct.tax_rates(id, company_id, code, name, rate, tax_type, output_account_id, input_account_id, effective_from) values
     ($1,$4,'VAT5','UAE VAT standard rate 5%',0.05,'vat',$5,$6,'2018-01-01'),
     ($2,$4,'ZERO','UAE VAT zero-rated',0,'vat',$5,$6,'2018-01-01'),
     ($3,$4,'EXEMPT','VAT exempt',0,'vat',null,null,'2018-01-01')`,
    [uuidv7(), uuidv7(), uuidv7(), id, acc.vat_output, acc.vat_input]);

  const uoms: [string, string, string][] = [
    ['KG', 'Kilogram', 'mass'], ['G', 'Gram', 'mass'], ['L', 'Litre', 'volume'], ['ML', 'Millilitre', 'volume'], ['PCS', 'Piece', 'count'], ['DOZ', 'Dozen', 'count'],
  ];
  const u: Record<string, string> = {};
  for (const [code, name, dim] of uoms) { u[code] = uuidv7(); await tx.query(`insert into inv.uoms(id, company_id, code, name, dimension) values ($1,$2,$3,$4,$5)`, [u[code], id, code, name, dim]); }
  for (const [f, t, factor] of [['KG', 'G', 1000], ['G', 'KG', 0.001], ['L', 'ML', 1000], ['ML', 'L', 0.001], ['DOZ', 'PCS', 12], ['PCS', 'DOZ', 1 / 12]] as const) {
    await tx.query(`insert into inv.uom_conversions(id, company_id, from_uom_id, to_uom_id, factor) values ($1,$2,$3,$4,$5)`, [uuidv7(), id, u[f], u[t], factor]);
  }

  const methods: [string, string, string, string, boolean][] = [
    ['CASH', 'Cash', 'cash', acc.cash, true], ['CARD', 'Credit/Debit card', 'card', acc.card_clearing, false],
    ['ONLINE', 'Online payment', 'online', acc.online_clearing, false], ['GATEWAY', 'Payment gateway', 'gateway', acc.online_clearing, false],
    ['AGGREGATOR', 'Aggregator collected', 'aggregator', acc.aggregator_receivable, false],
  ];
  for (const [code, name, type, account, drawer] of methods) {
    await tx.query(`insert into pay.payment_methods(id, company_id, code, name, method_type, account_id, opens_drawer, allows_change) values ($1,$2,$3,$4,$5,$6,$7,$7)`,
      [uuidv7(), id, code, name, type, account, drawer]);
  }

  const reasons: [string, string, string, boolean][] = [
    ['VOID_WRONG_ITEM', 'item_void', 'Wrong item entered', false], ['VOID_CUSTOMER_CHANGE', 'item_void', 'Customer changed mind', true],
    ['VOID_KITCHEN_ERROR', 'item_void', 'Kitchen error', true], ['ORDER_CUSTOMER_LEFT', 'order_void', 'Customer left', true],
    ['DISC_MANAGER', 'discount', 'Manager discretionary discount', true], ['DISC_COMPLAINT', 'discount', 'Service recovery', true],
    ['COMP_VIP', 'complimentary', 'VIP / guest relations', true], ['COMP_STAFF', 'complimentary', 'Staff meal', true],
    ['PRICE_OPEN', 'price_change', 'Open price item', true], ['REFUND_QUALITY', 'refund', 'Food quality complaint', true],
    ['REFUND_WRONG_ORDER', 'refund', 'Wrong order delivered', true], ['CANCEL_CUSTOMER', 'cancellation', 'Cancelled by customer', true],
    ['REOPEN_CORRECTION', 'reopen', 'Bill correction', true], ['REPRINT_CUSTOMER', 'reprint', 'Customer copy', false],
    ['CASH_SHORT', 'cash_variance', 'Cash shortage', true], ['CASH_OVER', 'cash_variance', 'Cash excess', true],
    ['ADJ_DAMAGE', 'stock_adjustment', 'Damaged stock', true], ['ADJ_COUNT', 'stock_adjustment', 'Count correction', true],
    ['WASTE_EXPIRED', 'wastage', 'Expired', false], ['WASTE_SPOILED', 'wastage', 'Spoiled', false], ['WASTE_PREP', 'wastage', 'Preparation error', false],
  ];
  for (const [code, cat, desc, appr] of reasons) {
    await tx.query(`insert into pos.reason_codes(id, company_id, code, category, description, requires_approval) values ($1,$2,$3,$4,$5,$6)`,
      [uuidv7(), id, code, cat, desc, appr]);
  }
  return id;
}

/** Creates a branch together with its default warehouses, tax setting and payment-method enablement. */
export async function createBranchDefaults(tx: Tx, companyId: string, branchId: string, branchCode: string) {
  for (const [code, name, type] of [['MAIN', 'Main store', 'store'], ['KITCHEN', 'Kitchen', 'kitchen']]) {
    await tx.query(`insert into inv.warehouses(id, company_id, branch_id, code, name, warehouse_type, allow_negative_stock) values ($1,$2,$3,$4,$5,$6,$7)`,
      [uuidv7(), companyId, branchId, `${branchCode}-${code}`, name, type, type === 'kitchen']);
  }
  await tx.query(
    `insert into acct.branch_tax_settings(id, company_id, branch_id, default_tax_rate_id, prices_include_tax)
     select $1, $2, $3, t.id, c.prices_include_tax from acct.tax_rates t join org.companies c on c.id = t.company_id where t.company_id = $2 and t.code = 'VAT5'`,
    [uuidv7(), companyId, branchId]);
  await tx.query(
    `insert into pay.branch_payment_methods(id, company_id, branch_id, payment_method_id)
     select gen_random_uuid(), $1, $2, id from pay.payment_methods where company_id = $1 and status = 'active'`, [companyId, branchId]);
}
