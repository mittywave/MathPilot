-- 讲义编撰: a handout is an ordered list of sections and references to library
-- questions. Questions themselves stay in the libraries, so edits there show up
-- in every handout that uses them.
CREATE TABLE IF NOT EXISTS handouts (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  items_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_handouts_owner_updated ON handouts(owner_user_id, updated_at DESC);
