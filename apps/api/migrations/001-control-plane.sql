CREATE TABLE organizations (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120)
);
CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL
);
CREATE TABLE environments (
  organization_id uuid NOT NULL REFERENCES organizations(id),
  key text NOT NULL CHECK (key IN ('development', 'production')),
  PRIMARY KEY (organization_id, key)
);
CREATE TABLE memberships (
  user_id uuid NOT NULL REFERENCES users(id),
  organization_id uuid NOT NULL,
  environment_key text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  PRIMARY KEY (user_id, organization_id, environment_key),
  FOREIGN KEY (organization_id, environment_key) REFERENCES environments(organization_id, key)
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE flags (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  environment_key text NOT NULL,
  key text NOT NULL CHECK (key ~ '^[A-Za-z][A-Za-z0-9._-]{0,127}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 1000),
  salt text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  next_version integer NOT NULL DEFAULT 1 CHECK (next_version > 0),
  active_version integer,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, environment_key, key),
  FOREIGN KEY (organization_id, environment_key) REFERENCES environments(organization_id, key)
);
CREATE TABLE flag_drafts (
  flag_id uuid PRIMARY KEY REFERENCES flags(id),
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object')
);
CREATE TABLE flag_versions (
  flag_id uuid NOT NULL REFERENCES flags(id),
  version integer NOT NULL CHECK (version > 0),
  config jsonb NOT NULL CHECK (
    jsonb_typeof(config) = 'object'
    AND config ?& ARRAY['key','environmentKey','salt','version','killSwitch','defaultValue','exactRules']
    AND (config->>'version')::integer = version
    AND jsonb_typeof(config->'killSwitch') = 'boolean'
    AND jsonb_typeof(config->'defaultValue') = 'boolean'
    AND jsonb_typeof(config->'exactRules') = 'array'
  ),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (flag_id, version)
);
ALTER TABLE flags ADD CONSTRAINT active_version_owner
  FOREIGN KEY (id, active_version) REFERENCES flag_versions(flag_id, version)
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid REFERENCES organizations(id),
  environment_key text,
  flag_id uuid REFERENCES flags(id),
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('allowed', 'denied', 'conflict')),
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_scope ON audit_events(organization_id, environment_key, id DESC);

CREATE FUNCTION reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Historical records are append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER versions_immutable BEFORE UPDATE OR DELETE ON flag_versions
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();

CREATE FUNCTION protect_flag_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.environment_key IS DISTINCT FROM OLD.environment_key
     OR NEW.key IS DISTINCT FROM OLD.key OR NEW.salt IS DISTINCT FROM OLD.salt THEN
    RAISE EXCEPTION 'Flag identity and salt are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER stable_flag_identity BEFORE UPDATE ON flags
  FOR EACH ROW EXECUTE FUNCTION protect_flag_identity();

CREATE FUNCTION validate_version_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f flags;
BEGIN
  SELECT * INTO STRICT f FROM flags WHERE id = NEW.flag_id;
  IF NEW.config->>'key' IS DISTINCT FROM f.key
     OR NEW.config->>'environmentKey' IS DISTINCT FROM f.environment_key
     OR NEW.config->>'salt' IS DISTINCT FROM f.salt THEN
    RAISE EXCEPTION 'Snapshot identity does not match flag' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER version_identity BEFORE INSERT ON flag_versions
  FOR EACH ROW EXECUTE FUNCTION validate_version_identity();
