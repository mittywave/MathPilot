-- The uploaded pages now decide the transcription mode when a job starts
-- (originals only, answers only, or both); it lives in the R2 draft, not here.
ALTER TABLE studio_jobs DROP COLUMN input_mode;
