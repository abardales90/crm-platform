-- 0003 audit log: append only record of every change and every AI call
-- No foreign key to tenant on purpose: the log must survive a tenant purge decision.

CREATE TABLE audit_log (
  id             uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id      uuid NOT NULL,
  actor_user_id  uuid,
  actor_type     text NOT NULL DEFAULT 'user' CHECK (actor_type IN ('user', 'system', 'sync', 'ai')),
  action         text NOT NULL,
  object         text NOT NULL,
  record_id      uuid,
  changes        jsonb,
  request_id     text,
  ip_address     inet,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_record_idx ON audit_log (tenant_id, object, record_id, created_at DESC);
CREATE INDEX audit_log_actor_idx  ON audit_log (tenant_id, actor_user_id, created_at DESC);
CREATE INDEX audit_log_time_idx   ON audit_log (tenant_id, created_at DESC);

-- No update, no delete, for any role including the owner.
CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION trg_append_only();
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION trg_append_only();
