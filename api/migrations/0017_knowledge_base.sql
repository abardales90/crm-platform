-- 0017 knowledge base: articles that reps write, a reviewer approves, and the company publishes to its customers.
--
-- kb_article is the working copy. Each time one is approved a frozen copy goes into kb_article_version, and
-- published_version_id points at it. Customers only ever see that frozen copy, so editing a live article never
-- changes the public page until the new edit is approved.

CREATE TABLE kb_site (
  tenant_id   uuid PRIMARY KEY REFERENCES tenant (id),
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  enabled     boolean NOT NULL DEFAULT false,
  title       text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 80),
  tagline     text CHECK (length(tagline) <= 160),
  accent      text CHECK (accent ~ '^#[0-9a-fA-F]{6}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- The public help center must find a company by its address before anyone is signed in. So a site that has been
-- switched on can be read by anyone (it holds only the public name and look). Everything else stays tenant only.
ALTER TABLE kb_site ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_site FORCE ROW LEVEL SECURITY;
CREATE POLICY kb_site_read ON kb_site FOR SELECT
  USING (enabled OR tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY kb_site_insert ON kb_site FOR INSERT
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY kb_site_update ON kb_site FOR UPDATE
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON kb_site TO crm_app;
GRANT SELECT ON kb_site TO crm_readonly;
CREATE TRIGGER kb_site_touch BEFORE UPDATE ON kb_site FOR EACH ROW EXECUTE FUNCTION trg_touch_updated_at();
CREATE TRIGGER kb_site_tenant_immutable BEFORE UPDATE ON kb_site FOR EACH ROW EXECUTE FUNCTION trg_prevent_tenant_change();

CREATE TABLE kb_category (
  id          uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id   uuid NOT NULL REFERENCES tenant (id),
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  slug        text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  description text CHECK (length(description) <= 300),
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid,
  updated_by  uuid,
  deleted_at  timestamptz,
  version     integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX kb_category_slug_uq ON kb_category (tenant_id, slug) WHERE deleted_at IS NULL;

CREATE TABLE kb_article (
  id                   uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id            uuid NOT NULL REFERENCES tenant (id),
  type                 text NOT NULL CHECK (type IN ('how_to', 'troubleshooting', 'faq')),
  title                text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  slug                 text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,80}$'),
  summary              text CHECK (length(summary) <= 400),
  body                 text NOT NULL DEFAULT '' CHECK (length(body) <= 60000),
  audience             text NOT NULL DEFAULT 'public' CHECK (audience IN ('public', 'internal')),
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'in_review', 'published', 'archived')),
  category_id          uuid,
  tags                 text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 15),
  product_area         text CHECK (length(product_area) <= 60),
  owner_user_id        uuid,
  reviewer_user_id     uuid,
  review_note          text CHECK (length(review_note) <= 1000),
  submitted_at         timestamptz,
  published_version_id uuid,
  published_at         timestamptz,
  ai_drafted           boolean NOT NULL DEFAULT false,
  source_case_id       uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid,
  updated_by           uuid,
  deleted_at           timestamptz,
  version              integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, category_id) REFERENCES kb_category (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_user_id) REFERENCES app_user (tenant_id, id),
  FOREIGN KEY (tenant_id, reviewer_user_id) REFERENCES app_user (tenant_id, id)
);
CREATE UNIQUE INDEX kb_article_slug_uq ON kb_article (tenant_id, slug) WHERE deleted_at IS NULL;
CREATE INDEX kb_article_status_idx ON kb_article (tenant_id, status) WHERE deleted_at IS NULL;

-- array_to_string is only marked stable, which a stored search column is not allowed to use. This wrapper is safe: it just joins words.
CREATE FUNCTION kb_tags_text(t text[]) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT array_to_string(t, ' ') $$;

CREATE TABLE kb_article_version (
  id           uuid PRIMARY KEY DEFAULT uuid_v7(),
  tenant_id    uuid NOT NULL REFERENCES tenant (id),
  article_id   uuid NOT NULL,
  version_no   integer NOT NULL,
  type         text NOT NULL,
  title        text NOT NULL,
  summary      text,
  body         text NOT NULL,
  audience     text NOT NULL CHECK (audience IN ('public', 'internal')),
  category_id  uuid,
  tags         text[] NOT NULL DEFAULT '{}',
  change_note  text CHECK (length(change_note) <= 500),
  published_by uuid DEFAULT current_user_id(),
  published_at timestamptz NOT NULL DEFAULT now(),
  -- keyword search over what customers can actually see
  search       tsvector GENERATED ALWAYS AS (
                 setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
                 setweight(to_tsvector('english', coalesce(summary, '')), 'B') ||
                 setweight(to_tsvector('english', coalesce(kb_tags_text(tags), '')), 'B') ||
                 setweight(to_tsvector('english', coalesce(body, '')), 'C')) STORED,
  UNIQUE (tenant_id, id),
  UNIQUE (article_id, version_no),
  FOREIGN KEY (tenant_id, article_id) REFERENCES kb_article (tenant_id, id)
);
CREATE INDEX kb_article_version_search_idx ON kb_article_version USING gin (search);

ALTER TABLE kb_article ADD CONSTRAINT kb_article_published_fk
  FOREIGN KEY (tenant_id, published_version_id) REFERENCES kb_article_version (tenant_id, id);

-- Reads and helpful votes. Kept apart so counting a page view never changes the article itself.
CREATE TABLE kb_stat (
  tenant_id    uuid NOT NULL REFERENCES tenant (id),
  article_id   uuid NOT NULL,
  views        bigint NOT NULL DEFAULT 0,
  helpful_yes  integer NOT NULL DEFAULT 0,
  helpful_no   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, article_id),
  FOREIGN KEY (tenant_id, article_id) REFERENCES kb_article (tenant_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['kb_category', 'kb_article', 'kb_article_version', 'kb_stat'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT SELECT ON %I TO crm_readonly', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION trg_prevent_tenant_change()', t || '_tenant_immutable', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['kb_category', 'kb_article'] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO crm_app', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION trg_set_standard_columns()', t || '_std', t);
  END LOOP;
END $$;
-- Versions are frozen once written. Stats only count up.
GRANT SELECT, INSERT ON kb_article_version TO crm_app;
GRANT SELECT, INSERT, UPDATE ON kb_stat TO crm_app;
