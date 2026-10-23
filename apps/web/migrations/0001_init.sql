-- Devin AI for VLSI: initial schema. Applied by src/lib/store/db.ts in filename order.

CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id),
  name        TEXT NOT NULL,
  description TEXT NOT NULL,
  state       TEXT NOT NULL,
  data        JSONB NOT NULL,
  ai_policy   JSONB NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX projects_owner ON projects(owner_id);

-- Immutable revisions: rows are inserted, never updated (except approval stamps on spec/architecture).
CREATE TABLE spec_revisions (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  revision   INTEGER NOT NULL,
  spec       JSONB NOT NULL,
  spec_hash  TEXT NOT NULL,
  yaml       TEXT NOT NULL,
  approval   JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, revision)
);

CREATE TABLE architecture_revisions (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id),
  revision      INTEGER NOT NULL,
  spec_revision INTEGER NOT NULL,
  content       JSONB NOT NULL,
  content_hash  TEXT NOT NULL,
  approval      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, revision)
);

CREATE TABLE source_revisions (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  revision        INTEGER NOT NULL,
  parent_revision INTEGER,
  spec_revision   INTEGER NOT NULL,
  origin          TEXT NOT NULL,
  files           JSONB NOT NULL,
  file_hashes     JSONB NOT NULL,
  manifest_hash   TEXT NOT NULL,
  provenance      JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, revision)
);

CREATE TABLE runs (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  source_revision INTEGER NOT NULL,
  stage           TEXT NOT NULL,
  status          TEXT NOT NULL,
  input_hash      TEXT NOT NULL,
  execution_mode  TEXT NOT NULL,
  result          JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX runs_project ON runs(project_id, source_revision);

CREATE TABLE release_candidates (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  source_revision INTEGER NOT NULL,
  policy          TEXT NOT NULL,
  checklist       JSONB NOT NULL,
  manifest        JSONB,
  manifest_hash   TEXT,
  status          TEXT NOT NULL,
  approval        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
  id         TEXT PRIMARY KEY,
  project_id TEXT,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  detail     JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_project ON audit_events(project_id, created_at);

-- AI provider registry. Credentials are never stored: api_key_env names an environment variable.
CREATE TABLE ai_providers (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT REFERENCES users(id),
  display_name     TEXT NOT NULL,
  adapter          TEXT NOT NULL,
  endpoint         TEXT,
  connection_class TEXT NOT NULL,
  topology         TEXT NOT NULL,
  api_key_env      TEXT,
  enabled          BOOLEAN NOT NULL DEFAULT true,
  last_probe       JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ai_model_profiles (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT REFERENCES users(id),
  provider_id   TEXT NOT NULL REFERENCES ai_providers(id),
  model_id      TEXT NOT NULL,
  capabilities  JSONB NOT NULL,
  conformance   JSONB,
  allowed_roles JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ai_executions (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT,
  role                TEXT NOT NULL,
  prompt_id           TEXT NOT NULL,
  provider_id         TEXT,
  model_profile_id    TEXT,
  model_id            TEXT,
  adapter             TEXT,
  adapter_version     TEXT,
  capability_snapshot JSONB,
  input_hash          TEXT NOT NULL,
  output_hash         TEXT,
  output              JSONB,
  route               JSONB NOT NULL,
  status              TEXT NOT NULL,
  latency_ms          INTEGER,
  usage               JSONB,
  warnings            JSONB NOT NULL,
  error               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ai_exec_project ON ai_executions(project_id, created_at);
