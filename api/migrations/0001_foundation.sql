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
