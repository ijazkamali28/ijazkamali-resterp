# Operations: installation, migrations, backup & disaster recovery

## 1. Database roles (one-time, as a PostgreSQL superuser)

```sql
-- schema owner: runs migrations, seed, backups, restores. Never used by the API.
create role pos_owner login password '<strong secret>' nosuperuser createdb bypassrls;
-- runtime role used by the API: subject to row-level security, no ledger updates/deletes
create role pos_app   login password '<strong secret>' nosuperuser nobypassrls;
create database restaurant_pos owner pos_owner;
```

`bypassrls` on the owner is required by `pg_dump`/`pg_restore` (tables use *forced* RLS). It adds no real power: the owner can already alter any table. **Never** give `pos_app` `bypassrls` or ownership.

Secrets (`DATABASE_URL`, `DATABASE_OWNER_URL`, provider credentials) come from the platform secret manager / environment, never from the repository. Integration tables store only `credentials_secret_ref`.

## 2. Install & run

```bash
npm ci
cp .env.example .env        # set DATABASE_URL (pos_app) and DATABASE_OWNER_URL (pos_owner)
npm run db:migrate
npm run db:seed             # demo data — development only, refused when NODE_ENV=production
npm run docs                # regenerate ERD / schema / permission / navigation docs
npm test                    # uses database restaurant_pos_test (created like restaurant_pos)
npm start
```

## 3. Deployment topology

| Node | Runs | Notes |
|---|---|---|
| Cloud | API (≥2 instances behind a TLS load balancer) + managed PostgreSQL 16 with PITR | `NODE_TYPE=cloud`. Receives aggregator webhooks and online orders. |
| Branch server (one per branch) | Same API + local PostgreSQL 16 on a small server/NUC with UPS | `NODE_TYPE=branch_server`, `NODE_BRANCH_CODE=<code>`. Static LAN IP; HTTPS via a local reverse proxy (Caddy/nginx) with a company internal CA whose root is installed on terminals. |
| Terminals | POS / KDS / waiter apps | Connect only to the branch server; registered and approved as devices. |

Hardening: the branch server firewall allows inbound 443 from the LAN only; outbound only to the cloud API. Disk encryption on branch servers (they hold customer data and password hashes for offline login).

## 4. Database migration procedure

1. Write a new file `db/migrations/NNNN_description.sql` (next number). **Never edit an applied migration** — the runner records SHA-256 checksums and refuses to continue if an applied file changed.
2. Migrations are forward-only and each runs in a single transaction (all-or-nothing). Prefer additive changes (new columns nullable or with defaults; backfill; then add constraints) so old and new API versions can run side by side during a rolling deploy.
3. Test: `npm test` (resets and migrates the test database from scratch).
4. Production: take a backup (§5) → `npm run db:migrate` with `DATABASE_OWNER_URL` → deploy API → check `GET /api/v1/health/ready` reports the new schema version.
5. Branch servers: upgrade during a quiet period after their outbox has drained (`/sync/status` pendingEvents = 0). Cloud is migrated first; the sync protocol tolerates a newer cloud schema.
6. Rollback = restore from the pre-migration backup (or ship a corrective forward migration). There are no down-migrations by design.

## 5. Backups

```bash
scripts/backup.sh [output_dir]          # pg_dump custom format + .sha256, atomic write, archive self-check
```

| Node | Frequency | Retention | Off-site |
|---|---|---|---|
| Cloud DB | Continuous WAL archiving (PITR) + nightly `backup.sh` | 35 days PITR, 12 monthly | Different region / account, encrypted |
| Branch server | Hourly `backup.sh` (cron), plus the cloud copy of all synced data | 14 days local (`BACKUP_RETENTION_DAYS`) | Copy to cloud object storage |

Example cron on a branch server: `0 * * * * cd /opt/restaurant-erp && scripts/backup.sh /var/backups/restaurant-erp >> /var/log/restaurant-erp-backup.log 2>&1`

## 6. Restore & disaster recovery

```bash
scripts/restore.sh <file.dump> <new_database_name>
```

Restores into a **new** database (never over the live one), verifies the checksum, re-applies runtime grants (`scripts/sql/post-restore.sql`) and runs integrity checks (`scripts/sql/verify.sql`): stock balances = ledger, posted journals balanced, RLS present on every tenant table. Switch `DATABASE_URL` only after reviewing the output.

**Branch server lost:** install a new server, restore the latest local backup if available, otherwise migrate an empty database and re-sync from the cloud (master data down; the branch's operational history is already in the cloud up to the last successful push). Events created after the last push on a destroyed server are lost unless a local backup exists — hence hourly backups and continuous sync.

**Cloud lost:** point-in-time restore of the managed database; branch servers keep trading offline and push their outboxes when the cloud returns (idempotent inbox prevents duplicates).

Run a restore drill at least quarterly and record the result.

## 7. Monitoring

* `GET /api/v1/health/ready` (DB + schema version) for load balancers.
* `GET /api/v1/sync/status` — alert when `pendingEvents` grows or `lastSuccessfulSync` is older than 15 minutes.
* Structured JSON logs (pino) with request ids; credentials and passwords are redacted.
* `scripts/sql/verify.sql` nightly; alert on any line that is not `ok`.
