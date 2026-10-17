-- 0012 custom fields: each workspace can add its own fields to accounts, contacts, deals and cases.
-- The definitions live here. The values live in the existing "custom" column of each record.

CREATE TABLE custom_field (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id),
  object      text NOT NULL CHECK (object IN ('account', 'contact', 'opportunity', 'case')),
  key         text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label       text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 60),
  kind        text NOT NULL CHECK (kind IN ('text', 'long text', 'number', 'date', 'checkbox', 'pick one')),
  options     text[] CHECK (options IS NULL OR cardinality(options) BETWEEN 1 AND 30),
  required    boolean NOT NULL DEFAULT false,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid,
  deleted_at  timestamptz,
  version     integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  CHECK ((kind = 'pick one') = (options IS NOT NULL))
);
-- A key is never reused for another field, even after the old one is removed.
CREATE UNIQUE INDEX custom_field_key_uq ON custom_field (tenant_id, object, key);

ALTER TABLE custom_field ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_field FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON custom_field
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON custom_field TO crm_app;
GRANT SELECT ON custom_field TO crm_readonly;

CREATE TRIGGER custom_field_std BEFORE INSERT OR UPDATE ON custom_field
  FOR EACH ROW EXECUTE FUNCTION trg_set_standard_columns();
CREATE TRIGGER custom_field_tenant_immutable BEFORE UPDATE ON custom_field
  FOR EACH ROW EXECUTE FUNCTION trg_prevent_tenant_change();
