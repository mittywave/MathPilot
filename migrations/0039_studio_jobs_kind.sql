-- 题库 file imports run as background jobs too. They share the transcription jobs' queue, run slices,
-- run fencing, stall detection, cancel and delete; the kind tells the two apart.
ALTER TABLE studio_jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'transcription' CHECK(kind IN ('transcription', 'import'));
DROP INDEX idx_studio_jobs_owner;
CREATE INDEX idx_studio_jobs_owner_kind ON studio_jobs(owner_user_id, kind, created_at DESC);
