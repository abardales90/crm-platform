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
