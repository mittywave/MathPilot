-- 快速排版的历史记录也可以是一份“题库题目清单”：智能组卷按天挑好的题，用题库原题排版，不挂 Word。
-- SQLite 不能直接去掉 NOT NULL，所以按原样重建这张表：Word 记录 source_kind 为 word 并照旧挂着原始 Word；
-- 题目清单 source_kind 为 library、source_asset_id 为空，plan_json 记着老师的需求、agent 的理解、学生档案要点
-- 和按天分好的题；student_id 是为谁出的题，再给这位学生出题时据此避开用过的题。
CREATE TABLE typeset_records_next (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  file_name TEXT NOT NULL,
  question_count INTEGER NOT NULL DEFAULT 0,
  source_kind TEXT NOT NULL DEFAULT 'word' CHECK (source_kind IN ('word', 'library')),
  source_asset_id TEXT REFERENCES question_assets(id),
  plan_json TEXT NOT NULL DEFAULT '{}',
  student_id TEXT REFERENCES students(id) ON DELETE SET NULL,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((source_kind = 'word') = (source_asset_id IS NOT NULL))
);

INSERT INTO typeset_records_next (id, owner_user_id, title, file_name, question_count, source_kind, source_asset_id, settings_json, created_at, updated_at)
  SELECT id, owner_user_id, title, file_name, question_count, 'word', source_asset_id, settings_json, created_at, updated_at FROM typeset_records;

DROP TABLE typeset_records;
ALTER TABLE typeset_records_next RENAME TO typeset_records;

CREATE INDEX IF NOT EXISTS idx_typeset_records_owner_updated ON typeset_records(owner_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_typeset_records_owner_student ON typeset_records(owner_user_id, student_id);
