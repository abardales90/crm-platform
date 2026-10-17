-- 30s: run as crm_test_ro (read replica / AI role)
\echo == readonly role
SET ROLE crm_test_ro;
SELECT set_config('app.tenant_id', (SELECT v FROM test_ctx WHERE k='a_tenant'), false);
DO $t$ BEGIN
  IF (SELECT count(*) FROM account) >= 1 AND NOT EXISTS (SELECT 1 FROM account WHERE name='Acme B') THEN
    RAISE NOTICE 'PASS: 30a readonly role reads only its tenant';
  ELSE RAISE EXCEPTION 'FAIL: 30a readonly isolation'; END IF;
  BEGIN
    INSERT INTO account (tenant_id, name) VALUES ((SELECT v::uuid FROM test_ctx WHERE k='a_tenant'), 'nope');
    RAISE EXCEPTION 'FAIL: 30b readonly inserted';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: 30b readonly cannot write'; END;
  BEGIN
    PERFORM count(*) FROM audit_log;
    RAISE EXCEPTION 'FAIL: 30c readonly read audit_log';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: 30c readonly cannot read audit_log'; END;
  BEGIN
    PERFORM count(*) FROM ai_query_log;
    RAISE EXCEPTION 'FAIL: 30d readonly read ai_query_log';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: 30d readonly cannot read ai_query_log'; END;
END $t$;
RESET ROLE;

-- 40s: superuser-only checks (RLS bypassed, so these test constraints themselves)
\echo == structure
DO $t$ DECLARE n int; bad text;
BEGIN
  SELECT count(*) INTO n FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'
    AND table_name NOT IN ('schema_migrations','test_ctx');
  IF n = 23 THEN RAISE NOTICE 'PASS: 40a exactly 23 tables'; ELSE RAISE EXCEPTION 'FAIL: 40a table count %', n; END IF;

  SELECT string_agg(c.relname, ', ') INTO bad
  FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
  WHERE ns.nspname='public' AND c.relkind='r' AND c.relname NOT IN ('schema_migrations','test_ctx')
    AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id' AND NOT a.attisdropped)
    AND NOT (c.relrowsecurity AND c.relforcerowsecurity);
  IF bad IS NULL THEN RAISE NOTICE 'PASS: 40b RLS enabled and forced on every tenant table';
  ELSE RAISE EXCEPTION 'FAIL: 40b missing RLS: %', bad; END IF;

  SELECT string_agg(c.relname, ', ') INTO bad
  FROM pg_class c JOIN pg_namespace ns ON ns.oid=c.relnamespace
  WHERE ns.nspname='public' AND c.relkind='r' AND c.relname NOT IN ('schema_migrations','test_ctx')
    AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid);
  IF bad IS NULL THEN RAISE NOTICE 'PASS: 40c every table has a policy';
  ELSE RAISE EXCEPTION 'FAIL: 40c no policy: %', bad; END IF;

  SELECT string_agg(rolname, ', ') INTO bad FROM pg_roles
  WHERE rolname IN ('crm_app','crm_readonly','crm_provisioner','crm_test_app','crm_test_ro','crm_test_prov') AND (rolbypassrls OR rolsuper);
  IF bad IS NULL THEN RAISE NOTICE 'PASS: 40d no application role can bypass RLS';
  ELSE RAISE EXCEPTION 'FAIL: 40d bypass: %', bad; END IF;
END $t$;

\echo == uuid v7
DO $t$ DECLARE a uuid; b uuid;
BEGIN
  a := uuid_v7(); PERFORM pg_sleep(0.01); b := uuid_v7();
  IF substr(a::text,15,1)='7' AND a < b THEN RAISE NOTICE 'PASS: 41 uuid_v7 has version 7 and sorts by time';
  ELSE RAISE EXCEPTION 'FAIL: 41 uuid_v7 % %', a, b; END IF;
END $t$;

\echo == composite FK across tenants (superuser, RLS bypassed)
DO $t$ BEGIN
  BEGIN
    INSERT INTO contact (tenant_id, last_name, owner_user_id, account_id)
    SELECT (SELECT v::uuid FROM test_ctx WHERE k='a_tenant'), 'Cross', (SELECT v::uuid FROM test_ctx WHERE k='a_admin'), id FROM account WHERE name='Acme B';
    RAISE EXCEPTION 'FAIL: 42a cross tenant FK accepted';
  EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'PASS: 42a contact in A cannot point at account in B'; END;
  BEGIN
    UPDATE audit_log SET action='x';
    RAISE EXCEPTION 'FAIL: 42b superuser updated audit_log';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: 42b audit_log immutable even for superuser'; END;
  BEGIN
    TRUNCATE audit_log;
    RAISE EXCEPTION 'FAIL: 42c truncate audit_log';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: 42c audit_log cannot be truncated'; END;
END $t$;

\echo == provisioning
DO $t$ DECLARE a uuid := (SELECT v::uuid FROM test_ctx WHERE k='a_tenant');
BEGIN
  IF (SELECT count(*) FROM role WHERE tenant_id=a)=8 AND (SELECT count(*) FROM pipeline_stage WHERE tenant_id=a)=6
     AND (SELECT count(*) FROM queue WHERE tenant_id=a)=1 AND (SELECT count(*) FROM sla_policy WHERE tenant_id=a)=4
     AND (SELECT count(*) FROM account WHERE tenant_id=a AND name='Acme A')=1 THEN
    RAISE NOTICE 'PASS: 43a provisioning seeded 8 roles, 6 stages, 1 queue, 4 SLA policies';
  ELSE RAISE EXCEPTION 'FAIL: 43a seed counts'; END IF;
  IF (SELECT email FROM app_user WHERE tenant_id=a AND id=(SELECT v::uuid FROM test_ctx WHERE k='a_admin'))='admin@a.test'
     AND EXISTS (SELECT 1 FROM user_role ur JOIN role r ON r.id=ur.role_id AND r.tenant_id=ur.tenant_id
                 WHERE ur.tenant_id=a AND r.name='Tenant Admin') THEN
    RAISE NOTICE 'PASS: 43b admin invited with Tenant Admin role, email lowercased';
  ELSE RAISE EXCEPTION 'FAIL: 43b admin user'; END IF;
  BEGIN
    PERFORM provision_tenant('Dup','tenant-a','x@x.test','X');
    RAISE EXCEPTION 'FAIL: 43c duplicate slug';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS: 43c duplicate slug rejected'; END;
  BEGIN
    PERFORM provision_tenant('Bad','Bad Slug','x@x.test','X');
    RAISE EXCEPTION 'FAIL: 43d bad slug';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: 43d bad slug rejected'; END;
END $t$;

-- provisioner role may call it, and nothing else
SET ROLE crm_test_prov;
DO $t$ BEGIN
  PERFORM provision_tenant('Via Provisioner','via-prov','p@p.test','P');
  RAISE NOTICE 'PASS: 44a provisioner can create a tenant';
  BEGIN
    PERFORM count(*) FROM account;
    RAISE EXCEPTION 'FAIL: 44b provisioner read business data';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: 44b provisioner has no access to business tables'; END;
END $t$;
RESET ROLE;
