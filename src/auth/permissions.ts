/**
 * Permission catalogue and initial role matrix.
 * Single source of truth: seeded into iam.permissions / iam.role_permissions,
 * enforced by the API, and rendered into docs/PERMISSIONS.md.
 * Sensitive permissions require a reason code and are always audited.
 */
export interface PermissionDef { code: string; module: string; description: string; sensitive?: boolean }

const P = (module: string, entries: [string, string, boolean?][]): PermissionDef[] =>
  entries.map(([code, description, sensitive]) => ({ code: `${module}.${code}`, module, description, sensitive: !!sensitive }));

export const PERMISSIONS: PermissionDef[] = [
  ...P('platform', [['company.create', 'Create tenant companies (platform only)', true]]),
  ...P('org', [
    ['company.view', 'View company profile'], ['company.manage', 'Edit company profile and settings', true],
    ['branch.view', 'View branches'], ['branch.manage', 'Create and edit branches', true],
  ]),
  ...P('iam', [
    ['user.view', 'View users'], ['user.manage', 'Create, edit, deactivate users', true],
    ['user.assign_roles', 'Grant and revoke user roles', true],
    ['role.view', 'View roles and permissions'], ['role.manage', 'Create roles and edit role permissions', true],
  ]),
  ...P('audit', [['log.view', 'View audit logs']]),
  ...P('sync', [
    ['status.view', 'View synchronization status'], ['device.register', 'Register terminals and screens'],
    ['device.approve', 'Approve or block devices', true], ['conflict.resolve', 'Resolve synchronization conflicts', true],
  ]),
  ...P('menu', [
    ['view', 'View menu'], ['manage', 'Manage categories, dishes, modifiers, combos'],
    ['price.manage', 'Propose price changes', true], ['price.approve', 'Approve price changes', true],
    ['availability.manage', 'Mark dishes available/unavailable at a branch'],
  ]),
  ...P('recipe', [
    ['view', 'View recipes'], ['manage', 'Create and edit recipes'], ['approve', 'Approve/activate recipe versions', true],
    ['cost.view', 'View recipe and food costs'],
  ]),
  ...P('crm', [['customer.view', 'View customers'], ['customer.manage', 'Create and edit customers'], ['customer.export', 'Export customer data', true]]),
  ...P('pos', [
    ['order.create', 'Create and edit orders'], ['order.view', 'View orders'],
    ['order.discount', 'Apply discounts', true], ['order.item_void', 'Void items after sending to kitchen', true],
    ['order.void', 'Void/cancel whole orders', true], ['order.price_change', 'Override item prices', true],
    ['order.complimentary', 'Mark items complimentary', true], ['order.refund', 'Refund orders', true],
    ['order.reopen', 'Reopen closed bills', true], ['order.reprint', 'Reprint bills and tickets', true],
    ['order.transfer_table', 'Transfer orders between tables'], ['order.merge_split', 'Merge tables and split bills'],
    ['table.manage', 'Manage floor plan and tables'],
    ['shift.open', 'Open cashier shift'], ['shift.close', 'Close cashier shift'],
    ['shift.variance_approve', 'Approve cash variances', true], ['cash.payout', 'Cash payouts and deposits', true],
  ]),
  ...P('pay', [['payment.take', 'Take payments'], ['payment.refund', 'Refund payments', true], ['method.manage', 'Manage payment methods']]),
  ...P('kds', [['view', 'View kitchen display'], ['update_status', 'Update kitchen ticket status'], ['reprint', 'Reprint kitchen tickets'], ['station.manage', 'Manage kitchen stations']]),
  ...P('inv', [
    ['item.view', 'View inventory items'], ['item.manage', 'Manage inventory items, UoM, warehouses'],
    ['stock.view', 'View stock balances'], ['document.create', 'Create inventory documents'],
    ['document.approve', 'Approve and post inventory documents', true], ['stock_count', 'Perform stock counts'],
    ['adjustment.approve', 'Approve stock adjustments', true], ['wastage.record', 'Record wastage'],
    ['transfer.create', 'Create stock transfers'], ['transfer.receive', 'Receive stock transfers'],
    ['valuation.view', 'View inventory valuation'],
  ]),
  ...P('supl', [
    ['supplier.view', 'View suppliers'], ['supplier.manage', 'Manage suppliers'],
    ['bank.view', 'View supplier bank details', true], ['bank.manage', 'Edit supplier bank details', true],
  ]),
  ...P('proc', [
    ['requisition.create', 'Create purchase requisitions'], ['requisition.approve', 'Approve purchase requisitions', true],
    ['po.create', 'Create purchase orders'], ['po.approve', 'Approve purchase orders', true],
    ['grn.create', 'Receive goods (GRN)'], ['invoice.create', 'Enter purchase invoices'],
    ['invoice.post', 'Post purchase invoices', true], ['payment.create', 'Create supplier payments', true],
  ]),
  ...P('dlv', [
    ['delivery.view', 'View deliveries'], ['delivery.dispatch', 'Assign riders and dispatch'],
    ['delivery.update', 'Update own delivery status'], ['cash.handover', 'Rider cash handover'],
    ['rider.manage', 'Manage riders'], ['zone.manage', 'Manage delivery zones and fees'],
  ]),
  ...P('agg', [['view', 'View aggregator orders'], ['manage', 'Manage aggregator setup and mappings'], ['order.import', 'Import/accept aggregator orders'], ['settlement.reconcile', 'Reconcile aggregator settlements', true]]),
  ...P('loy', [['view', 'View loyalty'], ['manage', 'Manage loyalty programs'], ['adjust', 'Manual points adjustments', true]]),
  ...P('mkt', [['campaign.view', 'View campaigns'], ['campaign.manage', 'Create campaigns and templates'], ['campaign.approve', 'Approve/send campaigns', true], ['consent.manage', 'Manage customer opt-in/opt-out']]),
  ...P('exp', [['expense.create', 'Record expenses'], ['expense.approve', 'Approve expenses', true], ['category.manage', 'Manage expense categories']]),
  ...P('acct', [
    ['view', 'View ledgers'], ['journal.create', 'Create manual journals'], ['journal.post', 'Post journals', true],
    ['period.close', 'Close fiscal periods', true], ['tax.manage', 'Manage tax configuration', true], ['coa.manage', 'Manage chart of accounts'],
  ]),
  ...P('report', [['sales.view', 'Sales reports'], ['cost.view', 'Cost and inventory reports'], ['financial.view', 'Financial reports (P&L, VAT)'], ['export', 'Export reports to Excel/PDF']]),
];

export const ALL = PERMISSIONS.map((p) => p.code);
const byPrefix = (...prefixes: string[]) => ALL.filter((c) => prefixes.some((p) => c === p || c.startsWith(p.endsWith('.') ? p : p + '.')));
const without = (list: string[], ...excluded: string[]) => list.filter((c) => !excluded.includes(c));

export interface RoleDef { code: string; name: string; scope: 'platform' | 'company' | 'branch'; description: string; permissions: string[] }

export const ROLES: RoleDef[] = [
  { code: 'SUPER_ADMIN', name: 'Super Admin', scope: 'platform', description: 'Platform operator; manages tenants', permissions: ALL },
  { code: 'OWNER', name: 'Owner', scope: 'company', description: 'Business owner; full company access', permissions: without(ALL, 'platform.company.create') },
  { code: 'GENERAL_MANAGER', name: 'General Manager', scope: 'company', description: 'All branches, operations and approvals',
    permissions: without(ALL, 'platform.company.create', 'org.company.manage', 'acct.period.close', 'supl.bank.manage', 'iam.role.manage') },
  { code: 'BRANCH_MANAGER', name: 'Branch Manager', scope: 'branch', description: 'Runs one or more branches',
    permissions: [
      'org.company.view', 'org.branch.view', 'iam.user.view', 'iam.user.manage', 'iam.user.assign_roles', 'iam.role.view', 'audit.log.view', 'sync.status.view', 'sync.device.register', 'sync.device.approve',
      'menu.view', 'menu.availability.manage', 'recipe.view', 'recipe.cost.view', 'crm.customer.view', 'crm.customer.manage',
      ...byPrefix('pos'), 'pay.payment.take', 'pay.payment.refund', ...byPrefix('kds'),
      ...without(byPrefix('inv'), 'inv.item.manage'), 'supl.supplier.view',
      'proc.requisition.create', 'proc.requisition.approve', 'proc.po.create', 'proc.grn.create',
      ...without(byPrefix('dlv'), 'dlv.zone.manage'), 'agg.view', 'agg.order.import', 'loy.view', 'loy.adjust',
      'exp.expense.create', 'exp.expense.approve', 'report.sales.view', 'report.cost.view', 'report.export',
    ] },
  { code: 'CASHIER', name: 'Cashier', scope: 'branch', description: 'Billing and payments',
    permissions: ['menu.view', 'crm.customer.view', 'crm.customer.manage', 'pos.order.create', 'pos.order.view', 'pos.order.transfer_table',
      'pos.order.merge_split', 'pos.shift.open', 'pos.shift.close', 'pay.payment.take', 'kds.view', 'dlv.delivery.view', 'dlv.delivery.dispatch',
      'agg.view', 'agg.order.import', 'loy.view', 'exp.expense.create'] },
  { code: 'WAITER', name: 'Waiter', scope: 'branch', description: 'Takes dine-in orders',
    permissions: ['menu.view', 'crm.customer.view', 'pos.order.create', 'pos.order.view', 'pos.order.transfer_table', 'pos.order.merge_split', 'kds.view'] },
  { code: 'CHEF', name: 'Chef', scope: 'branch', description: 'Kitchen display and production',
    permissions: ['menu.view', 'recipe.view', 'kds.view', 'kds.update_status', 'kds.reprint', 'inv.item.view', 'inv.stock.view', 'inv.wastage.record', 'proc.requisition.create'] },
  { code: 'INVENTORY_CONTROLLER', name: 'Inventory Controller', scope: 'company', description: 'Stock, counts, transfers, costing',
    permissions: [...byPrefix('inv'), 'menu.view', 'recipe.view', 'recipe.manage', 'recipe.cost.view', 'supl.supplier.view',
      'proc.requisition.create', 'proc.grn.create', 'report.cost.view', 'report.export'] },
  { code: 'PROCUREMENT_OFFICER', name: 'Procurement Officer', scope: 'company', description: 'Suppliers and purchasing',
    permissions: ['supl.supplier.view', 'supl.supplier.manage', 'supl.bank.view', 'proc.requisition.create', 'proc.requisition.approve',
      'proc.po.create', 'proc.grn.create', 'proc.invoice.create', 'inv.item.view', 'inv.stock.view', 'inv.valuation.view', 'report.cost.view'] },
  { code: 'ACCOUNTANT', name: 'Accountant', scope: 'company', description: 'Ledgers, VAT, payables, reconciliation',
    permissions: [...byPrefix('acct'), ...byPrefix('exp'), 'report.sales.view', 'report.cost.view', 'report.financial.view', 'report.export',
      'proc.invoice.create', 'proc.invoice.post', 'proc.payment.create', 'supl.supplier.view', 'supl.bank.view', 'supl.bank.manage',
      'agg.view', 'agg.settlement.reconcile', 'inv.valuation.view', 'audit.log.view', 'pos.order.view', 'pos.shift.variance_approve', 'org.branch.view'] },
  { code: 'MARKETING_MANAGER', name: 'Marketing Manager', scope: 'company', description: 'CRM, loyalty and campaigns',
    permissions: [...byPrefix('crm'), ...byPrefix('mkt'), 'loy.view', 'loy.manage', 'report.sales.view', 'menu.view'] },
  { code: 'RIDER', name: 'Rider', scope: 'branch', description: 'Delivers orders',
    permissions: ['dlv.delivery.view', 'dlv.delivery.update', 'dlv.cash.handover'] },
];

const known = new Set(ALL);
for (const r of ROLES) for (const p of r.permissions) if (!known.has(p)) throw new Error(`role ${r.code} references unknown permission ${p}`);
