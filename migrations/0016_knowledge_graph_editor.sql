-- Editable knowledge graph. Version 1 is the bundled seed JSON; later versions
-- are immutable snapshots. One shared draft per graph is edited on localhost and
-- mirrored to production together with the public library.
CREATE TABLE IF NOT EXISTS knowledge_graphs (
  id TEXT PRIMARY KEY,
  published_version INTEGER NOT NULL DEFAULT 1 CHECK (published_version >= 1),
  draft_json TEXT,
  draft_base_version INTEGER,
  draft_revision INTEGER NOT NULL DEFAULT 0,
  draft_updated_at INTEGER,
  draft_updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_graph_versions (
  graph_id TEXT NOT NULL REFERENCES knowledge_graphs(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  framework_version TEXT NOT NULL,
  document_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  summary_json TEXT NOT NULL DEFAULT '{}',
  source_version INTEGER,
  published_by TEXT,
  published_at INTEGER NOT NULL,
  PRIMARY KEY (graph_id, version)
);

INSERT OR IGNORE INTO knowledge_graphs (id, published_version, draft_revision, created_at, updated_at)
VALUES ('cn-math-junior', 1, 0, 0, 0);
