-- Papers contain ordered references to the shared question library, never question snapshots.
CREATE TABLE paper_folders (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES paper_folders(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
  position INTEGER NOT NULL DEFAULT 0,
  CHECK(parent_id IS NULL OR parent_id <> id)
);
CREATE UNIQUE INDEX idx_paper_folder_name ON paper_folders(COALESCE(parent_id, ''), name COLLATE NOCASE);
INSERT INTO paper_folders(id,parent_id,name,position) VALUES
('paper-school',NULL,'期中期末与统考',0),('paper-mock',NULL,'中考模拟',1),('paper-admission',NULL,'自主招生',2),
('paper-g7a','paper-school','七年级上',0),('paper-g7b','paper-school','七年级下',1),
('paper-g8a','paper-school','八年级上',2),('paper-g8b','paper-school','八年级下',3),
('paper-g9a','paper-school','九年级上',4),('paper-g9b','paper-school','九年级下',5),
('paper-mock1','paper-mock','一模',0),('paper-mock2','paper-mock','二模',1),('paper-mock3','paper-mock','三模',2);

CREATE TABLE exam_papers (
  id TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL REFERENCES paper_folders(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  items_json TEXT NOT NULL DEFAULT '[]',
  file_name TEXT NOT NULL,
  source_key TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_hash TEXT NOT NULL UNIQUE,
  job_id TEXT UNIQUE REFERENCES studio_jobs(id) ON DELETE SET NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_exam_papers_folder ON exam_papers(folder_id, created_at DESC, id);
