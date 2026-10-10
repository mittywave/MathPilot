-- Additive V2 schema. No legacy table/key mutation. Data copy is an atomic,
-- explicitly marked application migration after this schema is installed.
CREATE TABLE ai_providers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, base_url TEXT NOT NULL,
  wire_api TEXT NOT NULL, endpoint_config_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  api_key_encrypted TEXT NOT NULL DEFAULT '', cipher_version INTEGER NOT NULL DEFAULT 2,
  credential_revision INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
  timeout_ms INTEGER NOT NULL DEFAULT 180000, catalog_timeout_ms INTEGER NOT NULL DEFAULT 15000,
  output_strategy TEXT NOT NULL DEFAULT 'auto', reasoning_effort TEXT NOT NULL DEFAULT '',
  legacy INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE ai_provider_models (
  provider_id TEXT NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  model_id TEXT COLLATE BINARY NOT NULL, display_name TEXT NOT NULL,
  capabilities_json TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}',
  catalog_present INTEGER NOT NULL DEFAULT 0, manual INTEGER NOT NULL DEFAULT 0,
  legacy_compatible INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
  PRIMARY KEY(provider_id, model_id)
);
CREATE TABLE ai_routing_settings (
  id TEXT PRIMARY KEY CHECK(id='global'), configuration_revision INTEGER NOT NULL DEFAULT 0,
  default_text_provider TEXT, default_text_model TEXT, default_vision_provider TEXT, default_vision_model TEXT,
  allow_environment_fallback INTEGER NOT NULL DEFAULT 1,
  migration_state TEXT NOT NULL DEFAULT 'pending' CHECK(migration_state IN ('pending','complete')),
  FOREIGN KEY(default_text_provider,default_text_model) REFERENCES ai_provider_models(provider_id,model_id) ON DELETE RESTRICT,
  FOREIGN KEY(default_vision_provider,default_vision_model) REFERENCES ai_provider_models(provider_id,model_id) ON DELETE RESTRICT
);
INSERT INTO ai_routing_settings(id) VALUES ('global');
CREATE TABLE ai_task_routes (
  role TEXT PRIMARY KEY CHECK(role IN ('recognition','text','diagram','grading')),
  primary_provider TEXT, primary_model TEXT, fallback_provider TEXT, fallback_model TEXT,
  fallback_enabled INTEGER NOT NULL DEFAULT 0 CHECK(fallback_enabled IN (0,1)),
  FOREIGN KEY(primary_provider,primary_model) REFERENCES ai_provider_models(provider_id,model_id) ON DELETE RESTRICT,
  FOREIGN KEY(fallback_provider,fallback_model) REFERENCES ai_provider_models(provider_id,model_id) ON DELETE RESTRICT
);
-- A failed CHECK aborts the D1 batch; a zero-row UPDATE alone is not a lock.
CREATE TABLE ai_v2_write_guard (id TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid=1));
CREATE TABLE ai_provider_diagnostics (
  id TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  model_id TEXT, protocol TEXT NOT NULL, fingerprint TEXT NOT NULL,
  provider_revision INTEGER NOT NULL, credential_revision INTEGER NOT NULL,
  kind TEXT NOT NULL, role TEXT, endpoint TEXT NOT NULL, status INTEGER NOT NULL, code TEXT NOT NULL,
  latency_ms INTEGER NOT NULL, attempts INTEGER NOT NULL, upper_attempt INTEGER NOT NULL DEFAULT 1, fallback_used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX ai_diagnostics_recent ON ai_provider_diagnostics(provider_id,created_at);
CREATE TABLE ai_probe_rate_limits (user_id TEXT PRIMARY KEY, window_start INTEGER NOT NULL, requests INTEGER NOT NULL);
