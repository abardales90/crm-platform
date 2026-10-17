# CRM Platform: Postgres schema v0

22 tables, 8 migrations, 80 isolation and behavior tests.

## Run it

    export PGHOST=... PGPORT=5432 PGUSER=postgres PGDATABASE=crm
    db/migrate.sh          # applies db/migrations/*.sql once each, in order
    db/tests/run.sh        # builds a throwaway database, migrates, runs all tests

Needs Postgres 16 and a superuser for migrations and tests. The tests connect as non-superuser login roles, because superusers skip row level security and would prove nothing.

## How tenant isolation works

- Every business table has `tenant_id`. Foreign keys are composite `(tenant_id, parent_id)`, so a row cannot point at another tenant's row.
- Row level security is enabled and forced on every table, with policy `tenant_id = current_tenant_id()`.
- The app sets the tenant at the start of each transaction: `SELECT set_config('app.tenant_id', '<uuid>', true)`. If it is not set, queries error rather than return rows.
- Also set `app.user_id`, `app.actor_type` (user/system/sync/ai) and `app.request_id` so the audit log knows who acted.
- Roles: `crm_app` (the API; no DELETE on business tables), `crm_readonly` (read replica and AI; cannot read audit_log or ai_query_log), `crm_provisioner` (can only call `provision_tenant`). None can bypass RLS. Create login users as members of these roles.

## Create a tenant

    SELECT provision_tenant('My Company', 'my-company', 'you@example.com', 'Your Name');

Seeds 6 pipeline stages, a General queue, 4 SLA policies (per priority), 8 starter roles with permissions, and an invited Tenant Admin. Data tables start empty.

## Deviations from the CRM Data Model v0.1 doc

- The Case table is named `support_case` (CASE is a reserved word).
- Case numbers come from a per tenant counter on `tenant.next_case_number`; the app role cannot edit it.
- Soft delete only: the app role has no DELETE on business tables. Soft deletes are audited as `delete`.
- `field_access` returns the highest access across a user's roles; a field row for a role overrides that role's object permission for that field.
- Opportunity probability is filled from the stage on insert or stage change; an explicit value is kept otherwise.
- Polymorphic references (external_id, match_candidate) are enforced by trigger, not foreign key.
- audit_log has no FK to tenant so history survives tenant removal; it is append only for every role, including superusers.
- Fixed during testing: picklist custom fields with NULL options slipped past a CHECK.

## Not yet built

Seed/demo data, API layer, connectors, read replica setup, backup policy, and migration down scripts.


## Deploying (Render + Neon)

`render.yaml` describes the web service. On Render you set only two values by hand:
`DATABASE_URL` (a Neon login that is a member of `crm_app`, not the Neon owner, so row level security applies)
and `SANDBOX_TENANT_ID` (the id printed by `provision_tenant`). Render generates `JWT_SECRET` and `SANDBOX_LOGIN_KEY` itself;
read the login key on the service's Environment tab. Sign in with your tenant admin email and that key.
