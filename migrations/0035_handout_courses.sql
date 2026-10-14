-- Empty outlines need their own names and order before any handout exists.
-- One tree stores systems, stages and units; handouts remain the lessons.
CREATE TABLE handout_course_nodes (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES handout_course_nodes(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80),
  position INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX idx_handout_course_names ON handout_course_nodes(COALESCE(parent_id, ''), name);
CREATE INDEX idx_handout_course_parent ON handout_course_nodes(parent_id, position);

INSERT INTO handout_course_nodes (id, parent_id, name, position) VALUES
  ('course-default', NULL, '深圳创新体系', 0),
  ('course-grade-7', 'course-default', '初一', 0),
  ('course-grade-8', 'course-default', '初二', 1),
  ('course-grade-9', 'course-default', '初三', 2);
INSERT INTO handout_course_nodes (id, parent_id, name, position)
SELECT 'course-' || grade || '-' || term, 'course-grade-' || grade, name, position
FROM (SELECT 7 AS grade UNION ALL SELECT 8 UNION ALL SELECT 9)
CROSS JOIN (SELECT 'summer' AS term, '暑假' AS name, 0 AS position
  UNION ALL SELECT 'autumn', '秋季', 1
  UNION ALL SELECT 'winter', '寒假', 2
  UNION ALL SELECT 'spring', '春季', 3);

ALTER TABLE handouts ADD COLUMN course_unit_id TEXT REFERENCES handout_course_nodes(id) ON DELETE RESTRICT;
UPDATE handouts SET course_unit_id = 'course-' || grade || '-' || term
WHERE student_id IS NULL AND domain IS NULL AND grade IN (7, 8, 9)
  AND term IN ('summer', 'autumn', 'winter', 'spring');
DROP INDEX idx_handouts_group;
ALTER TABLE handouts DROP COLUMN grade;
ALTER TABLE handouts DROP COLUMN term;
CREATE INDEX idx_handouts_group ON handouts(student_id, domain, course_unit_id, position);
