-- Handwritten transcription runs on the server so the teacher can leave the page.
-- Page images and the draft JSON live in R2 under studio/<id>/; this row is the status.
CREATE TABLE studio_jobs (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
  input_mode TEXT NOT NULL CHECK(input_mode IN ('paired', 'answers')),
  status TEXT NOT NULL CHECK(status IN ('uploading', 'queued', 'running', 'done', 'failed')),
  -- Set by the worker that claimed the run; its updates only apply while it still owns the job.
  run_id TEXT NOT NULL DEFAULT '',
  text_concurrency INTEGER NOT NULL DEFAULT 4,
  page_count INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0,
  question_count INTEGER NOT NULL DEFAULT 0,
  progress TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_studio_jobs_owner ON studio_jobs(owner_user_id, created_at DESC);
