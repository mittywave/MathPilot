-- 快速排版的历史记录：每份排过的 Word 练习一行，只属于排它的老师。
-- 原始 Word 存在共用的分块素材表里（不进任何题库的权限表），重新打开时按原样再读一遍；
-- settings_json 记着当时的版本、间距、横线行距和单题调整。
CREATE TABLE IF NOT EXISTS typeset_records (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  file_name TEXT NOT NULL,
  question_count INTEGER NOT NULL DEFAULT 0,
  source_asset_id TEXT NOT NULL REFERENCES question_assets(id),
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_typeset_records_owner_updated ON typeset_records(owner_user_id, updated_at DESC);
