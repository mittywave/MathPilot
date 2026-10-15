-- Reuse the course directory tree for named topic folders, keeping every
-- existing handout's domain, contents and position unchanged.
DROP INDEX idx_handout_course_names;
CREATE UNIQUE INDEX idx_handout_course_names ON handout_course_nodes(COALESCE(parent_id, ''), name)
  WHERE id <> 'topic-library';
INSERT INTO handout_course_nodes (id, parent_id, name, position) VALUES
  ('topic-library', NULL, '专题库', 0),
  ('function', 'topic-library', '函数', 0),
  ('geometry', 'topic-library', '几何', 1),
  ('algebra', 'topic-library', '代数', 2),
  ('number', 'topic-library', '数论', 3),
  ('thinking', 'topic-library', '数学思想', 4);
