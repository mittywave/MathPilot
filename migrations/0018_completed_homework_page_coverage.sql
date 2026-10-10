CREATE TABLE submission_page_extractions (
  submission_id TEXT NOT NULL REFERENCES homework_submissions(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL REFERENCES submission_pages(id) ON DELETE CASCADE,
  processed_asset_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('complete','failed')),
  result_json TEXT NOT NULL DEFAULT '{}',
  error TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(submission_id,page_id)
);
CREATE INDEX idx_submission_extraction_progress ON submission_page_extractions(submission_id,status);
ALTER TABLE assignment_questions ADD COLUMN reference_fingerprint TEXT NOT NULL DEFAULT '';
