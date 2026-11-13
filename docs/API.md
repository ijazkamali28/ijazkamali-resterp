# API architecture

* Base path `/api/v1`, JSON over HTTPS. Versioned by path; breaking changes go to `/api/v2`.
* **Auth:** `Authorization: Bearer <token>` from `POST /auth/login`. All routes require it unless marked public.
* **Tenant selection:** the user's company is implicit. The platform Super Admin selects a tenant with `X-Company-Id: <uuid>`.
* **Branch scope:** list endpoints accept `?branchId=`; the server checks the permission *for that branch*.
* **Validation:** request bodies are strict (unknown fields → 400). Clients never send `company_id`, totals, costs or balances; the server derives them.
* **Concurrency:** `PATCH` bodies must include the record's current `rowVersion`; a stale version returns 409.
* **Deletion:** master data is deactivated (`POST …/:id/deactivate`), never deleted. Financial records are reversed, never deleted.
* **Idempotency:** posting endpoints (payments, stock, journals; Phase 2+) take a client-generated `idempotencyKey`; a retry returns the original result instead of duplicating it.
* **Pagination:** `limit` (≤200, default 50) and `offset`; responses include `total`.

## Error format

```json
{ "error": "validation_failed", "message": "request validation failed", "details": [{ "path": "code", "message": "letters, digits, - and _ only" }] }
```

| HTTP | `error` | Meaning |
|---|---|---|
| 400 | `validation_failed`, `bad_request`, `invalid_format` | Input rejected |
| 401 | `unauthorized` | Missing/invalid/expired/revoked session |
| 403 | `forbidden`, `password_change_required`, `device_not_authorized` | Authenticated but not allowed |
| 404 | `not_found` | Missing **or not visible to you** (other tenant/branch — existence is not disclosed) |
| 409 | `conflict`, `duplicate`, `business_rule`, `insufficient_stock` | State conflict / unique code / rule violated |
| 422 | `invalid_reference`, `constraint_violation`, `unbalanced_journal` | Referential or business constraint |
| 423 | `account_locked` | Too many failed logins |
| 429 | — | Rate limited |

## Module layout

```
src/
  app.ts                 Fastify instance: security plugins, error mapping, module registration
  config.ts              validated environment
  db/pool.ts             pool + withTx(ctx) (SET LOCAL tenant context per transaction)
  db/migrate.ts          migration runner
  auth/permissions.ts    permission catalogue + role matrix (single source of truth)
  auth/context.ts        AuthContext: grants, can(), require(), db context
  auth/service.ts        login, authenticate, logout, change password
  plugins/auth.ts        authenticates every non-public route
  lib/crud.ts            reusable master-data CRUD factory (validation, permissions, RLS, versioning, activation)
  lib/audit.ts, errors.ts, password.ts, uuid.ts
  modules/<domain>/routes.ts
```

New domains add a `modules/<domain>/routes.ts`; simple masters are one `registerCrud({...})` call.

## Endpoints delivered in Phase 0

| Method & path | Permission | Notes |
|---|---|---|
| `GET /health/live`, `GET /health/ready` | public | readiness checks DB + schema version |
| `POST /auth/login` | public, rate-limited | `{email, password, deviceId?, deviceSecret?}` → `{token, expiresAt, user}` |
| `POST /auth/logout` | session | revokes the session |
| `GET /auth/me` | session | user, company, visible branches, grants, effective permissions |
| `POST /auth/change-password` | session | policy enforced; revokes other sessions |
| `GET /org/companies` | `org.company.view` (Super Admin: all) | |
| `POST /org/companies` | Super Admin only | creates tenant + roles, channels, VAT 5%/0%/exempt, CoA, UoM, payment methods, reason codes |
| `GET/PATCH /org/companies/:id` | `org.company.view` / `org.company.manage` | |
| `GET /org/branches`, `GET /org/branches/:id` | `org.branch.view` (per branch) | |
| `POST /org/branches` | `org.branch.manage`, company-wide | creates warehouses, tax setting, payment-method enablement |
| `PATCH /org/branches/:id`, `POST …/:id/activate|deactivate` | `org.branch.manage` (per branch) | |
| `GET /iam/permissions` | `iam.role.view` | catalogue |
| `GET /iam/roles`, `POST /iam/roles` | `iam.role.view` / `iam.role.manage` | cannot include permissions you lack |
| `PUT /iam/roles/:id/permissions` | `iam.role.manage` | requires `reason`; audited; not for a role you hold |
| `GET /iam/users` | `iam.user.view` | branch admins see only their branches' users |
| `POST /iam/users` | `iam.user.manage` + grant rules | temporary password → forced change |
| `PATCH /iam/users/:id` | `iam.user.manage` | deactivation revokes sessions |
| `POST /iam/users/:id/reset-password` | `iam.user.manage` | |
| `POST /iam/users/:id/roles`, `DELETE /iam/users/:id/roles/:grantId` | `iam.user.assign_roles` + escalation guard | revocation end-dates the grant (history kept) |
| `GET /audit/logs` | `audit.log.view` | filters: from, to, action, userId, branchId, entityTable, entityId |
| `GET /audit/trace/:docType/:docId` | `audit.log.view` | all postings produced by a source document |
| `POST /sync/devices` | `sync.device.register` (branch) | returns one-time `deviceSecret` |
| `GET /sync/devices` | `sync.status.view` | |
| `POST /sync/devices/:id/approve|block|retire` | `sync.device.approve` (branch) | block/retire revokes device sessions |
| `GET /sync/status` | `sync.status.view` | data for offline/sync indicators |
| `GET /meta/navigation` | session | navigation filtered by permissions |
| `GET /meta/permission-matrix` | `iam.role.view` | |
