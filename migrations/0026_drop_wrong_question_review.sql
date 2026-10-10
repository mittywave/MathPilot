-- 错题本不再记录复习备注和掌握状态（移除“编辑记录”“标为掌握”）；错题按记录月份归类。
DROP INDEX IF EXISTS idx_student_wrong_questions_owner_student;
ALTER TABLE student_wrong_questions DROP COLUMN note;
ALTER TABLE student_wrong_questions DROP COLUMN mastered;
CREATE INDEX idx_student_wrong_questions_owner_student ON student_wrong_questions(owner_user_id, student_id, last_wrong_at DESC);
