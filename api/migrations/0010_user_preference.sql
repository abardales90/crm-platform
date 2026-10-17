-- 0010 user preferences: each person's accent color, whether they finished the welcome tour,
-- and the last update note they saw. One row per person.

CREATE TABLE user_preference (
  id                 uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id          uuid NOT NULL REFERENCES tenant (id),
  user_id            uuid NOT NULL,
  accent             text CHECK (accent IN ('green', 'blue', 'purple', 'orange', 'rose', 'slate')),
  tour_done_at       timestamptz,
  last_seen_release  text CHECK (length(last_seen_release) <= 40),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid,
  updated_by         uuid,
  deleted_at         timestamptz,
  version            integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_user (tenant_id, id)
);

ALTER TABLE user_preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preference FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_preference
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON user_preference TO crm_app;
GRANT SELECT ON user_preference TO crm_readonly;

CREATE TRIGGER user_preference_std BEFORE INSERT OR UPDATE ON user_preference
  FOR EACH ROW EXECUTE FUNCTION trg_set_standard_columns();
CREATE TRIGGER user_preference_tenant_immutable BEFORE UPDATE ON user_preference
  FOR EACH ROW EXECUTE FUNCTION trg_prevent_tenant_change();
