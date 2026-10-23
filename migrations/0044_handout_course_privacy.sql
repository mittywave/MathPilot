-- Privacy belongs to the system; descendants inherit it when read or changed.
ALTER TABLE handout_course_nodes ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0
  CHECK(is_private IN (0, 1) AND (is_private = 0 OR (parent_id IS NULL AND id <> 'topic-library')));
