-- Test setup, run as a superuser: login roles, two tenants, and a table of ids for the other files.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_test_app')  THEN CREATE ROLE crm_test_app  LOGIN IN ROLE crm_app; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_test_ro')   THEN CREATE ROLE crm_test_ro   LOGIN IN ROLE crm_readonly; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_test_prov') THEN CREATE ROLE crm_test_prov LOGIN IN ROLE crm_provisioner; END IF;
END $$;

CREATE TABLE test_ctx (k text PRIMARY KEY, v text NOT NULL);
GRANT SELECT ON test_ctx TO PUBLIC;

DO $$
DECLARE
  a uuid;
  b uuid;
BEGIN
  a := provision_tenant('Tenant A', 'tenant-a', 'Admin@A.test', 'A Admin');
  b := provision_tenant('Tenant B', 'tenant-b', 'admin@b.test', 'B Admin');
  INSERT INTO test_ctx VALUES ('a_tenant', a::text), ('b_tenant', b::text);

  INSERT INTO test_ctx SELECT 'a_admin', id::text FROM app_user WHERE tenant_id = a;
  INSERT INTO test_ctx SELECT 'b_admin', id::text FROM app_user WHERE tenant_id = b;
  INSERT INTO test_ctx SELECT 'a_queue', id::text FROM queue WHERE tenant_id = a;
  INSERT INTO test_ctx SELECT 'b_queue', id::text FROM queue WHERE tenant_id = b;

  INSERT INTO test_ctx SELECT 'a_stage_prospecting', id::text FROM pipeline_stage WHERE tenant_id = a AND name = 'Prospecting';
  INSERT INTO test_ctx SELECT 'a_stage_negotiation', id::text FROM pipeline_stage WHERE tenant_id = a AND name = 'Negotiation';
  INSERT INTO test_ctx SELECT 'a_stage_won',         id::text FROM pipeline_stage WHERE tenant_id = a AND name = 'Closed Won';
  INSERT INTO test_ctx SELECT 'a_stage_lost',        id::text FROM pipeline_stage WHERE tenant_id = a AND name = 'Closed Lost';
  INSERT INTO test_ctx SELECT 'b_stage_prospecting', id::text FROM pipeline_stage WHERE tenant_id = b AND name = 'Prospecting';

  INSERT INTO test_ctx SELECT 'a_role_finance', id::text FROM role WHERE tenant_id = a AND name = 'Finance Viewer';
  INSERT INTO test_ctx SELECT 'a_role_sales',   id::text FROM role WHERE tenant_id = a AND name = 'Sales';
  INSERT INTO test_ctx SELECT 'a_role_admin',   id::text FROM role WHERE tenant_id = a AND name = 'Tenant Admin';
END $$;
