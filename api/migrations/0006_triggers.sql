-- 0006 triggers: standard columns, tenant immutability, append only tables,
-- audit capture, and the business rules that keep records consistent

-- ---------------------------------------------------------------- helpers

CREATE OR REPLACE FUNCTION trg_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION health_band(p_score integer) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN p_score < 40 THEN 'at_risk' WHEN p_score < 70 THEN 'watch' ELSE 'healthy' END;
$$;

CREATE OR REPLACE FUNCTION ai_allowed(p_tenant uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT ai_enabled FROM tenant WHERE id = p_tenant), false);
$$;

-- Does a record of this entity type exist in this tenant? Used where a plain foreign key cannot span tables.
CREATE OR REPLACE FUNCTION record_exists(p_tenant uuid, p_entity_type text, p_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_table text;
  v_exists boolean;
BEGIN
  v_table := CASE p_entity_type
    WHEN 'account' THEN 'account'
    WHEN 'contact' THEN 'contact'
    WHEN 'opportunity' THEN 'opportunity'
    WHEN 'case' THEN 'support_case'
  END;
  IF v_table IS NULL THEN
    RETURN false;
  END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE tenant_id = $1 AND id = $2)', v_table)
    INTO v_exists USING p_tenant, p_id;
  RETURN v_exists;
END $$;

-- ---------------------------------------------------------------- audit capture

CREATE OR REPLACE FUNCTION trg_audit_row_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_old     jsonb;
  v_new     jsonb;
  v_row     jsonb;
  v_tenant  uuid;
  v_action  text;
  v_changes jsonb;
  v_actor   uuid := current_user_id();
  v_type    text;
BEGIN
  v_type := COALESCE(NULLIF(current_setting('app.actor_type', true), ''),
                     CASE WHEN v_actor IS NULL THEN 'system' ELSE 'user' END);

  IF TG_OP = 'INSERT' THEN
    v_row := to_jsonb(NEW);
    v_action := 'insert';
    v_changes := v_row;
  ELSIF TG_OP = 'DELETE' THEN
    v_row := to_jsonb(OLD);
    v_action := 'hard_delete';
    v_changes := v_row;
  ELSE
    v_old := to_jsonb(OLD);
    v_new := to_jsonb(NEW);
    v_row := v_new;
    SELECT jsonb_object_agg(n.key, jsonb_build_array(o.value, n.value))
      INTO v_changes
      FROM jsonb_each(v_new) n
      LEFT JOIN jsonb_each(v_old) o ON o.key = n.key
     WHERE n.value IS DISTINCT FROM o.value
       AND n.key NOT IN ('updated_at', 'updated_by', 'version', 'next_case_number');
    IF v_changes IS NULL THEN
      RETURN NULL;   -- nothing meaningful changed
    END IF;
    v_action := CASE WHEN v_changes ? 'deleted_at' AND (v_old ->> 'deleted_at') IS NULL
                     THEN 'delete' ELSE 'update' END;
  END IF;

  IF TG_TABLE_NAME = 'tenant' THEN
    v_tenant := (v_row ->> 'id')::uuid;
  ELSE
    v_tenant := (v_row ->> 'tenant_id')::uuid;
  END IF;

  INSERT INTO audit_log (tenant_id, actor_user_id, actor_type, action, object, record_id, changes, request_id)
  VALUES (v_tenant, v_actor, v_type, v_action, TG_TABLE_NAME, (v_row ->> 'id')::uuid, v_changes,
          NULLIF(current_setting('app.request_id', true), ''));
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------- business rules

-- Case: per tenant number, SLA due times, resolved and closed stamps.
CREATE OR REPLACE FUNCTION trg_case_before() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_first integer;
  v_resolve integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE tenant SET next_case_number = next_case_number + 1
     WHERE id = NEW.tenant_id
    RETURNING next_case_number - 1 INTO NEW.case_number;
  ELSE
    NEW.case_number := OLD.case_number;   -- never changes
  END IF;

  IF TG_OP = 'INSERT' OR NEW.priority IS DISTINCT FROM OLD.priority THEN
    SELECT first_response_minutes, resolution_minutes INTO v_first, v_resolve
      FROM sla_policy
     WHERE tenant_id = NEW.tenant_id AND priority = NEW.priority
       AND is_active AND deleted_at IS NULL;
    IF FOUND THEN
      NEW.first_response_due_at := NEW.opened_at + make_interval(mins => v_first);
      NEW.resolution_due_at     := NEW.opened_at + make_interval(mins => v_resolve);
    END IF;
  END IF;

  IF NEW.status IN ('solved', 'closed') AND NEW.resolved_at IS NULL THEN
    NEW.resolved_at := now();
  END IF;
  IF NEW.status = 'closed' AND NEW.closed_at IS NULL THEN
    NEW.closed_at := now();
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('solved', 'closed') AND NEW.status NOT IN ('solved', 'closed') THEN
    NEW.resolved_at := NULL;   -- reopened
    NEW.closed_at := NULL;
  END IF;
  RETURN NEW;
END $$;

-- First public reply from a person stamps first_response_at on the case.
CREATE OR REPLACE FUNCTION trg_comment_first_response() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_public AND NEW.author_user_id IS NOT NULL THEN
    UPDATE support_case SET first_response_at = NEW.created_at
     WHERE tenant_id = NEW.tenant_id AND id = NEW.case_id AND first_response_at IS NULL;
  END IF;
  RETURN NULL;
END $$;

-- Opportunity: closed and won flags follow the stage. Probability follows the stage
-- unless the user set it in the same change.
CREATE OR REPLACE FUNCTION trg_opportunity_before() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_stage pipeline_stage%ROWTYPE;
BEGIN
  SELECT * INTO v_stage FROM pipeline_stage WHERE tenant_id = NEW.tenant_id AND id = NEW.stage_id;
  IF NOT FOUND THEN
    RETURN NEW;   -- the foreign key reports the problem
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.probability IS NULL THEN
      NEW.probability := v_stage.default_probability;
    END IF;
  ELSIF NEW.stage_id IS DISTINCT FROM OLD.stage_id
        AND NEW.probability IS NOT DISTINCT FROM OLD.probability THEN
    NEW.probability := v_stage.default_probability;
  END IF;

  NEW.is_closed := v_stage.is_closed;
  NEW.is_won := v_stage.is_won;
  IF v_stage.is_closed THEN
    NEW.forecast_category := 'closed';
  ELSE
    NEW.loss_reason := NULL;
    IF TG_OP = 'UPDATE' AND OLD.is_closed AND NEW.forecast_category = 'closed' THEN
      NEW.forecast_category := 'pipeline';   -- reopened
    END IF;
  END IF;
  RETURN NEW;
END $$;

-- Account: a change to health_score writes a snapshot row.
CREATE OR REPLACE FUNCTION trg_account_health() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.health_score IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.health_score IS DISTINCT FROM OLD.health_score) THEN
    INSERT INTO health_snapshot (tenant_id, account_id, score, band, inputs)
    VALUES (NEW.tenant_id, NEW.id, NEW.health_score, health_band(NEW.health_score),
            jsonb_build_object('source', 'manual', 'set_by', current_user_id()));
  END IF;
  RETURN NULL;
END $$;

-- external_id and match_candidate point at records in other tables.
CREATE OR REPLACE FUNCTION trg_external_id_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT record_exists(NEW.tenant_id, NEW.entity_type, NEW.entity_id) THEN
    RAISE EXCEPTION 'external_id: % % does not exist in this tenant', NEW.entity_type, NEW.entity_id
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION trg_match_candidate_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT record_exists(NEW.tenant_id, NEW.entity_type, NEW.record_id)
     OR NOT record_exists(NEW.tenant_id, NEW.entity_type, NEW.candidate_record_id) THEN
    RAISE EXCEPTION 'match_candidate: both records must exist in this tenant' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END $$;

-- AI opt out, enforced in the database as well as the API.
CREATE OR REPLACE FUNCTION trg_ai_log_opt_out() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'ok' AND NOT ai_allowed(NEW.tenant_id) THEN
    RAISE EXCEPTION 'AI is disabled for this tenant' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------- attach triggers

DO $$
DECLARE
  t text;
BEGIN
  -- standard columns
  FOREACH t IN ARRAY ARRAY['app_user', 'role', 'pipeline_stage', 'queue', 'sla_policy', 'account',
                           'contact', 'opportunity', 'support_case', 'case_comment', 'activity',
                           'custom_field_def'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION trg_set_standard_columns()',
                   t || '_std', t);
  END LOOP;

  -- updated_at only
  FOREACH t IN ARRAY ARRAY['tenant', 'external_id', 'match_candidate'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION trg_touch_updated_at()',
                   t || '_touch', t);
  END LOOP;

  -- tenant_id is immutable on every tenant table
  FOR t IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables tb
        ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
     WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
       AND tb.table_type = 'BASE TABLE'
       AND c.table_name NOT IN ('audit_log', 'ai_query_log', 'redaction_event', 'health_snapshot')
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION trg_prevent_tenant_change()',
                   t || '_tenant_immutable', t);
  END LOOP;

  -- evidence tables never change
  FOREACH t IN ARRAY ARRAY['ai_query_log', 'redaction_event', 'health_snapshot'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION trg_append_only()',
                   t || '_immutable', t);
  END LOOP;

  -- audit capture
  FOREACH t IN ARRAY ARRAY['tenant', 'app_user', 'role', 'user_role', 'role_permission', 'field_permission',
                           'pipeline_stage', 'queue', 'sla_policy', 'account', 'contact', 'opportunity',
                           'support_case', 'case_comment', 'activity', 'custom_field_def', 'external_id',
                           'match_candidate'] LOOP
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION trg_audit_row_change()',
                   t || '_audit', t);
  END LOOP;
END $$;

CREATE TRIGGER support_case_rules BEFORE INSERT OR UPDATE ON support_case
  FOR EACH ROW EXECUTE FUNCTION trg_case_before();
CREATE TRIGGER case_comment_first_response AFTER INSERT ON case_comment
  FOR EACH ROW EXECUTE FUNCTION trg_comment_first_response();
CREATE TRIGGER opportunity_rules BEFORE INSERT OR UPDATE ON opportunity
  FOR EACH ROW EXECUTE FUNCTION trg_opportunity_before();
CREATE TRIGGER account_health_snapshot AFTER INSERT OR UPDATE OF health_score ON account
  FOR EACH ROW EXECUTE FUNCTION trg_account_health();
CREATE TRIGGER external_id_entity_check BEFORE INSERT OR UPDATE ON external_id
  FOR EACH ROW EXECUTE FUNCTION trg_external_id_check();
CREATE TRIGGER match_candidate_entity_check BEFORE INSERT OR UPDATE ON match_candidate
  FOR EACH ROW EXECUTE FUNCTION trg_match_candidate_check();
CREATE TRIGGER ai_query_log_opt_out BEFORE INSERT ON ai_query_log
  FOR EACH ROW EXECUTE FUNCTION trg_ai_log_opt_out();
