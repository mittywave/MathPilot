-- Stable lookup numbers survive publication versions and permanent question deletion.
-- Existing UUID references remain unchanged. Allocation is atomic in SQLite/D1.
CREATE TABLE question_codes (
  number INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id TEXT NOT NULL UNIQUE
);
INSERT INTO question_codes (question_id)
SELECT source_id FROM library_questions_v2 GROUP BY source_id ORDER BY MIN(created_at), source_id;
CREATE TRIGGER assign_question_code AFTER INSERT ON library_questions_v2
WHEN NOT EXISTS (SELECT 1 FROM question_codes WHERE question_id = NEW.source_id)
BEGIN
  INSERT INTO question_codes (question_id) VALUES (NEW.source_id);
END;
