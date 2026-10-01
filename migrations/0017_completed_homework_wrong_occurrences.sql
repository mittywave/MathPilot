ALTER TABLE homework_assignments ADD COLUMN input_mode TEXT NOT NULL DEFAULT 'template' CHECK(input_mode IN ('template','completed_homework'));
ALTER TABLE assignment_questions ADD COLUMN reference_source TEXT NOT NULL DEFAULT 'provided' CHECK(reference_source IN ('provided','agent','unresolved'));
ALTER TABLE assignment_questions ADD COLUMN reference_verified INTEGER NOT NULL DEFAULT 1 CHECK(reference_verified IN (0,1));
ALTER TABLE assignment_questions ADD COLUMN reference_evidence TEXT NOT NULL DEFAULT '';
ALTER TABLE assignment_questions ADD COLUMN input_evidence_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE student_wrong_questions ADD COLUMN archived_at INTEGER;
ALTER TABLE student_wrong_questions ADD COLUMN archive_reason TEXT NOT NULL DEFAULT '';
CREATE TABLE student_wrong_occurrences (
  grading_item_id TEXT PRIMARY KEY REFERENCES grading_items(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  assignment_id TEXT NOT NULL,
  assignment_question_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_wrong_occurrences_student_question ON student_wrong_occurrences(owner_user_id, student_id, assignment_question_id, active);
INSERT INTO student_wrong_occurrences(grading_item_id,owner_user_id,student_id,assignment_id,assignment_question_id,submission_id,active,created_at,updated_at)
 SELECT g.id,a.owner_user_id,s.student_id,a.id,g.assignment_question_id,s.id,1,g.created_at,g.updated_at
 FROM grading_items g JOIN homework_submissions s ON s.id=g.submission_id JOIN homework_assignments a ON a.id=s.assignment_id
 WHERE s.status='published' AND g.verdict='incorrect' AND g.requires_review=0;
UPDATE student_wrong_questions SET archived_at=updated_at, archive_reason='历史手动记录' WHERE source_kind='library';
UPDATE student_wrong_questions SET archived_at=updated_at, archive_reason='不符合完全错误归档规则'
 WHERE source_kind='assignment' AND NOT EXISTS(SELECT 1 FROM student_wrong_occurrences o WHERE o.student_id=student_wrong_questions.student_id AND o.owner_user_id=student_wrong_questions.owner_user_id AND o.assignment_question_id=student_wrong_questions.source_question_id AND o.active=1);
UPDATE student_wrong_questions SET mistake_count=(SELECT COUNT(*) FROM student_wrong_occurrences o WHERE o.student_id=student_wrong_questions.student_id AND o.owner_user_id=student_wrong_questions.owner_user_id AND o.assignment_question_id=student_wrong_questions.source_question_id AND o.active=1)
 WHERE source_kind='assignment' AND archived_at IS NULL;
ALTER TABLE homework_submissions ADD COLUMN reprocess_question_ids_json TEXT NOT NULL DEFAULT '[]';
CREATE TABLE submission_page_revisions (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES homework_submissions(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  original_asset_id TEXT NOT NULL,
  processed_asset_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
