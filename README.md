# Restaurant POS & ERP (multi-company, multi-branch, offline-capable)

API-first restaurant POS/ERP on **PostgreSQL 16 + Node.js 22 (TypeScript, Fastify)**, designed for UAE operations (AED, 5% VAT, TRN) with a cloud hub and a local server per branch so terminals keep working without internet.

**Status: Phase 0 (architecture & database foundation) complete and validated.** Later phases (POS, KDS, inventory postings, procurement, CRM, delivery, finance, sync transport) have their tables in place but **no business workflows yet** — see the roadmap in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#8-phase-roadmap-and-exit-criteria). The system is not production-ready.

## Quick start

```bash
npm ci
cp .env.example .env                 # database roles: see docs/OPERATIONS.md §1
npm run db:migrate && npm run db:seed
npm start                            # http://localhost:8080/api/v1/health/ready
npm test                             # needs database restaurant_pos_test
```

Demo logins (development seed only): `owner@demo.ae`, `gm@demo.ae`, `bm.jbr@demo.ae`, `cashier.jbr@demo.ae`, `waiter.jbr@demo.ae`, `chef.jbr@demo.ae`, `inventory@demo.ae`, `procurement@demo.ae`, `accountant@demo.ae`, `marketing@demo.ae`, `rider.jbr@demo.ae` … password `Demo@Pass2026`. Platform: `superadmin@platform.local` / `Admin@Pass2026`. A second tenant (`owner@other.ae`) exists to demonstrate isolation.

```bash
TOKEN=$(curl -s localhost:8080/api/v1/auth/login -H 'content-type: application/json' \
  -d '{"email":"owner@demo.ae","password":"Demo@Pass2026"}' | jq -r .token)
curl -s localhost:8080/api/v1/auth/me -H "authorization: Bearer $TOKEN"
```

## Test server (Docker)

Step-by-step guide for a browser-accessible test server (cloud VM or your own computer): [docs/DEPLOY.md](docs/DEPLOY.md).

```bash
cp .env.docker.example .env.docker   # change the passwords
docker compose --env-file .env.docker up -d --build
```

## Phase 0 deliverables

| # | Deliverable | Where |
|---|---|---|
| 1 | Database schema (96 tables, 19 domains; PKs, FKs, unique, indexes, defaults, timestamps, statuses) | `db/migrations/*.sql`, [docs/SCHEMA.md](docs/SCHEMA.md) |
| 2 | ERD (overview + one diagram per domain, generated from the live catalog) | [docs/ERD.md](docs/ERD.md) |
| 3 | Navigation structure (served per user at `GET /meta/navigation`) | [docs/NAVIGATION.md](docs/NAVIGATION.md) |
| 4 | API architecture | [docs/API.md](docs/API.md) |
| 5 | Permission matrix (12 roles × 104 permissions) | [docs/PERMISSIONS.md](docs/PERMISSIONS.md) |
| 6 | Migration scripts + runner with checksums | `db/migrations`, `src/db/migrate.ts`, [docs/OPERATIONS.md](docs/OPERATIONS.md) |
| 7 | Initial sample data | `db/seeds/seed.ts` |
| — | Architecture, implementation plan, edge/sync design | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| — | Backup, restore, DR | `scripts/backup.sh`, `scripts/restore.sh`, [docs/OPERATIONS.md](docs/OPERATIONS.md) |

## Foundation validation (gate before Phase 1+)

`npm test` — **57 tests, all passing**, against a real PostgreSQL database:

* **Schema:** every domain present; every table has a PK and UUID ids; every tenant table has forced RLS; statuses CHECK-constrained; runtime role cannot bypass RLS or modify ledgers; migration checksums recorded.
* **Company isolation:** no context sees nothing; tenants see only their rows; cross-tenant reads by id, inserts and updates are rejected; composite FKs block cross-tenant references.
* **Branch isolation:** branch users see/write only their branch's operational data while sharing company masters.
* **Authentication:** scrypt hashes with unique salts; generic login errors; lockout after 5 failures (audited); logout, idle-timeout and password-change revocation; forced password change; device registration → approval → device-bound session → block revokes sessions.
* **Authorization:** role matrix rules; cashier/branch-manager restrictions; filtered navigation; privilege-escalation guards (no self-grant, no grant beyond own permissions/branch, no company-wide grant from branch admins); role edits audited with reasons; only Super Admin creates tenants; tenant switching via `X-Company-Id`.
* **Validation & concurrency:** strict input validation, no tenant-id smuggling, duplicate codes → 409, stale `rowVersion` → 409, row audit with before/after values.
* **Ledgers:** weighted-average costing; insufficient-stock protection; append-only stock ledger; idempotent postings; opening stock reconciles to balances and traces to its document; unbalanced journals refused; posted journals immutable; trial balance balances.
* **POS safeguards:** kitchen-sent orders undeletable; payments append-only and idempotent; refunds must reference the original; no self-approval of overrides.
* **Audit & sync:** audit log immutable; transactional outbox captures inserts/updates with versions; inbox-applied changes not re-emitted; inbox de-duplicates by event id.

Also verified manually: backup → restore into a new database → integrity checks all `ok`, with RLS still enforced on the restored copy; all generated Mermaid diagrams render.
