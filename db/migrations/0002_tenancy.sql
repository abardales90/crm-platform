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
