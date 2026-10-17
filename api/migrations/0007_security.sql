-- 0007 security: row level security on every tenant table, and least privilege grants

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables tb
        ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
     WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND tb.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END $$;

-- The tenant table has no tenant_id. A session sees only its own tenant row.
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant
  USING (id = current_tenant_id()) WITH CHECK (id = current_tenant_id());

-- ---------------------------------------------------------------- grants

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO crm_app, crm_readonly;

-- App role. No DELETE on business records: they are soft deleted. Hard deletion runs
-- through the privacy workflow under a separate, audited role.
GRANT SELECT, INSERT, UPDATE ON
  app_user, role, pipeline_stage, queue, sla_policy, account, contact, opportunity,
  support_case, case_comment, activity, custom_field_def, match_candidate
TO crm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON external_id, field_permission TO crm_app;
GRANT SELECT, INSERT, DELETE ON user_role, role_permission TO crm_app;

-- Evidence tables: insert and read, never change.
GRANT SELECT, INSERT ON audit_log, ai_query_log, redaction_event, health_snapshot TO crm_app;

-- A tenant admin can change these settings, nothing else on the tenant row.
GRANT SELECT ON tenant TO crm_app;
GRANT UPDATE (name, default_currency, ai_enabled, settings, updated_at) ON tenant TO crm_app;

-- Read replica role for reports and AI queries. Row level security still applies.
GRANT SELECT ON
  tenant, app_user, role, user_role, role_permission, field_permission, pipeline_stage, queue,
  sla_policy, account, contact, opportunity, support_case, case_comment, activity,
  custom_field_def, external_id, match_candidate, health_snapshot, redaction_event
TO crm_readonly;
