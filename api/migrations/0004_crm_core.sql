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
