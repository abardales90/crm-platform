# CRM API v0

A small TypeScript service (Fastify + Postgres) that sits between screens and the database.
Every request runs in one transaction with the tenant set, so the database's row level security does the isolating.

## Run the tests (34)

    export PGHOST=... PGPORT=... PGUSER=postgres      # a superuser on a scratch Postgres 16
    cd api && npm install && npm test

Tests build a throwaway database, load the migrations, make two tenants with users in different roles, and drive the real API as a non superuser login.

## Run it

    export DATABASE_URL='postgresql://<login that is a member of crm_app>@host/db'
    export JWT_SECRET='<at least 32 random characters>'   # openssl rand -hex 24
    npm start

## Sandbox login

    npm run token -- <tenant_id> <email> [hours]

Prints a bearer token for that user. Real login (Google SSO) comes later. Send it as `Authorization: Bearer <token>`.

## The screens

The API also serves the web app from `ui/` at `/`. Open the server's address in a browser, paste a token from `npm run token`, and you get Home, Accounts, Contacts, Deals (drag cards between stages), and Cases (SLA badges and a conversation thread). No build step.

## Endpoints

`GET /health`, `GET /v1/me` (who am I and what can I do), `GET /v1/users` (names in my tenant, for owner pickers)

For each of `accounts`, `contacts`, `opportunities`, `cases`, `case-comments`, `activities`:
`GET /v1/<name>` (filters by any column, `limit`, `after` for paging, `include_deleted=true`),
`GET /v1/<name>/:id`, `POST /v1/<name>`, `PATCH /v1/<name>/:id` (must send `version`), `DELETE /v1/<name>/:id` (soft delete).
Read only: `pipeline-stages`, `queues`.

## Rules the API enforces

- Object permissions come from `can_do`, field permissions from `field_access`. Hidden fields are removed from reads and refused on edits and filters.
- Edits need the `version` you last read. A stale version returns 409, so two people never overwrite each other.
- System fields (ids, timestamps, case numbers, SLA dates, won/closed flags) cannot be set by callers.
- Database rule failures come back as clear 4xx errors, never raw SQL.
