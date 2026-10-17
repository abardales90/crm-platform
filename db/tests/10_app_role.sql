-- Run as crm_test_app: the role the real application uses. It cannot bypass row level security.

CREATE FUNCTION pg_temp.ctx(p text) RETURNS uuid LANGUAGE sql AS $$ SELECT v::uuid FROM test_ctx WHERE k = p $$;
CREATE FUNCTION pg_temp.use_tenant(p text) RETURNS void LANGUAGE sql AS
  $$ SELECT set_config('app.tenant_id', (SELECT v FROM test_ctx WHERE k = p), false) $$;
CREATE FUNCTION pg_temp.use_user(p text) RETURNS void LANGUAGE sql AS
  $$ SELECT set_config('app.user_id', (SELECT v FROM test_ctx WHERE k = p), false) $$;

-- 1. no tenant set means the query errors, never returns rows
DO $t$ BEGIN
  BEGIN
    PERFORM count(*) FROM account;
    RAISE EXCEPTION 'FAIL: 1 query without a tenant should error';
  EXCEPTION WHEN undefined_object THEN RAISE NOTICE 'PASS: 1 query without a tenant errors';
  END;
END $t$;

-- seed data: one account per tenant, same domain on purpose
SELECT pg_temp.use_tenant('a_tenant'), pg_temp.use_user('a_admin');
INSERT INTO account (tenant_id, name, domain, owner_user_id)
VALUES (pg_temp.ctx('a_tenant'), 'Acme A', 'acme.com', pg_temp.ctx('a_admin'));
INSERT INTO contact (tenant_id, last_name, email, owner_user_id, account_id)
SELECT tenant_id, 'Smith', 'smith@acme.com', owner_user_id, id FROM account WHERE name = 'Acme A';

SELECT pg_temp.use_tenant('b_tenant'), pg_temp.use_user('b_admin');
INSERT INTO account (tenant_id, name, domain, owner_user_id)
VALUES (pg_temp.ctx('b_tenant'), 'Acme B', 'acme.com', pg_temp.ctx('b_admin'));

-- 2. each tenant sees only its own rows
SELECT pg_temp.use_tenant('a_tenant');
DO $t$ BEGIN
  IF (SELECT count(*) FROM account) = 1 AND (SELECT name FROM account) = 'Acme A'
     AND (SELECT count(*) FROM contact) = 1 AND (SELECT count(*) FROM app_user) = 1
     AND (SELECT count(*) FROM tenant) = 1 THEN
    RAISE NOTICE 'PASS: 2 tenant A sees only tenant A rows';
  ELSE RAISE EXCEPTION 'FAIL: 2 tenant A saw other tenant rows';
  END IF;
END $t$;

SELECT pg_temp.use_tenant('b_tenant');
DO $t$ BEGIN
  IF (SELECT count(*) FROM account) = 1 AND (SELECT name FROM account) = 'Acme B'
     AND (SELECT count(*) FROM contact) = 0 THEN
    RAISE NOTICE 'PASS: 2b tenant B sees only tenant B rows';
  ELSE RAISE EXCEPTION 'FAIL: 2b tenant B saw other tenant rows';
  END IF;
  IF EXISTS (SELECT 1 FROM account WHERE name = 'Acme A') THEN
    RAISE EXCEPTION 'FAIL: 2c tenant B found a tenant A account by name';
  END IF;
  RAISE NOTICE 'PASS: 2c cross tenant lookup by name returns nothing';
END $t$;

-- 3. insert with the wrong tenant_id is rejected
SELECT pg_temp.use_tenant('a_tenant');
DO $t$ BEGIN
  BEGIN
    INSERT INTO account (tenant_id, name, owner_user_id)
    VALUES (pg_temp.ctx('b_tenant'), 'Smuggled', pg_temp.ctx('b_admin'));
    RAISE EXCEPTION 'FAIL: 3 insert into another tenant succeeded';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: 3 insert with wrong tenant_id rejected';
  END;
END $t$;

-- 4. moving a row to another tenant is rejected
DO $t$ BEGIN
  BEGIN
    UPDATE account SET tenant_id = pg_temp.ctx('b_tenant') WHERE name = 'Acme A';
    RAISE EXCEPTION 'FAIL: 4 tenant_id update succeeded';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN RAISE NOTICE 'PASS: 4 tenant_id cannot be changed';
  END;
END $t$;

-- 5. a record in tenant A cannot point at a tenant B user (the app role cannot even see it)
DO $t$ BEGIN
  BEGIN
    INSERT INTO account (tenant_id, name, owner_user_id)
    VALUES (pg_temp.ctx('a_tenant'), 'Bad owner', pg_temp.ctx('b_admin'));
    RAISE EXCEPTION 'FAIL: 5 cross tenant owner accepted';
  EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'PASS: 5 cross tenant owner rejected';
  END;
END $t$;

-- 6. no hard delete for the app role
DO $t$ BEGIN
  BEGIN
    DELETE FROM account WHERE name = 'Acme A';
    RAISE EXCEPTION 'FAIL: 6 app role deleted an account';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: 6 hard delete denied';
  END;
END $t$;

-- 7. account rules: uppercase domain, duplicate domain, same domain in another tenant, soft delete frees it
SELECT pg_temp.use_user('a_admin');
DO $t$ BEGIN
  BEGIN
    INSERT INTO account (tenant_id, name, domain, owner_user_id) VALUES (pg_temp.ctx('a_tenant'), 'X', 'Upper.com', pg_temp.ctx('a_admin'));
    RAISE EXCEPTION 'FAIL: 7a uppercase domain accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: 7a uppercase domain rejected';
  END;
  BEGIN
    INSERT INTO account (tenant_id, name, domain, owner_user_id) VALUES (pg_temp.ctx('a_tenant'), 'Dup', 'acme.com', pg_temp.ctx('a_admin'));
    RAISE EXCEPTION 'FAIL: 7b duplicate domain accepted';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS: 7b duplicate domain rejected within a tenant';
  END;
  BEGIN
    INSERT INTO account (tenant_id, name, domain, owner_user_id) VALUES (pg_temp.ctx('a_tenant'), 'Slash', 'acme.com/x', pg_temp.ctx('a_admin'));
    RAISE EXCEPTION 'FAIL: 7c domain with a path accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: 7c domain with a path rejected';
  END;
END $t$;

-- 8. audit trail: insert, update diff, soft delete
DO $t$ DECLARE v_id uuid; v_changes jsonb; v_n int;
BEGIN
  INSERT INTO account (tenant_id, name, owner_user_id) VALUES (pg_temp.ctx('a_tenant'), 'Audited', pg_temp.ctx('a_admin')) RETURNING id INTO v_id;
  UPDATE account SET name = 'Audited Renamed', industry = 'Finance' WHERE id = v_id;
  SELECT changes INTO v_changes FROM audit_log WHERE object = 'account' AND record_id = v_id AND action = 'update';
  IF v_changes -> 'name' = '["Audited", "Audited Renamed"]'::jsonb AND v_changes ? 'industry' AND NOT v_changes ? 'version' THEN
    RAISE NOTICE 'PASS: 8a update audit holds old and new values';
  ELSE RAISE EXCEPTION 'FAIL: 8a audit diff was %', v_changes;
  END IF;
  IF (SELECT actor_user_id FROM audit_log WHERE record_id = v_id AND action = 'insert') = pg_temp.ctx('a_admin') THEN
    RAISE NOTICE 'PASS: 8b audit records the acting user';
  ELSE RAISE EXCEPTION 'FAIL: 8b actor missing';
  END IF;
  UPDATE account SET deleted_at = now() WHERE id = v_id;
  SELECT count(*) INTO v_n FROM audit_log WHERE record_id = v_id AND action = 'delete';
  IF v_n = 1 THEN RAISE NOTICE 'PASS: 8c soft delete is audited as delete';
  ELSE RAISE EXCEPTION 'FAIL: 8c soft delete audit count %', v_n;
  END IF;
  UPDATE account SET name = name WHERE id = v_id;
  SELECT count(*) INTO v_n FROM audit_log WHERE record_id = v_id;
  IF v_n = 3 THEN RAISE NOTICE 'PASS: 8d a no change update writes no audit row';
  ELSE RAISE EXCEPTION 'FAIL: 8d audit rows %', v_n;
  END IF;
  IF (SELECT version FROM account WHERE id = v_id) >= 3 THEN RAISE NOTICE 'PASS: 8e version increments on update';
  ELSE RAISE EXCEPTION 'FAIL: 8e version';
  END IF;
END $t$;

DO $t$ BEGIN
  BEGIN
    UPDATE audit_log SET action = 'x';
    RAISE EXCEPTION 'FAIL: 8f audit_log update allowed';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: 8f audit_log cannot be updated';
  END;
  BEGIN
    DELETE FROM audit_log;
    RAISE EXCEPTION 'FAIL: 8g audit_log delete allowed';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: 8g audit_log cannot be deleted';
  END;
END $t$;

-- 9. case numbers are sequential per tenant
DO $t$ DECLARE v1 int; v2 int; v3 int; vb int;
BEGIN
  INSERT INTO support_case (tenant_id, subject, queue_id) VALUES (pg_temp.ctx('a_tenant'), 'One', pg_temp.ctx('a_queue')) RETURNING case_number INTO v1;
  INSERT INTO support_case (tenant_id, subject, queue_id) VALUES (pg_temp.ctx('a_tenant'), 'Two', pg_temp.ctx('a_queue')) RETURNING case_number INTO v2;
  INSERT INTO support_case (tenant_id, subject, owner_user_id) VALUES (pg_temp.ctx('a_tenant'), 'Three', pg_temp.ctx('a_admin')) RETURNING case_number INTO v3;
  PERFORM pg_temp.use_tenant('b_tenant');
  INSERT INTO support_case (tenant_id, subject, queue_id) VALUES (pg_temp.ctx('b_tenant'), 'B One', pg_temp.ctx('b_queue')) RETURNING case_number INTO vb;
  PERFORM pg_temp.use_tenant('a_tenant');
  IF v1 = 1 AND v2 = 2 AND v3 = 3 AND vb = 1 THEN RAISE NOTICE 'PASS: 9 case numbers are sequential per tenant';
  ELSE RAISE EXCEPTION 'FAIL: 9 numbers were %, %, %, % ', v1, v2, v3, vb;
  END IF;
END $t$;

-- 10. SLA due dates follow priority and recalculate when priority changes
DO $t$ DECLARE c support_case%ROWTYPE;
BEGIN
  INSERT INTO support_case (tenant_id, subject, queue_id, priority) VALUES (pg_temp.ctx('a_tenant'), 'Urgent one', pg_temp.ctx('a_queue'), 'urgent') RETURNING * INTO c;
  IF c.first_response_due_at - c.opened_at = interval '60 minutes' AND c.resolution_due_at - c.opened_at = interval '480 minutes' THEN
    RAISE NOTICE 'PASS: 10a urgent SLA is 60 and 480 minutes';
  ELSE RAISE EXCEPTION 'FAIL: 10a due dates % %', c.first_response_due_at - c.opened_at, c.resolution_due_at - c.opened_at;
  END IF;
  UPDATE support_case SET priority = 'low' WHERE id = c.id RETURNING * INTO c;
  IF c.first_response_due_at - c.opened_at = interval '1440 minutes' AND c.resolution_due_at - c.opened_at = interval '10080 minutes' THEN
    RAISE NOTICE 'PASS: 10b priority change recalculates SLA from opened_at';
  ELSE RAISE EXCEPTION 'FAIL: 10b due dates % %', c.first_response_due_at - c.opened_at, c.resolution_due_at - c.opened_at;
  END IF;
END $t$;

-- 11. a case has an owner or a queue, never both and never neither
DO $t$ BEGIN
  BEGIN
    INSERT INTO support_case (tenant_id, subject, queue_id, owner_user_id) VALUES (pg_temp.ctx('a_tenant'), 'Both', pg_temp.ctx('a_queue'), pg_temp.ctx('a_admin'));
    RAISE EXCEPTION 'FAIL: 11a owner and queue both accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: 11a owner and queue together rejected';
  END;
  BEGIN
    INSERT INTO support_case (tenant_id, subject) VALUES (pg_temp.ctx('a_tenant'), 'Neither');
    RAISE EXCEPTION 'FAIL: 11b no owner and no queue accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: 11b case with no owner and no queue rejected';
  END;
END $t$;

-- 12. first response stamp and 13. resolved and closed stamps
DO $t$ DECLARE v_id uuid; c support_case%ROWTYPE;
BEGIN
  INSERT INTO support_case (tenant_id, subject, queue_id) VALUES (pg_temp.ctx('a_tenant'), 'Lifecycle', pg_temp.ctx('a_queue')) RETURNING id INTO v_id;
  INSERT INTO case_comment (tenant_id, case_id, author_user_id, body, is_public) VALUES (pg_temp.ctx('a_tenant'), v_id, pg_temp.ctx('a_admin'), 'internal note', false);
  IF (SELECT first_response_at FROM support_case WHERE id = v_id) IS NULL THEN RAISE NOTICE 'PASS: 12a internal comment does not count as a first response';
  ELSE RAISE EXCEPTION 'FAIL: 12a internal comment stamped first response';
  END IF;
  INSERT INTO case_comment (tenant_id, case_id, author_user_id, body, is_public) VALUES (pg_temp.ctx('a_tenant'), v_id, NULL, 'customer wrote in', true);
  IF (SELECT first_response_at FROM support_case WHERE id = v_id) IS NULL THEN RAISE NOTICE 'PASS: 12b inbound customer message does not count as a first response';
  ELSE RAISE EXCEPTION 'FAIL: 12b customer message stamped first response';
  END IF;
  INSERT INTO case_comment (tenant_id, case_id, author_user_id, body, is_public) VALUES (pg_temp.ctx('a_tenant'), v_id, pg_temp.ctx('a_admin'), 'public reply', true);
  IF (SELECT first_response_at FROM support_case WHERE id = v_id) IS NOT NULL THEN RAISE NOTICE 'PASS: 12c first public reply stamps first_response_at';
  ELSE RAISE EXCEPTION 'FAIL: 12c first response not stamped';
  END IF;

  UPDATE support_case SET status = 'solved' WHERE id = v_id RETURNING * INTO c;
  IF c.resolved_at IS NOT NULL AND c.closed_at IS NULL THEN RAISE NOTICE 'PASS: 13a solved stamps resolved_at only';
  ELSE RAISE EXCEPTION 'FAIL: 13a solved stamps';
  END IF;
  UPDATE support_case SET status = 'closed' WHERE id = v_id RETURNING * INTO c;
  IF c.resolved_at IS NOT NULL AND c.closed_at IS NOT NULL THEN RAISE NOTICE 'PASS: 13b closed stamps closed_at';
  ELSE RAISE EXCEPTION 'FAIL: 13b closed stamps';
  END IF;
  UPDATE support_case SET status = 'open' WHERE id = v_id RETURNING * INTO c;
  IF c.resolved_at IS NULL AND c.closed_at IS NULL THEN RAISE NOTICE 'PASS: 13c reopening clears resolved and closed';
  ELSE RAISE EXCEPTION 'FAIL: 13c reopen';
  END IF;
  UPDATE support_case SET case_number = 999 WHERE id = v_id RETURNING * INTO c;
  IF c.case_number <> 999 THEN RAISE NOTICE 'PASS: 13d case_number cannot be edited';
  ELSE RAISE EXCEPTION 'FAIL: 13d case_number changed';
  END IF;
END $t$;

-- 14. opportunity stage rules
DO $t$ DECLARE o opportunity%ROWTYPE; v_acct uuid;
BEGIN
  SELECT id INTO v_acct FROM account WHERE name = 'Acme A';
  INSERT INTO opportunity (tenant_id, account_id, name, stage_id, close_date, owner_user_id)
  VALUES (pg_temp.ctx('a_tenant'), v_acct, 'Big deal', pg_temp.ctx('a_stage_prospecting'), current_date + 30, pg_temp.ctx('a_admin'))
  RETURNING * INTO o;
  IF o.probability = 10 AND NOT o.is_closed AND NOT o.is_won THEN RAISE NOTICE 'PASS: 14a probability defaults from the stage';
  ELSE RAISE EXCEPTION 'FAIL: 14a probability % closed %', o.probability, o.is_closed;
  END IF;
  UPDATE opportunity SET stage_id = pg_temp.ctx('a_stage_negotiation'), probability = 60 WHERE id = o.id RETURNING * INTO o;
  IF o.probability = 60 THEN RAISE NOTICE 'PASS: 14b an explicit probability is kept';
  ELSE RAISE EXCEPTION 'FAIL: 14b probability %', o.probability;
  END IF;
  UPDATE opportunity SET stage_id = pg_temp.ctx('a_stage_prospecting') WHERE id = o.id RETURNING * INTO o;
  IF o.probability = 10 THEN RAISE NOTICE 'PASS: 14c moving stage resets probability to the stage default';
  ELSE RAISE EXCEPTION 'FAIL: 14c probability %', o.probability;
  END IF;
  UPDATE opportunity SET stage_id = pg_temp.ctx('a_stage_won') WHERE id = o.id RETURNING * INTO o;
  IF o.is_closed AND o.is_won AND o.probability = 100 AND o.forecast_category = 'closed' THEN RAISE NOTICE 'PASS: 14d closed won sets flags, probability and forecast';
  ELSE RAISE EXCEPTION 'FAIL: 14d won state %', to_jsonb(o);
  END IF;
  BEGIN
    UPDATE opportunity SET stage_id = pg_temp.ctx('a_stage_lost') WHERE id = o.id;
    RAISE EXCEPTION 'FAIL: 14e closed lost without a reason accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: 14e closed lost requires a loss reason';
  END;
  UPDATE opportunity SET stage_id = pg_temp.ctx('a_stage_lost'), loss_reason = 'Price' WHERE id = o.id RETURNING * INTO o;
  IF o.is_closed AND NOT o.is_won AND o.loss_reason = 'Price' THEN RAISE NOTICE 'PASS: 14f closed lost with a reason is accepted';
  ELSE RAISE EXCEPTION 'FAIL: 14f lost state';
  END IF;
  UPDATE opportunity SET stage_id = pg_temp.ctx('a_stage_prospecting') WHERE id = o.id RETURNING * INTO o;
  IF NOT o.is_closed AND o.loss_reason IS NULL AND o.forecast_category = 'pipeline' THEN RAISE NOTICE 'PASS: 14g reopening clears loss reason and closed state';
  ELSE RAISE EXCEPTION 'FAIL: 14g reopen state %', to_jsonb(o);
  END IF;
  BEGIN
    UPDATE opportunity SET stage_id = pg_temp.ctx('b_stage_prospecting') WHERE id = o.id;
    RAISE EXCEPTION 'FAIL: 14h cross tenant stage accepted';
  EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'PASS: 14h stage from another tenant rejected';
  END;
END $t$;

-- 15. health snapshots
DO $t$ DECLARE v_id uuid; v_n int;
BEGIN
  INSERT INTO account (tenant_id, name, owner_user_id, health_score) VALUES (pg_temp.ctx('a_tenant'), 'Scored', pg_temp.ctx('a_admin'), 30) RETURNING id INTO v_id;
  UPDATE account SET health_score = 85 WHERE id = v_id;
  UPDATE account SET health_score = 85, description = 'touch' WHERE id = v_id;
  SELECT count(*) INTO v_n FROM health_snapshot WHERE account_id = v_id;
  IF v_n = 2 AND (SELECT band FROM health_snapshot WHERE account_id = v_id ORDER BY computed_at, id LIMIT 1) = 'at_risk'
     AND (SELECT band FROM health_snapshot WHERE account_id = v_id ORDER BY computed_at DESC, id DESC LIMIT 1) = 'healthy' THEN
    RAISE NOTICE 'PASS: 15a health score changes write snapshots with the right band';
  ELSE RAISE EXCEPTION 'FAIL: 15a snapshots %', v_n;
  END IF;
  BEGIN
    UPDATE health_snapshot SET score = 1 WHERE account_id = v_id;
    RAISE EXCEPTION 'FAIL: 15b snapshot update allowed';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: 15b snapshots cannot be updated';
  END;
END $t$;

-- 16. AI opt out is enforced in the database
DO $t$ DECLARE v_n int;
BEGIN
  INSERT INTO ai_query_log (tenant_id, user_id, prompt, status) VALUES (pg_temp.ctx('a_tenant'), pg_temp.ctx('a_admin'), 'accounts at risk', 'ok');
  RAISE NOTICE 'PASS: 16a AI call logged while AI is enabled';
  UPDATE tenant SET ai_enabled = false WHERE id = pg_temp.ctx('a_tenant');
  BEGIN
    INSERT INTO ai_query_log (tenant_id, user_id, prompt, status) VALUES (pg_temp.ctx('a_tenant'), pg_temp.ctx('a_admin'), 'accounts at risk', 'ok');
    RAISE EXCEPTION 'FAIL: 16b AI call accepted while AI is disabled';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: 16b successful AI call blocked while AI is disabled';
  END;
  INSERT INTO ai_query_log (tenant_id, user_id, prompt, status) VALUES (pg_temp.ctx('a_tenant'), pg_temp.ctx('a_admin'), 'accounts at risk', 'blocked_opt_out');
  RAISE NOTICE 'PASS: 16c blocked attempts are still logged';
  IF (ai_allowed(pg_temp.ctx('b_tenant'))) THEN RAISE EXCEPTION 'FAIL: 16d tenant B visible'; END IF;
  SELECT count(*) INTO v_n FROM audit_log WHERE object = 'tenant' AND changes -> 'ai_enabled' = '[true, false]'::jsonb;
  IF v_n = 1 THEN RAISE NOTICE 'PASS: 16d turning AI off is audited';
  ELSE RAISE EXCEPTION 'FAIL: 16d audit rows %', v_n;
  END IF;
  BEGIN
    UPDATE tenant SET next_case_number = 1 WHERE id = pg_temp.ctx('a_tenant');
    RAISE EXCEPTION 'FAIL: 16e app role changed the case counter';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: 16e app role cannot touch the case counter';
  END;
  BEGIN
    UPDATE ai_query_log SET prompt = 'edited';
    RAISE EXCEPTION 'FAIL: 16f ai_query_log update allowed';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: 16f ai_query_log cannot be updated';
  END;
  UPDATE tenant SET ai_enabled = true WHERE id = pg_temp.ctx('a_tenant');
END $t$;

-- 17. external ids and match candidates
DO $t$ DECLARE v_acct uuid; v_acct2 uuid;
BEGIN
  SELECT id INTO v_acct FROM account WHERE name = 'Acme A';
  SELECT id INTO v_acct2 FROM account WHERE name = 'Scored';
  INSERT INTO external_id (tenant_id, entity_type, entity_id, source_system, source_id)
  VALUES (pg_temp.ctx('a_tenant'), 'account', v_acct, 'salesforce', '001xx000003DGb2AAG');
  RAISE NOTICE 'PASS: 17a external id stored for an existing account';
  BEGIN
    INSERT INTO external_id (tenant_id, entity_type, entity_id, source_system, source_id)
    VALUES (pg_temp.ctx('a_tenant'), 'account', v_acct2, 'salesforce', '001xx000003DGb2AAG');
    RAISE EXCEPTION 'FAIL: 17b duplicate source id accepted';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS: 17b one source record maps to one entity';
  END;
  BEGIN
    INSERT INTO external_id (tenant_id, entity_type, entity_id, source_system, source_id)
    VALUES (pg_temp.ctx('a_tenant'), 'account', gen_random_uuid(), 'hubspot', '123');
    RAISE EXCEPTION 'FAIL: 17c external id for a missing entity accepted';
  EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'PASS: 17c external id for a missing entity rejected';
  END;
  BEGIN
    INSERT INTO match_candidate (tenant_id, entity_type, record_id, candidate_record_id, signal, score, status)
    VALUES (pg_temp.ctx('a_tenant'), 'account', v_acct, v_acct2, 'domain', 0.9, 'merged');
    RAISE EXCEPTION 'FAIL: 17d merged candidate without reviewer accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: 17d a reviewed candidate needs a reviewer';
  END;
  BEGIN
    INSERT INTO match_candidate (tenant_id, entity_type, record_id, candidate_record_id, signal, score)
    VALUES (pg_temp.ctx('a_tenant'), 'account', v_acct, gen_random_uuid(), 'fuzzy_name', 0.5);
    RAISE EXCEPTION 'FAIL: 17e candidate with a missing record accepted';
  EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'PASS: 17e candidate with a missing record rejected';
  END;
  INSERT INTO match_candidate (tenant_id, entity_type, record_id, candidate_record_id, signal, score)
  VALUES (pg_temp.ctx('a_tenant'), 'account', v_acct, v_acct2, 'fuzzy_name', 0.55);
  RAISE NOTICE 'PASS: 17f a pending candidate is accepted';
END $t$;

-- 18. activity needs a link, custom fields need valid definitions
DO $t$ BEGIN
  BEGIN
    INSERT INTO activity (tenant_id, type, subject, owner_user_id) VALUES (pg_temp.ctx('a_tenant'), 'task', 'Orphan', pg_temp.ctx('a_admin'));
    RAISE EXCEPTION 'FAIL: 18a activity without a link accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: 18a an activity must link to a record';
  END;
  BEGIN
    INSERT INTO custom_field_def (tenant_id, object, key, label, data_type) VALUES (pg_temp.ctx('a_tenant'), 'account', 'Bad Key', 'Bad', 'text');
    RAISE EXCEPTION 'FAIL: 18b bad custom field key accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: 18b custom field keys are validated';
  END;
  BEGIN
    INSERT INTO custom_field_def (tenant_id, object, key, label, data_type) VALUES (pg_temp.ctx('a_tenant'), 'account', 'tier', 'Tier', 'picklist');
    RAISE EXCEPTION 'FAIL: 18c picklist without options accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS: 18c a picklist needs options';
  END;
  INSERT INTO custom_field_def (tenant_id, object, key, label, data_type, options)
  VALUES (pg_temp.ctx('a_tenant'), 'account', 'tier', 'Tier', 'picklist', '["gold","silver"]');
  RAISE NOTICE 'PASS: 18d a valid custom field is accepted';
END $t$;

-- 19. access resolution: object and field level, union across roles
DO $t$ DECLARE v_user uuid;
BEGIN
  INSERT INTO app_user (tenant_id, email, display_name, status) VALUES (pg_temp.ctx('a_tenant'), 'fin@a.test', 'Fin Viewer', 'active') RETURNING id INTO v_user;
  INSERT INTO user_role (tenant_id, user_id, role_id) VALUES (pg_temp.ctx('a_tenant'), v_user, pg_temp.ctx('a_role_finance'));
  IF can_do(v_user, 'account', 'read') AND NOT can_do(v_user, 'account', 'edit') AND NOT can_do(v_user, 'contact', 'read')
     AND can_do(pg_temp.ctx('a_admin'), 'account', 'delete') THEN
    RAISE NOTICE 'PASS: 19a object permissions resolve per role';
  ELSE RAISE EXCEPTION 'FAIL: 19a object permissions';
  END IF;
  IF field_access(v_user, 'account', 'annual_revenue') = 'read' THEN RAISE NOTICE 'PASS: 19b field access defaults to the object permission';
  ELSE RAISE EXCEPTION 'FAIL: 19b field access %', field_access(v_user, 'account', 'annual_revenue');
  END IF;
  INSERT INTO field_permission (tenant_id, role_id, object, field, access) VALUES (pg_temp.ctx('a_tenant'), pg_temp.ctx('a_role_finance'), 'account', 'annual_revenue', 'none');
  IF field_access(v_user, 'account', 'annual_revenue') = 'none' AND field_access(v_user, 'account', 'name') = 'read' THEN RAISE NOTICE 'PASS: 19c a field row hides one field without hiding the object';
  ELSE RAISE EXCEPTION 'FAIL: 19c field hiding';
  END IF;
  INSERT INTO user_role (tenant_id, user_id, role_id) VALUES (pg_temp.ctx('a_tenant'), v_user, pg_temp.ctx('a_role_sales'));
  IF field_access(v_user, 'account', 'annual_revenue') = 'edit' THEN RAISE NOTICE 'PASS: 19d the highest access across roles wins';
  ELSE RAISE EXCEPTION 'FAIL: 19d union %', field_access(v_user, 'account', 'annual_revenue');
  END IF;
  UPDATE app_user SET status = 'disabled' WHERE id = v_user;
  IF NOT can_do(v_user, 'account', 'read') AND field_access(v_user, 'account', 'name') = 'none' THEN RAISE NOTICE 'PASS: 19e a disabled user has no access';
  ELSE RAISE EXCEPTION 'FAIL: 19e disabled user';
  END IF;
END $t$;

-- 20. the app role cannot provision tenants
DO $t$ BEGIN
  BEGIN
    PERFORM provision_tenant('Rogue', 'rogue', 'r@r.test', 'Rogue');
    RAISE EXCEPTION 'FAIL: 20 app role provisioned a tenant';
  EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS: 20 app role cannot provision tenants';
  END;
END $t$;
