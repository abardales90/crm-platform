-- 0013 saved views: a named set of list filters. Private to the person who made it, or shared with the whole workspace.

CREATE TABLE saved_view (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id),
  user_id     uuid NOT NULL,
  object      text NOT NULL CHECK (object IN ('accounts', 'contacts', 'deals', 'cases')),
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  filter      jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(filter) = 'object' AND length(filter::text) <= 8000),
  is_shared   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid,
  deleted_at  timestamptz,
  version     integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_user (tenant_id, id)
);
CREATE UNIQUE INDEX saved_view_name_uq ON saved_view (tenant_id, user_id, object, lower(btrim(name))) WHERE deleted_at IS NULL;

ALTER TABLE saved_view ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_view FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON saved_view
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON saved_view TO crm_app;
GRANT SELECT ON saved_view TO crm_readonly;

CREATE TRIGGER saved_view_std BEFORE INSERT OR UPDATE ON saved_view
  FOR EACH ROW EXECUTE FUNCTION trg_set_standard_columns();
CREATE TRIGGER saved_view_tenant_immutable BEFORE UPDATE ON saved_view
  FOR EACH ROW EXECUTE FUNCTION trg_prevent_tenant_change();
