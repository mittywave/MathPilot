-- A run token distinguishes the active grader from duplicate deliveries and stale workers.
-- Reuse updated_at for its heartbeat; no parallel task table or second status machine.
ALTER TABLE homework_submissions ADD COLUMN grading_run_id TEXT NOT NULL DEFAULT '';
