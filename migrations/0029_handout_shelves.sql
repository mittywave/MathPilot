-- 讲义分三个书架：课程体系（grade + term）、专题库（domain：函数、几何、代数、数论、数学思想五个板块）、学生讲义（student_id）。
-- 学生讲义只有这位学生的老师能看到，删除学生时一起删除。旧的未归类讲义（都为空）列在专题库的“未分板块”，可移到对应板块或课次。
ALTER TABLE handouts ADD COLUMN student_id TEXT REFERENCES students(id) ON DELETE CASCADE;
ALTER TABLE handouts ADD COLUMN domain TEXT;

-- position 在同一分组（一个学期、一个专题板块或一位学生）内排序，取代只按学期排序的旧索引。
DROP INDEX IF EXISTS idx_handouts_owner_placement;
CREATE INDEX IF NOT EXISTS idx_handouts_group ON handouts(student_id, domain, grade, term, position);
