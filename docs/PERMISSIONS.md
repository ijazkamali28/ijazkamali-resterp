# Permission matrix

_Generated from `src/auth/permissions.ts` (single source of truth for seeding, enforcement and this document)._

## Roles

| Code | Name | Scope | Description |
|---|---|---|---|
| SUPER_ADMIN | Super Admin | platform | Platform operator; manages tenants |
| OWNER | Owner | company | Business owner; full company access |
| GENERAL_MANAGER | General Manager | company | All branches, operations and approvals |
| BRANCH_MANAGER | Branch Manager | branch | Runs one or more branches |
| CASHIER | Cashier | branch | Billing and payments |
| WAITER | Waiter | branch | Takes dine-in orders |
| CHEF | Chef | branch | Kitchen display and production |
| INVENTORY_CONTROLLER | Inventory Controller | company | Stock, counts, transfers, costing |
| PROCUREMENT_OFFICER | Procurement Officer | company | Suppliers and purchasing |
| ACCOUNTANT | Accountant | company | Ledgers, VAT, payables, reconciliation |
| MARKETING_MANAGER | Marketing Manager | company | CRM, loyalty and campaigns |
| RIDER | Rider | branch | Delivers orders |

Scope: **platform** = all tenants; **company** = normally granted for all branches (`branch_id` null); **branch** = granted per branch.
A user may hold several roles in different branches; a permission is effective for a branch only if a grant for that branch (or a company-wide grant) includes it.

Rules enforced server-side: no self-role changes; a grantor must hold every permission of the role they grant, for the same branch; company-wide grants only by company-wide admins; sensitive (⚠) actions need a reason code and are audited.

## Matrix

| Permission | ⚠ | SUPER ADMIN | OWNER | GENERAL MANAGER | BRANCH MANAGER | CASHIER | WAITER | CHEF | INVENTORY CONTROLLER | PROCUREMENT OFFICER | ACCOUNTANT | MARKETING MANAGER | RIDER |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `platform.company.create` — Create tenant companies (platform only) | ⚠ | ✔ |  |  |  |  |  |  |  |  |  |  |  |
| `org.company.view` — View company profile |  | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |
| `org.company.manage` — Edit company profile and settings | ⚠ | ✔ | ✔ |  |  |  |  |  |  |  |  |  |  |
| `org.branch.view` — View branches |  | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  | ✔ |  |  |
| `org.branch.manage` — Create and edit branches | ⚠ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |  |
| `iam.user.view` — View users |  | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |
| `iam.user.manage` — Create, edit, deactivate users | ⚠ | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |
| `iam.user.assign_roles` — Grant and revoke user roles | ⚠ | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |
| `iam.role.view` — View roles and permissions |  | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |
| `iam.role.manage` — Create roles and edit role permissions | ⚠ | ✔ | ✔ |  |  |  |  |  |  |  |  |  |  |
| `audit.log.view` — View audit logs |  | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  | ✔ |  |  |
| `sync.status.view` — View synchronization status |  | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |
| `sync.device.register` — Register terminals and screens |  | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |
| `sync.device.approve` — Approve or block devices | ⚠ | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |
| `sync.conflict.resolve` — Resolve synchronization conflicts | ⚠ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |  |
| `menu.view` — View menu |  | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |  |  | ✔ |  |
| `menu.manage` — Manage categories, dishes, modifiers, combos |  | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |  |
| `menu.price.manage` — Propose price changes | ⚠ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |  |
| `menu.price.approve` — Approve price changes | ⚠ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |  |
| `menu.availability.manage` — Mark dishes available/unavailable at a branch |  | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |
| `recipe.view` — View recipes |  | ✔ | ✔ | ✔ | ✔ |  |  | ✔ | ✔ |  |  |  |  |
| `recipe.manage` — Create and edit recipes |  | ✔ | ✔ | ✔ |  |  |  |  | ✔ |  |  |  |  |
| `recipe.approve` — Approve/activate recipe versions | ⚠ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |  |
| `recipe.cost.view` — View recipe and food costs |  | ✔ | ✔ | ✔ | ✔ |  |  |  | ✔ |  |  |  |  |
| `crm.customer.view` — View customers |  | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |  |  |  |  | ✔ |  |
| `crm.customer.manage` — Create and edit customers |  | ✔ | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  | ✔ |  |
| `crm.customer.export` — Export customer data | ⚠ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  | ✔ |  |
| `pos.order.create` — Create and edit orders |  | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |
| `pos.order.view` — View orders |  | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |  |  |  | ✔ |  |  |
| `pos.order.discount` — Apply discounts | ⚠ | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |
| `pos.order.item_void` — Void items after sending to kitchen | ⚠ | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |
| `pos.order.void` — Void/cancel whole orders | ⚠ | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |
| `pos.order.price_change` — Override item prices | ⚠ | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |
| `pos.order.complimentary` — Mark items complimentary | ⚠ | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |
| `pos.order.refund` — Refund orders | ⚠ | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |
| `pos.order.reopen` — Reopen closed bills | ⚠ | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |
| `pos.order.reprint` — Reprint bills and tickets | ⚠ | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |
| `pos.order.transfer_table` — Transfer orders between tables |  | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |
| `pos.order.merge_split` — Merge tables and split bills |  | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |
| `pos.table.manage` — Manage floor plan and tables |  | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |
| `pos.shift.open` — Open cashier shift |  | ✔ | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |
| `pos.shift.close` — Close cashier shift |  | ✔ | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |
| `pos.shift.variance_approve` — Approve cash variances | ⚠ | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  | ✔ |  |  |
| `pos.cash.payout` — Cash payouts and deposits | ⚠ | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |
| `pay.payment.take` — Take payments |  | ✔ | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |
| `pay.payment.refund` — Refund payments | ⚠ | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |
| `pay.method.manage` — Manage payment methods |  | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |  |
| `kds.view` — View kitchen display |  | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |
| `kds.update_status` — Update kitchen ticket status |  | ✔ | ✔ | ✔ | ✔ |  |  | ✔ |  |  |  |  |  |
| `kds.reprint` — Reprint kitchen tickets |  | ✔ | ✔ | ✔ | ✔ |  |  | ✔ |  |  |  |  |  |
| `kds.station.manage` — Manage kitchen stations |  | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |
| `inv.item.view` — View inventory items |  | ✔ | ✔ | ✔ | ✔ |  |  | ✔ | ✔ | ✔ |  |  |  |
| `inv.item.manage` — Manage inventory items, UoM, warehouses |  | ✔ | ✔ | ✔ |  |  |  |  | ✔ |  |  |  |  |
| `inv.stock.view` — View stock balances |  | ✔ | ✔ | ✔ | ✔ |  |  | ✔ | ✔ | ✔ |  |  |  |
| `inv.document.create` — Create inventory documents |  | ✔ | ✔ | ✔ | ✔ |  |  |  | ✔ |  |  |  |  |
| `inv.document.approve` — Approve and post inventory documents | ⚠ | ✔ | ✔ | ✔ | ✔ |  |  |  | ✔ |  |  |  |  |
| `inv.stock_count` — Perform stock counts |  | ✔ | ✔ | ✔ | ✔ |  |  |  | ✔ |  |  |  |  |
| `inv.adjustment.approve` — Approve stock adjustments | ⚠ | ✔ | ✔ | ✔ | ✔ |  |  |  | ✔ |  |  |  |  |
| `inv.wastage.record` — Record wastage |  | ✔ | ✔ | ✔ | ✔ |  |  | ✔ | ✔ |  |  |  |  |
| `inv.transfer.create` — Create stock transfers |  | ✔ | ✔ | ✔ | ✔ |  |  |  | ✔ |  |  |  |  |
| `inv.transfer.receive` — Receive stock transfers |  | ✔ | ✔ | ✔ | ✔ |  |  |  | ✔ |  |  |  |  |
| `inv.valuation.view` — View inventory valuation |  | ✔ | ✔ | ✔ | ✔ |  |  |  | ✔ | ✔ | ✔ |  |  |
| `supl.supplier.view` — View suppliers |  | ✔ | ✔ | ✔ | ✔ |  |  |  | ✔ | ✔ | ✔ |  |  |
| `supl.supplier.manage` — Manage suppliers |  | ✔ | ✔ | ✔ |  |  |  |  |  | ✔ |  |  |  |
| `supl.bank.view` — View supplier bank details | ⚠ | ✔ | ✔ | ✔ |  |  |  |  |  | ✔ | ✔ |  |  |
| `supl.bank.manage` — Edit supplier bank details | ⚠ | ✔ | ✔ |  |  |  |  |  |  |  | ✔ |  |  |
| `proc.requisition.create` — Create purchase requisitions |  | ✔ | ✔ | ✔ | ✔ |  |  | ✔ | ✔ | ✔ |  |  |  |
| `proc.requisition.approve` — Approve purchase requisitions | ⚠ | ✔ | ✔ | ✔ | ✔ |  |  |  |  | ✔ |  |  |  |
| `proc.po.create` — Create purchase orders |  | ✔ | ✔ | ✔ | ✔ |  |  |  |  | ✔ |  |  |  |
| `proc.po.approve` — Approve purchase orders | ⚠ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |  |
| `proc.grn.create` — Receive goods (GRN) |  | ✔ | ✔ | ✔ | ✔ |  |  |  | ✔ | ✔ |  |  |  |
| `proc.invoice.create` — Enter purchase invoices |  | ✔ | ✔ | ✔ |  |  |  |  |  | ✔ | ✔ |  |  |
| `proc.invoice.post` — Post purchase invoices | ⚠ | ✔ | ✔ | ✔ |  |  |  |  |  |  | ✔ |  |  |
| `proc.payment.create` — Create supplier payments | ⚠ | ✔ | ✔ | ✔ |  |  |  |  |  |  | ✔ |  |  |
| `dlv.delivery.view` — View deliveries |  | ✔ | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  | ✔ |
| `dlv.delivery.dispatch` — Assign riders and dispatch |  | ✔ | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |
| `dlv.delivery.update` — Update own delivery status |  | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  | ✔ |
| `dlv.cash.handover` — Rider cash handover |  | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  | ✔ |
| `dlv.rider.manage` — Manage riders |  | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |
| `dlv.zone.manage` — Manage delivery zones and fees |  | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |  |
| `agg.view` — View aggregator orders |  | ✔ | ✔ | ✔ | ✔ | ✔ |  |  |  |  | ✔ |  |  |
| `agg.manage` — Manage aggregator setup and mappings |  | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |  |
| `agg.order.import` — Import/accept aggregator orders |  | ✔ | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |
| `agg.settlement.reconcile` — Reconcile aggregator settlements | ⚠ | ✔ | ✔ | ✔ |  |  |  |  |  |  | ✔ |  |  |
| `loy.view` — View loyalty |  | ✔ | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  | ✔ |  |
| `loy.manage` — Manage loyalty programs |  | ✔ | ✔ | ✔ |  |  |  |  |  |  |  | ✔ |  |
| `loy.adjust` — Manual points adjustments | ⚠ | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  |  |
| `mkt.campaign.view` — View campaigns |  | ✔ | ✔ | ✔ |  |  |  |  |  |  |  | ✔ |  |
| `mkt.campaign.manage` — Create campaigns and templates |  | ✔ | ✔ | ✔ |  |  |  |  |  |  |  | ✔ |  |
| `mkt.campaign.approve` — Approve/send campaigns | ⚠ | ✔ | ✔ | ✔ |  |  |  |  |  |  |  | ✔ |  |
| `mkt.consent.manage` — Manage customer opt-in/opt-out |  | ✔ | ✔ | ✔ |  |  |  |  |  |  |  | ✔ |  |
| `exp.expense.create` — Record expenses |  | ✔ | ✔ | ✔ | ✔ | ✔ |  |  |  |  | ✔ |  |  |
| `exp.expense.approve` — Approve expenses | ⚠ | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  | ✔ |  |  |
| `exp.category.manage` — Manage expense categories |  | ✔ | ✔ | ✔ |  |  |  |  |  |  | ✔ |  |  |
| `acct.view` — View ledgers |  | ✔ | ✔ | ✔ |  |  |  |  |  |  | ✔ |  |  |
| `acct.journal.create` — Create manual journals |  | ✔ | ✔ | ✔ |  |  |  |  |  |  | ✔ |  |  |
| `acct.journal.post` — Post journals | ⚠ | ✔ | ✔ | ✔ |  |  |  |  |  |  | ✔ |  |  |
| `acct.period.close` — Close fiscal periods | ⚠ | ✔ | ✔ |  |  |  |  |  |  |  | ✔ |  |  |
| `acct.tax.manage` — Manage tax configuration | ⚠ | ✔ | ✔ | ✔ |  |  |  |  |  |  | ✔ |  |  |
| `acct.coa.manage` — Manage chart of accounts |  | ✔ | ✔ | ✔ |  |  |  |  |  |  | ✔ |  |  |
| `report.sales.view` — Sales reports |  | ✔ | ✔ | ✔ | ✔ |  |  |  |  |  | ✔ | ✔ |  |
| `report.cost.view` — Cost and inventory reports |  | ✔ | ✔ | ✔ | ✔ |  |  |  | ✔ | ✔ | ✔ |  |  |
| `report.financial.view` — Financial reports (P&L, VAT) |  | ✔ | ✔ | ✔ |  |  |  |  |  |  | ✔ |  |  |
| `report.export` — Export reports to Excel/PDF |  | ✔ | ✔ | ✔ | ✔ |  |  |  | ✔ |  | ✔ |  |  |
