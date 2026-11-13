#!/bin/sh
# Runs once, on the first start of an empty PostgreSQL volume.
# Creates the two application roles described in docs/OPERATIONS.md §1.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v owner_pw="$POS_OWNER_PASSWORD" -v app_pw="$POS_APP_PASSWORD" <<'SQL'
create role pos_owner login password :'owner_pw' nosuperuser createdb bypassrls;
create role pos_app   login password :'app_pw'   nosuperuser nobypassrls;
create database restaurant_pos owner pos_owner;
SQL
