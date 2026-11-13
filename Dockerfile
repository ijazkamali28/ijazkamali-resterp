# Restaurant POS & ERP API (also serves the test console when NODE_ENV is not "production")
FROM node:22-bookworm-slim

ENV NODE_ENV=staging \
    PORT=8080 \
    HOST=0.0.0.0
WORKDIR /app

# PostgreSQL 16 client tools (pg_dump/pg_restore for scripts/backup.sh and restore.sh).
# Debian's own package is v15, which cannot dump a v16 server, so use the PostgreSQL apt repository.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-16 \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force

COPY --chown=node:node . .
RUN chmod +x deploy/entrypoint.sh scripts/*.sh && mkdir -p /app/backups && chown node:node /app/backups

USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["deploy/entrypoint.sh"]
CMD ["npx", "tsx", "src/server.ts"]
