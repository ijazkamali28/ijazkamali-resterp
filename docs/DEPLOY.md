# Deploy a test server (Docker)

This puts the system on a server you can open from any browser or phone, so you and your team can review it.
It runs three containers: **PostgreSQL 16** (database), **the API + test console**, and **Caddy** (web server with automatic HTTPS).

> **This is a test (staging) setup, not production.** It loads demo companies and demo users whose passwords are
> published in the README, and it shows the developer test console. Do not enter real customer or financial data.

---

## Option A — Cloud server (recommended, reachable from anywhere)

### 1. Create the server

Any provider works. Choose **Ubuntu 24.04**, **2 vCPU, 4 GB RAM, 40 GB disk**.

| Provider | Where to click | UAE data centre |
|---|---|---|
| AWS EC2 | EC2 → Launch instance, region **Middle East (UAE) me-central-1** | Yes |
| Microsoft Azure | Virtual machines → Create, region **UAE North** | Yes |
| DigitalOcean / Hetzner | Create Droplet / Server | No (cheaper; fine for demo data) |

In the provider's **firewall / security group** allow inbound ports **22** (SSH), **80** and **443** only.

### 2. (Optional) Give it a web address

To get `https://pos-test.yourcompany.com` instead of `http://<ip-address>`, add a DNS **A record** for
`pos-test` pointing to the server's public IP in your domain's DNS settings. HTTPS certificates are then issued automatically.

### 3. Install Docker on the server

Connect with SSH (the provider shows the exact command, e.g. `ssh ubuntu@<server-ip>`), then:

```bash
curl -fsSL https://get.docker.com | sudo sh
```

```bash
sudo usermod -aG docker $USER && newgrp docker
```

### 4. Download the code

The repository is private, so GitHub needs a token:
GitHub → your photo → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**,
repository access **Only select repositories → ijazkamali-resterp**, permission **Contents: Read-only**. Copy the token.

```bash
git clone https://github.com/ijazkamali28/ijazkamali-resterp.git restaurant-erp
```

(Username: your GitHub username. Password: paste the token.)

```bash
cd restaurant-erp
```

### 5. Configure

```bash
cp .env.docker.example .env.docker
```

```bash
nano .env.docker
```

* Replace the three passwords with long random values — **letters and digits only**.
* Set `DOMAIN=pos-test.yourcompany.com` if you did step 2, otherwise leave `DOMAIN=:80`.
* Save with `Ctrl+O`, `Enter`, exit with `Ctrl+X`.

### 6. Start

```bash
docker compose --env-file .env.docker up -d --build
```

The first start takes 3–5 minutes (it builds the app, creates the database, applies migrations and loads demo data). Check progress:

```bash
docker compose --env-file .env.docker logs -f app
```

When you see `[entrypoint] starting`, press `Ctrl+C`. Then open:

* `https://pos-test.yourcompany.com` — or `http://<server-ip>` if you left `DOMAIN=:80`

You get the **test console**: pick a demo user, log in, click **Run** on each scenario.

---

## Option B — Your own Windows or Mac computer

1. Install **Docker Desktop** from docker.com and start it.
2. Install **Git** (git-scm.com), or on the GitHub page click **Code → Download ZIP** and unzip it.
3. Open a terminal (Windows: PowerShell) in the project folder.
4. Copy `.env.docker.example` to `.env.docker` and change the three passwords (leave `DOMAIN=:80`).
5. Run:

```bash
docker compose --env-file .env.docker up -d --build
```

6. Open **http://localhost** in your browser.

---

## Everyday commands (run inside the project folder)

| Task | Command |
|---|---|
| See status | `docker compose --env-file .env.docker ps` |
| See app logs | `docker compose --env-file .env.docker logs -f app` |
| Stop | `docker compose --env-file .env.docker stop` |
| Start again | `docker compose --env-file .env.docker start` |
| Install a new version from GitHub | `git pull` then `docker compose --env-file .env.docker up -d --build` (migrations run automatically) |
| Take a backup | `docker compose --env-file .env.docker exec app scripts/backup.sh` |
| List backups | `docker compose --env-file .env.docker exec app ls -lh backups` |
| **Wipe everything and start fresh** (deletes all data) | `docker compose --env-file .env.docker down -v` then `up -d --build` |

## Troubleshooting

| Symptom | Fix |
|---|---|
| Browser cannot connect | Check the provider firewall allows 80/443; run the *status* command — all three should be `running`/`healthy`. |
| HTTPS certificate error with a domain | The DNS A record must point to this server and port 80 must be open; check `docker compose --env-file .env.docker logs caddy`. |
| `password authentication failed` in app logs | Passwords in `.env.docker` were changed after the first start. The database keeps the original ones; either restore them or wipe and start fresh. |
| `set POSTGRES_PASSWORD in .env.docker` | You forgot `--env-file .env.docker`, or the file is missing. |

## Before real (production) use — not yet

Production needs Phases 1–10 completed and signed off, then: `APP_ENV=production` (disables the test console and demo data),
a managed PostgreSQL with point-in-time recovery, off-site backups, monitoring, and the per-branch servers described in
[OPERATIONS.md](OPERATIONS.md).
