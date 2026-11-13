/**
 * Application navigation. Each entry is shown only if the user holds at least one
 * of its permissions. `phase` marks when the screen is delivered.
 */
export interface NavItem { key: string; label: string; path?: string; anyOf?: string[]; phase: number; children?: NavItem[] }

export const NAVIGATION: NavItem[] = [
  { key: 'dashboard', label: 'Dashboard', path: '/', phase: 8, anyOf: ['report.sales.view', 'report.financial.view'] },
  { key: 'pos', label: 'POS', phase: 2, children: [
    { key: 'pos.terminal', label: 'Order entry', path: '/pos', anyOf: ['pos.order.create'], phase: 2 },
    { key: 'pos.tables', label: 'Table plan', path: '/pos/tables', anyOf: ['pos.order.create', 'pos.table.manage'], phase: 2 },
    { key: 'pos.orders', label: 'Orders', path: '/pos/orders', anyOf: ['pos.order.view'], phase: 2 },
    { key: 'pos.shifts', label: 'Cashier shifts', path: '/pos/shifts', anyOf: ['pos.shift.open', 'pos.shift.variance_approve'], phase: 2 },
  ] },
  { key: 'kds', label: 'Kitchen display', path: '/kds', anyOf: ['kds.view'], phase: 3 },
  { key: 'delivery', label: 'Delivery', phase: 7, children: [
    { key: 'dlv.board', label: 'Dispatch board', path: '/delivery', anyOf: ['dlv.delivery.dispatch', 'dlv.delivery.view'], phase: 7 },
    { key: 'dlv.my', label: 'My deliveries', path: '/delivery/mine', anyOf: ['dlv.delivery.update'], phase: 7 },
    { key: 'dlv.riders', label: 'Riders', path: '/delivery/riders', anyOf: ['dlv.rider.manage'], phase: 7 },
    { key: 'dlv.zones', label: 'Zones & fees', path: '/delivery/zones', anyOf: ['dlv.zone.manage'], phase: 7 },
    { key: 'agg.orders', label: 'Aggregator orders', path: '/aggregators/orders', anyOf: ['agg.view'], phase: 7 },
  ] },
  { key: 'menu', label: 'Menu', phase: 1, children: [
    { key: 'menu.items', label: 'Dishes & categories', path: '/menu', anyOf: ['menu.view'], phase: 1 },
    { key: 'menu.modifiers', label: 'Modifiers & combos', path: '/menu/modifiers', anyOf: ['menu.manage'], phase: 1 },
    { key: 'menu.pricing', label: 'Pricing', path: '/menu/pricing', anyOf: ['menu.price.manage', 'menu.price.approve'], phase: 1 },
    { key: 'recipe', label: 'Recipes & costing', path: '/recipes', anyOf: ['recipe.view'], phase: 4 },
  ] },
  { key: 'inventory', label: 'Inventory', phase: 4, children: [
    { key: 'inv.items', label: 'Items & units', path: '/inventory/items', anyOf: ['inv.item.view'], phase: 1 },
    { key: 'inv.stock', label: 'Stock on hand', path: '/inventory/stock', anyOf: ['inv.stock.view'], phase: 4 },
    { key: 'inv.documents', label: 'Transfers, adjustments, wastage', path: '/inventory/documents', anyOf: ['inv.document.create', 'inv.wastage.record'], phase: 4 },
    { key: 'inv.counts', label: 'Stock counts', path: '/inventory/counts', anyOf: ['inv.stock_count'], phase: 4 },
  ] },
  { key: 'purchasing', label: 'Purchasing', phase: 5, children: [
    { key: 'supl', label: 'Suppliers', path: '/suppliers', anyOf: ['supl.supplier.view'], phase: 1 },
    { key: 'proc.req', label: 'Requisitions', path: '/purchasing/requisitions', anyOf: ['proc.requisition.create'], phase: 5 },
    { key: 'proc.po', label: 'Purchase orders', path: '/purchasing/orders', anyOf: ['proc.po.create', 'proc.po.approve'], phase: 5 },
    { key: 'proc.grn', label: 'Goods receipts', path: '/purchasing/grn', anyOf: ['proc.grn.create'], phase: 5 },
    { key: 'proc.inv', label: 'Supplier invoices', path: '/purchasing/invoices', anyOf: ['proc.invoice.create'], phase: 5 },
  ] },
  { key: 'customers', label: 'Customers & marketing', phase: 6, children: [
    { key: 'crm', label: 'Customers', path: '/customers', anyOf: ['crm.customer.view'], phase: 6 },
    { key: 'loy', label: 'Loyalty', path: '/loyalty', anyOf: ['loy.view'], phase: 6 },
    { key: 'mkt', label: 'Campaigns', path: '/campaigns', anyOf: ['mkt.campaign.view'], phase: 6 },
  ] },
  { key: 'finance', label: 'Finance', phase: 8, children: [
    { key: 'exp', label: 'Expenses', path: '/expenses', anyOf: ['exp.expense.create', 'exp.expense.approve'], phase: 8 },
    { key: 'acct', label: 'Ledger & journals', path: '/accounting', anyOf: ['acct.view'], phase: 8 },
    { key: 'reports', label: 'Reports', path: '/reports', anyOf: ['report.sales.view', 'report.cost.view', 'report.financial.view'], phase: 8 },
  ] },
  { key: 'admin', label: 'Administration', phase: 0, children: [
    { key: 'org.company', label: 'Company', path: '/admin/company', anyOf: ['org.company.view'], phase: 0 },
    { key: 'org.branches', label: 'Branches', path: '/admin/branches', anyOf: ['org.branch.view'], phase: 0 },
    { key: 'iam.users', label: 'Users', path: '/admin/users', anyOf: ['iam.user.view'], phase: 0 },
    { key: 'iam.roles', label: 'Roles & permissions', path: '/admin/roles', anyOf: ['iam.role.view'], phase: 0 },
    { key: 'sync.devices', label: 'Devices & sync', path: '/admin/devices', anyOf: ['sync.status.view'], phase: 0 },
    { key: 'audit', label: 'Audit log', path: '/admin/audit', anyOf: ['audit.log.view'], phase: 0 },
  ] },
];

export function filterNavigation(items: NavItem[], has: (p: string) => boolean): NavItem[] {
  const out: NavItem[] = [];
  for (const item of items) {
    if (item.children) {
      const children = filterNavigation(item.children, has);
      if (children.length) out.push({ ...item, children });
    } else if (!item.anyOf || item.anyOf.some(has)) {
      out.push(item);
    }
  }
  return out;
}
