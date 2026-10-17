-- Adds email: the email_message table. Paste into the Neon SQL Editor and run once.
BEGIN;
-- 0009 email: a record of every email the CRM sends

CREATE TABLE email_message (
  id                   uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id            uuid NOT NULL REFERENCES tenant (id),
  case_id              uuid,
  contact_id           uuid,
  to_email             text NOT NULL CHECK (position('@' IN to_email) > 1),
  from_email           text NOT NULL,
  subject              text NOT NULL CHECK (length(btrim(subject)) > 0),
  body                 text NOT NULL CHECK (length(btrim(body)) > 0),
  status               text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
  provider_message_id  text,
  error                text,
  sent_at              timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,
  updated_by           uuid,
  deleted_at           timestamptz,
  version              integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES support_case (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contact (tenant_id, id)
);
CREATE INDEX email_message_case_idx ON email_message (tenant_id, case_id, created_at);

ALTER TABLE email_message ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_message FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON email_message
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- The app can write and update a message while it is being sent. It cannot delete one.
GRANT SELECT, INSERT, UPDATE ON email_message TO crm_app;
GRANT SELECT ON email_message TO crm_readonly;

CREATE TRIGGER email_message_std BEFORE INSERT OR UPDATE ON email_message
  FOR EACH ROW EXECUTE FUNCTION trg_set_standard_columns();
CREATE TRIGGER email_message_tenant_immutable BEFORE UPDATE ON email_message
  FOR EACH ROW EXECUTE FUNCTION trg_prevent_tenant_change();

INSERT INTO schema_migrations (filename) VALUES ('0009_email.sql');
COMMIT;
