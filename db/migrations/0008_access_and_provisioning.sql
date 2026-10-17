-- 0008 access resolution and tenant provisioning

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_provisioner') THEN
    CREATE ROLE crm_provisioner NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

-- Object level check: does any of the user's roles allow this action?
CREATE OR REPLACE FUNCTION can_do(p_user uuid, p_object text, p_action text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(bool_or(
    CASE p_action
      WHEN 'read'   THEN rp.can_read
      WHEN 'create' THEN rp.can_create
      WHEN 'edit'   THEN rp.can_edit
      WHEN 'delete' THEN rp.can_delete
      ELSE false
    END), false)
  FROM user_role ur
  JOIN app_user u ON u.tenant_id = ur.tenant_id AND u.id = ur.user_id
  JOIN role_permission rp ON rp.tenant_id = ur.tenant_id AND rp.role_id = ur.role_id AND rp.object = p_object
  WHERE ur.user_id = p_user
    AND ur.tenant_id = current_tenant_id()
    AND u.status <> 'disabled' AND u.deleted_at IS NULL;
$$;

-- Field level check. Per role: an explicit field row wins, otherwise the object permission applies.
-- Across roles the highest result wins. Returns none, read or edit.
CREATE OR REPLACE FUNCTION field_access(p_user uuid, p_object text, p_field text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT CASE COALESCE(max(s.rank), 0) WHEN 2 THEN 'edit' WHEN 1 THEN 'read' ELSE 'none' END
  FROM (
    SELECT CASE
             WHEN fp.access IS NOT NULL THEN CASE fp.access WHEN 'edit' THEN 2 WHEN 'read' THEN 1 ELSE 0 END
             WHEN rp.can_edit THEN 2
             WHEN rp.can_read THEN 1
             ELSE 0
           END AS rank
      FROM user_role ur
      JOIN app_user u ON u.tenant_id = ur.tenant_id AND u.id = ur.user_id
      LEFT JOIN role_permission rp
             ON rp.tenant_id = ur.tenant_id AND rp.role_id = ur.role_id AND rp.object = p_object
      LEFT JOIN field_permission fp
             ON fp.tenant_id = ur.tenant_id AND fp.role_id = ur.role_id
            AND fp.object = p_object AND fp.field = p_field
     WHERE ur.user_id = p_user
       AND ur.tenant_id = current_tenant_id()
       AND u.status <> 'disabled' AND u.deleted_at IS NULL
  ) s;
$$;

-- Creates a tenant with its starter roles, pipeline, queue, SLA targets and first admin.
-- Runs as the owner. Call it in its own transaction from an admin connection, never from the app role.
CREATE OR REPLACE FUNCTION provision_tenant(
  p_name text, p_slug text, p_admin_email text, p_admin_name text, p_region text DEFAULT 'us'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_tenant  uuid := uuid_v7();
  v_admin   uuid;
  v_role    uuid;
  v_role_nm text;
  v_obj     text;
  v_perms   text;
  v_prev_t  text := current_setting('app.tenant_id', true);
  v_prev_a  text := current_setting('app.actor_type', true);
  v_matrix  jsonb := '{
    "Tenant Admin":   {"account":"rcud","contact":"rcud","opportunity":"rcud","case":"rcud","case_comment":"rcud","activity":"rcud","pipeline_stage":"rcud","queue":"rcud","sla_policy":"rcud","custom_field":"rcud","app_user":"rcud","role":"rcud"},
    "RevOps Admin":   {"account":"rcud","contact":"rcud","opportunity":"rcud","case":"rcud","case_comment":"rcud","activity":"rcud","pipeline_stage":"rcud","queue":"rcud","sla_policy":"rcud","custom_field":"rcud","app_user":"r","role":"r"},
    "Sales":          {"account":"rcu","contact":"rcu","opportunity":"rcu","case":"r","case_comment":"r","activity":"rcu","pipeline_stage":"r"},
    "Support Agent":  {"account":"r","contact":"rcu","case":"rcu","case_comment":"rcu","activity":"rcu","queue":"r","sla_policy":"r"},
    "Support Lead":   {"account":"r","contact":"rcu","case":"rcud","case_comment":"rcud","activity":"rcud","queue":"rcu","sla_policy":"r"},
    "CSM":            {"account":"rcu","contact":"rcu","opportunity":"r","case":"r","case_comment":"r","activity":"rcu"},
    "Finance Viewer": {"account":"r","opportunity":"r"},
    "Read Only":      {"account":"r","contact":"r","opportunity":"r","case":"r","case_comment":"r","activity":"r"}
  }'::jsonb;
BEGIN
  PERFORM set_config('app.tenant_id', v_tenant::text, true);
  PERFORM set_config('app.actor_type', 'system', true);

  INSERT INTO tenant (id, name, slug, region) VALUES (v_tenant, p_name, p_slug, p_region);

  INSERT INTO pipeline_stage (tenant_id, name, sort_order, default_probability, is_closed, is_won) VALUES
    (v_tenant, 'Prospecting',   1,  10, false, false),
    (v_tenant, 'Qualification', 2,  20, false, false),
    (v_tenant, 'Proposal',      3,  50, false, false),
    (v_tenant, 'Negotiation',   4,  75, false, false),
    (v_tenant, 'Closed Won',    5, 100, true,  true),
    (v_tenant, 'Closed Lost',   6,   0, true,  false);

  INSERT INTO queue (tenant_id, name, description)
  VALUES (v_tenant, 'General', 'Default queue for new cases');

  -- Starter SLA targets in minutes. Edit per tenant. Wall clock time, not business hours.
  INSERT INTO sla_policy (tenant_id, priority, first_response_minutes, resolution_minutes) VALUES
    (v_tenant, 'urgent',   60,  480),
    (v_tenant, 'high',    240, 1440),
    (v_tenant, 'normal',  480, 4320),
    (v_tenant, 'low',    1440, 10080);

  FOR v_role_nm IN SELECT jsonb_object_keys(v_matrix) LOOP
    INSERT INTO role (tenant_id, name, description, is_system)
    VALUES (v_tenant, v_role_nm, 'Starter role', true)
    RETURNING id INTO v_role;

    FOR v_obj, v_perms IN SELECT key, value FROM jsonb_each_text(v_matrix -> v_role_nm) LOOP
      INSERT INTO role_permission (tenant_id, role_id, object, can_read, can_create, can_edit, can_delete)
      VALUES (v_tenant, v_role, v_obj,
              position('r' IN v_perms) > 0, position('c' IN v_perms) > 0,
              position('u' IN v_perms) > 0, position('d' IN v_perms) > 0);
    END LOOP;
  END LOOP;

  INSERT INTO app_user (tenant_id, email, display_name, status)
  VALUES (v_tenant, lower(p_admin_email), p_admin_name, 'invited')
  RETURNING id INTO v_admin;

  INSERT INTO user_role (tenant_id, user_id, role_id)
  SELECT v_tenant, v_admin, id FROM role WHERE tenant_id = v_tenant AND name = 'Tenant Admin';

  -- put the session settings back the way they were
  PERFORM set_config('app.tenant_id', COALESCE(v_prev_t, ''), true);
  PERFORM set_config('app.actor_type', COALESCE(v_prev_a, ''), true);
  RETURN v_tenant;
END $$;

REVOKE ALL ON FUNCTION provision_tenant(text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION provision_tenant(text, text, text, text, text) TO crm_provisioner;
