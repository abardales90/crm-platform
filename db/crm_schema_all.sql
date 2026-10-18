-- CRM schema v0: all 10 migrations in order. Paste into the Neon SQL Editor and run once.
BEGIN;
CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());

-- ===== migrations/0001_foundation.sql =====
-- 0001 foundation: extensions, database roles, helper functions
-- Run as the owner role (or a superuser in local testing).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Database roles. NOLOGIN group roles: real login roles are created per environment
-- and granted membership. None of these can bypass row level security.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_app') THEN
    CREATE ROLE crm_app NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crm_readonly') THEN
    CREATE ROLE crm_readonly NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

-- Time ordered UUID (version 7). Postgres 16 has no native generator.
CREATE OR REPLACE FUNCTION uuid_v7() RETURNS uuid
LANGUAGE sql VOLATILE AS $$
  SELECT encode(
    set_bit(
      set_bit(
        overlay(uuid_send(gen_random_uuid())
                placing substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
                FROM 1 FOR 6),
        52, 1),
      53, 1),
    'hex')::uuid;
$$;

-- The tenant for this transaction. Errors if app.tenant_id is not set, so a
-- request that forgot to set it fails instead of returning rows.
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.tenant_id')::uuid;
$$;

-- The acting user for this transaction. Null for system jobs.
CREATE OR REPLACE FUNCTION current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid;
$$;

-- Standard columns: updated_at, updated_by, version; created_by on insert.
CREATE OR REPLACE FUNCTION trg_set_standard_columns() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_by := COALESCE(NEW.created_by, current_user_id());
    NEW.updated_by := COALESCE(NEW.updated_by, current_user_id());
    NEW.version := 1;
  ELSE
    NEW.updated_at := now();
    NEW.updated_by := current_user_id();
    NEW.version := OLD.version + 1;
    NEW.created_at := OLD.created_at;
    NEW.created_by := OLD.created_by;
  END IF;
  RETURN NEW;
END $$;

-- A row can never move to another tenant, even for a role that bypasses RLS.
CREATE OR REPLACE FUNCTION trg_prevent_tenant_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'tenant_id is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

-- Used on tables that must never change after insert.
CREATE OR REPLACE FUNCTION trg_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append only', TG_TABLE_NAME USING ERRCODE = '42501';
END $$;

INSERT INTO schema_migrations (filename) VALUES ('0001_foundation.sql');

-- ===== migrations/0002_tenancy.sql =====
-- 0002 tenancy and access: tenant, app_user, role, user_role, role_permission, field_permission

CREATE TABLE tenant (
  id                uuid PRIMARY KEY DEFAULT uuid_v7(),
  name              text NOT NULL CHECK (length(btrim(name)) > 0),
  slug              text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  status            text NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'suspended', 'offboarding')),
  region            text NOT NULL DEFAULT 'us',
  default_currency  char(3) NOT NULL DEFAULT 'USD' CHECK (default_currency = upper(default_currency)),
  ai_enabled        boolean NOT NULL DEFAULT true,   -- the AI opt out switch
  settings          jsonb NOT NULL DEFAULT '{}'::jsonb,
  next_case_number  integer NOT NULL DEFAULT 1,      -- per tenant case counter
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_user (
  id             uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id      uuid NOT NULL REFERENCES tenant (id),
  email          text NOT NULL CHECK (email = lower(email)),
  display_name   text NOT NULL,
  status         text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
  sso_subject    text,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid,
  updated_by     uuid,
  deleted_at     timestamptz,
  version        integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, email)
);

CREATE TABLE role (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id),
  name         text NOT NULL,
  description  text,
  is_system    boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_by   uuid,
  deleted_at   timestamptz,
  version      integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE user_role (
  tenant_id  uuid NOT NULL,
  user_id    uuid NOT NULL,
  role_id    uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, role_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, role_id) REFERENCES role (tenant_id, id)
);

CREATE TABLE role_permission (
  tenant_id   uuid NOT NULL,
  role_id     uuid NOT NULL,
  object      text NOT NULL,
  can_read    boolean NOT NULL DEFAULT false,
  can_create  boolean NOT NULL DEFAULT false,
  can_edit    boolean NOT NULL DEFAULT false,
  can_delete  boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, role_id, object),
  FOREIGN KEY (tenant_id, role_id) REFERENCES role (tenant_id, id),
  CHECK (NOT (can_edit OR can_create OR can_delete) OR can_read)
);

CREATE TABLE field_permission (
  tenant_id  uuid NOT NULL,
  role_id    uuid NOT NULL,
  object     text NOT NULL,
  field      text NOT NULL,
  access     text NOT NULL CHECK (access IN ('none', 'read', 'edit')),
  PRIMARY KEY (tenant_id, role_id, object, field),
  FOREIGN KEY (tenant_id, role_id) REFERENCES role (tenant_id, id)
);

CREATE INDEX app_user_sso_idx ON app_user (tenant_id, sso_subject) WHERE sso_subject IS NOT NULL;
CREATE INDEX user_role_role_idx ON user_role (tenant_id, role_id);

INSERT INTO schema_migrations (filename) VALUES ('0002_tenancy.sql');

-- ===== migrations/0003_audit.sql =====
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

INSERT INTO schema_migrations (filename) VALUES ('0003_audit.sql');

-- ===== migrations/0004_crm_core.sql =====
-- 0004 core CRM: pipeline_stage, queue, sla_policy, account, contact, opportunity,
-- support_case, case_comment, activity
-- The doc calls the case table "Case". CASE is a reserved word in SQL, so the table is support_case.

CREATE TABLE pipeline_stage (
  id                   uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id            uuid NOT NULL REFERENCES tenant (id),
  name                 text NOT NULL,
  sort_order           integer NOT NULL,
  default_probability  integer NOT NULL CHECK (default_probability BETWEEN 0 AND 100),
  is_closed            boolean NOT NULL DEFAULT false,
  is_won               boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,
  updated_by           uuid,
  deleted_at           timestamptz,
  version              integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name),
  CHECK (NOT is_won OR is_closed)
);

CREATE TABLE queue (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id),
  name         text NOT NULL,
  description  text,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_by   uuid,
  deleted_at   timestamptz,
  version      integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name)
);

CREATE TABLE sla_policy (
  id                      uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id               uuid NOT NULL REFERENCES tenant (id),
  priority                text NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  first_response_minutes  integer NOT NULL CHECK (first_response_minutes > 0),
  resolution_minutes      integer NOT NULL CHECK (resolution_minutes > 0),
  is_active               boolean NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid,
  updated_by              uuid,
  deleted_at              timestamptz,
  version                 integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, priority),
  CHECK (resolution_minutes >= first_response_minutes)
);

CREATE TABLE account (
  id                    uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id             uuid NOT NULL REFERENCES tenant (id),
  name                  text NOT NULL CHECK (length(btrim(name)) > 0),
  type                  text CHECK (type IN ('prospect', 'customer', 'partner', 'former customer')),
  industry              text,
  website               text,
  domain                text CHECK (domain = lower(domain) AND domain !~ '[/:\s]'),
  phone                 text,
  number_of_employees   integer CHECK (number_of_employees >= 0),
  annual_revenue        numeric(18,2) CHECK (annual_revenue >= 0),
  billing_address       jsonb NOT NULL DEFAULT '{}'::jsonb,
  shipping_address      jsonb NOT NULL DEFAULT '{}'::jsonb,
  parent_account_id     uuid,
  owner_user_id         uuid NOT NULL,
  renewal_date          date,
  health_score          integer CHECK (health_score BETWEEN 0 AND 100),
  description           text,
  custom                jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid,
  updated_by            uuid,
  deleted_at            timestamptz,
  version               integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, parent_account_id) REFERENCES account (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_user_id) REFERENCES app_user (tenant_id, id),
  CHECK (parent_account_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX account_domain_uq ON account (tenant_id, domain)
  WHERE domain IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX account_owner_idx   ON account (tenant_id, owner_user_id) WHERE deleted_at IS NULL;
CREATE INDEX account_parent_idx  ON account (tenant_id, parent_account_id) WHERE parent_account_id IS NOT NULL;
CREATE INDEX account_renewal_idx ON account (tenant_id, renewal_date) WHERE renewal_date IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX account_name_idx    ON account (tenant_id, lower(name));

CREATE TABLE contact (
  id                     uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id              uuid NOT NULL REFERENCES tenant (id),
  account_id             uuid,
  first_name             text,
  last_name              text NOT NULL CHECK (length(btrim(last_name)) > 0),
  email                  text CHECK (email = lower(email)),
  phone                  text,
  mobile                 text,
  title                  text,
  department             text,
  reports_to_contact_id  uuid,
  mailing_address        jsonb NOT NULL DEFAULT '{}'::jsonb,
  lead_source            text,
  do_not_contact         boolean NOT NULL DEFAULT false,
  owner_user_id          uuid NOT NULL,
  description            text,
  custom                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid,
  updated_by             uuid,
  deleted_at             timestamptz,
  version                integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES account (tenant_id, id),
  FOREIGN KEY (tenant_id, reports_to_contact_id) REFERENCES contact (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_user_id) REFERENCES app_user (tenant_id, id),
  CHECK (reports_to_contact_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX contact_email_uq ON contact (tenant_id, email)
  WHERE email IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX contact_account_idx ON contact (tenant_id, account_id) WHERE deleted_at IS NULL;
CREATE INDEX contact_owner_idx   ON contact (tenant_id, owner_user_id) WHERE deleted_at IS NULL;
CREATE INDEX contact_name_idx    ON contact (tenant_id, lower(last_name), lower(first_name));

CREATE TABLE opportunity (
  id                  uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id           uuid NOT NULL REFERENCES tenant (id),
  account_id          uuid NOT NULL,
  primary_contact_id  uuid,
  name                text NOT NULL CHECK (length(btrim(name)) > 0),
  stage_id            uuid NOT NULL,
  amount              numeric(18,2) CHECK (amount >= 0),
  currency            char(3) NOT NULL DEFAULT 'USD' CHECK (currency = upper(currency)),
  close_date          date NOT NULL,
  probability         integer NOT NULL CHECK (probability BETWEEN 0 AND 100), -- filled from the stage when null
  type                text CHECK (type IN ('new business', 'renewal', 'expansion')),
  forecast_category   text CHECK (forecast_category IN ('pipeline', 'best case', 'commit', 'closed')),
  lead_source         text,
  next_step           text,
  is_closed           boolean NOT NULL DEFAULT false,
  is_won              boolean NOT NULL DEFAULT false,
  loss_reason         text,
  owner_user_id       uuid NOT NULL,
  description         text,
  custom              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid,
  updated_by          uuid,
  deleted_at          timestamptz,
  version             integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES account (tenant_id, id),
  FOREIGN KEY (tenant_id, primary_contact_id) REFERENCES contact (tenant_id, id),
  FOREIGN KEY (tenant_id, stage_id) REFERENCES pipeline_stage (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_user_id) REFERENCES app_user (tenant_id, id),
  CHECK (NOT is_won OR is_closed),
  CHECK (NOT (is_closed AND NOT is_won) OR loss_reason IS NOT NULL)
);
CREATE INDEX opportunity_account_idx ON opportunity (tenant_id, account_id) WHERE deleted_at IS NULL;
CREATE INDEX opportunity_stage_idx   ON opportunity (tenant_id, stage_id) WHERE deleted_at IS NULL;
CREATE INDEX opportunity_owner_idx   ON opportunity (tenant_id, owner_user_id) WHERE deleted_at IS NULL;
CREATE INDEX opportunity_close_idx   ON opportunity (tenant_id, close_date) WHERE deleted_at IS NULL AND NOT is_closed;

CREATE TABLE support_case (
  id                      uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id               uuid NOT NULL REFERENCES tenant (id),
  case_number             integer NOT NULL,
  account_id              uuid,
  contact_id              uuid,
  subject                 text NOT NULL CHECK (length(btrim(subject)) > 0),
  description             text,
  status                  text NOT NULL DEFAULT 'new'
                            CHECK (status IN ('new', 'open', 'pending customer', 'escalated', 'solved', 'closed')),
  priority                text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  type                    text CHECK (type IN ('question', 'problem', 'incident', 'request')),
  origin                  text CHECK (origin IN ('email', 'phone', 'web', 'chat', 'internal')),
  owner_user_id           uuid,
  queue_id                uuid,
  opened_at               timestamptz NOT NULL DEFAULT now(),
  first_response_at       timestamptz,
  resolved_at             timestamptz,
  closed_at               timestamptz,
  first_response_due_at   timestamptz,
  resolution_due_at       timestamptz,
  custom                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid,
  updated_by              uuid,
  deleted_at              timestamptz,
  version                 integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, case_number),
  FOREIGN KEY (tenant_id, account_id) REFERENCES account (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contact (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_user_id) REFERENCES app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, queue_id) REFERENCES queue (tenant_id, id),
  CHECK (num_nonnulls(owner_user_id, queue_id) = 1)
);
CREATE INDEX case_account_idx ON support_case (tenant_id, account_id) WHERE deleted_at IS NULL;
CREATE INDEX case_contact_idx ON support_case (tenant_id, contact_id) WHERE deleted_at IS NULL;
CREATE INDEX case_owner_idx   ON support_case (tenant_id, owner_user_id, status) WHERE deleted_at IS NULL;
CREATE INDEX case_queue_idx   ON support_case (tenant_id, queue_id, status) WHERE deleted_at IS NULL;
CREATE INDEX case_due_idx     ON support_case (tenant_id, resolution_due_at)
  WHERE deleted_at IS NULL AND status NOT IN ('solved', 'closed');

CREATE TABLE case_comment (
  id              uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id       uuid NOT NULL REFERENCES tenant (id),
  case_id         uuid NOT NULL,
  author_user_id  uuid,          -- null for inbound customer messages and system notes
  body            text NOT NULL CHECK (length(btrim(body)) > 0),
  is_public       boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_by      uuid,
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES support_case (tenant_id, id),
  FOREIGN KEY (tenant_id, author_user_id) REFERENCES app_user (tenant_id, id)
);
CREATE INDEX case_comment_case_idx ON case_comment (tenant_id, case_id, created_at);

CREATE TABLE activity (
  id              uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id       uuid NOT NULL REFERENCES tenant (id),
  type            text NOT NULL CHECK (type IN ('task', 'note', 'call', 'meeting', 'email')),
  subject         text NOT NULL CHECK (length(btrim(subject)) > 0),
  body            text,
  due_at          timestamptz,
  completed_at    timestamptz,
  owner_user_id   uuid NOT NULL,
  account_id      uuid,
  contact_id      uuid,
  opportunity_id  uuid,
  case_id         uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid,
  updated_by      uuid,
  deleted_at      timestamptz,
  version         integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_user_id) REFERENCES app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES account (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contact (tenant_id, id),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunity (tenant_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES support_case (tenant_id, id),
  CHECK (num_nonnulls(account_id, contact_id, opportunity_id, case_id) >= 1)
);
CREATE INDEX activity_owner_idx   ON activity (tenant_id, owner_user_id, due_at) WHERE deleted_at IS NULL AND completed_at IS NULL;
CREATE INDEX activity_account_idx ON activity (tenant_id, account_id) WHERE account_id IS NOT NULL;
CREATE INDEX activity_contact_idx ON activity (tenant_id, contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX activity_opp_idx     ON activity (tenant_id, opportunity_id) WHERE opportunity_id IS NOT NULL;
CREATE INDEX activity_case_idx    ON activity (tenant_id, case_id) WHERE case_id IS NOT NULL;

INSERT INTO schema_migrations (filename) VALUES ('0004_crm_core.sql');

-- ===== migrations/0005_platform.sql =====
-- 0005 platform: external_id, match_candidate, custom_field_def, health_snapshot,
-- ai_query_log, redaction_event

CREATE TABLE external_id (
  id              uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id       uuid NOT NULL REFERENCES tenant (id),
  entity_type     text NOT NULL CHECK (entity_type IN ('account', 'contact', 'opportunity', 'case')),
  entity_id       uuid NOT NULL,   -- polymorphic, checked by trigger because a plain FK cannot span tables
  source_system   text NOT NULL CHECK (source_system IN
                    ('salesforce', 'hubspot', 'zendesk', 'jira', 'certinia', 'pagerduty', 'confluence')),
  source_id       text NOT NULL CHECK (length(source_id) > 0),
  source_url      text,
  last_synced_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, source_system, entity_type, source_id)
);
CREATE INDEX external_id_entity_idx ON external_id (tenant_id, entity_type, entity_id);

CREATE TABLE match_candidate (
  id                    uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id             uuid NOT NULL REFERENCES tenant (id),
  entity_type           text NOT NULL CHECK (entity_type IN ('account', 'contact')),
  record_id             uuid NOT NULL,
  candidate_record_id   uuid NOT NULL,
  signal                text NOT NULL CHECK (signal IN ('sfdc_id', 'domain', 'email', 'fuzzy_name')),
  score                 numeric(5,4) NOT NULL CHECK (score BETWEEN 0 AND 1),
  status                text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'merged', 'rejected')),
  reviewed_by           uuid,
  reviewed_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, entity_type, record_id, candidate_record_id),
  FOREIGN KEY (tenant_id, reviewed_by) REFERENCES app_user (tenant_id, id),
  CHECK (record_id <> candidate_record_id),
  CHECK (status = 'pending' OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))
);
CREATE INDEX match_candidate_pending_idx ON match_candidate (tenant_id, created_at) WHERE status = 'pending';

CREATE TABLE custom_field_def (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id),
  object       text NOT NULL CHECK (object IN ('account', 'contact', 'opportunity', 'case', 'activity')),
  key          text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  label        text NOT NULL,
  data_type    text NOT NULL CHECK (data_type IN ('text', 'number', 'boolean', 'date', 'picklist', 'multi_picklist')),
  is_required  boolean NOT NULL DEFAULT false,
  options      jsonb,
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid,
  updated_by   uuid,
  deleted_at   timestamptz,
  version      integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, object, key),
  CHECK (data_type NOT IN ('picklist', 'multi_picklist') OR coalesce(jsonb_typeof(options) = 'array', false))
);

CREATE TABLE health_snapshot (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id),
  account_id   uuid NOT NULL,
  score        integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  band         text NOT NULL CHECK (band IN ('healthy', 'watch', 'at_risk')),
  inputs       jsonb NOT NULL DEFAULT '{}'::jsonb,
  computed_at  timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES account (tenant_id, id)
);
CREATE INDEX health_snapshot_account_idx ON health_snapshot (tenant_id, account_id, computed_at DESC);

CREATE TABLE ai_query_log (
  id               uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id        uuid NOT NULL REFERENCES tenant (id),
  user_id          uuid NOT NULL,
  prompt           text NOT NULL,      -- stored after redaction
  semantic_query   jsonb,
  row_count        integer,
  model            text,
  input_tokens     integer,
  output_tokens    integer,
  status           text NOT NULL CHECK (status IN ('ok', 'error', 'blocked_opt_out', 'blocked_permission')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES app_user (tenant_id, id)
);
CREATE INDEX ai_query_log_time_idx ON ai_query_log (tenant_id, created_at DESC);

CREATE TABLE redaction_event (
  id             uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id      uuid NOT NULL REFERENCES tenant (id),
  source_system  text NOT NULL,
  source_id      text,
  field          text NOT NULL,
  rule_matched   text NOT NULL,    -- the rule name, never the content that matched
  action         text NOT NULL CHECK (action IN ('masked', 'blocked')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX redaction_event_time_idx ON redaction_event (tenant_id, created_at DESC);

INSERT INTO schema_migrations (filename) VALUES ('0005_platform.sql');

-- ===== migrations/0006_triggers.sql =====
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

INSERT INTO schema_migrations (filename) VALUES ('0006_triggers.sql');

-- ===== migrations/0007_security.sql =====
-- 0007 security: row level security on every tenant table, and least privilege grants

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.table_name
      FROM information_schema.columns c
      JOIN information_schema.tables tb
        ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name
     WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND tb.table_type = 'BASE TABLE'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END $$;

-- The tenant table has no tenant_id. A session sees only its own tenant row.
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant
  USING (id = current_tenant_id()) WITH CHECK (id = current_tenant_id());

-- ---------------------------------------------------------------- grants

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO crm_app, crm_readonly;

-- App role. No DELETE on business records: they are soft deleted. Hard deletion runs
-- through the privacy workflow under a separate, audited role.
GRANT SELECT, INSERT, UPDATE ON
  app_user, role, pipeline_stage, queue, sla_policy, account, contact, opportunity,
  support_case, case_comment, activity, custom_field_def, match_candidate
TO crm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON external_id, field_permission TO crm_app;
GRANT SELECT, INSERT, DELETE ON user_role, role_permission TO crm_app;

-- Evidence tables: insert and read, never change.
GRANT SELECT, INSERT ON audit_log, ai_query_log, redaction_event, health_snapshot TO crm_app;

-- A tenant admin can change these settings, nothing else on the tenant row.
GRANT SELECT ON tenant TO crm_app;
GRANT UPDATE (name, default_currency, ai_enabled, settings, updated_at) ON tenant TO crm_app;

-- Read replica role for reports and AI queries. Row level security still applies.
GRANT SELECT ON
  tenant, app_user, role, user_role, role_permission, field_permission, pipeline_stage, queue,
  sla_policy, account, contact, opportunity, support_case, case_comment, activity,
  custom_field_def, external_id, match_candidate, health_snapshot, redaction_event
TO crm_readonly;

INSERT INTO schema_migrations (filename) VALUES ('0007_security.sql');

-- ===== migrations/0008_access_and_provisioning.sql =====
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

INSERT INTO schema_migrations (filename) VALUES ('0008_access_and_provisioning.sql');

-- ===== migrations/0009_email.sql =====
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

-- ===== migrations/0010_user_preference.sql =====
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

INSERT INTO schema_migrations (filename) VALUES ('0010_user_preference.sql');
COMMIT;

-- ===== migrations/0011_menu_preferences.sql =====
-- 0011 menu preferences: each person's left menu order and whether it is collapsed.
-- nav_order is a short list of menu item names (letters only). NULL means the standard order.

ALTER TABLE user_preference
  ADD COLUMN nav_order text[]
    CHECK (nav_order IS NULL OR (cardinality(nav_order) BETWEEN 1 AND 12 AND array_to_string(nav_order, ',') ~ '^[a-z]{1,20}(,[a-z]{1,20})*$')),
  ADD COLUMN nav_collapsed boolean NOT NULL DEFAULT false;

-- ===== migrations/0012_custom_fields.sql =====
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

-- ===== migrations/0013_saved_views.sql =====
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

-- 0014 inbound email: customer replies and new messages are kept next to the emails we send.

ALTER TABLE email_message ADD COLUMN direction text NOT NULL DEFAULT 'out' CHECK (direction IN ('out', 'in'));
ALTER TABLE email_message DROP CONSTRAINT email_message_status_check;
ALTER TABLE email_message ADD CONSTRAINT email_message_status_check CHECK (status IN ('queued', 'sent', 'failed', 'received'));
-- The email service may deliver the same message twice. This makes the second one a no-op.
CREATE UNIQUE INDEX email_message_inbound_uq ON email_message (tenant_id, provider_message_id)
  WHERE direction = 'in' AND provider_message_id IS NOT NULL;

-- 0015 comment channel: marks conversation entries that were an email (sent or received).

ALTER TABLE case_comment ADD COLUMN via_email boolean NOT NULL DEFAULT false;
