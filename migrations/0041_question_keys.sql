-- 同一道题在作业、错题本和题库里只用一个 ID（question_key）：来自题库的题沿用题库 ID，其余的题第一次进错题本时
-- 按内容找已有的同一道题，找不到才用作业里这道题自己的 ID。错题本按它去重，并从题库的编号序列里领一个编号。
-- 旧数据由程序在第一次读取时按同样的规则补齐（判断同一道题要用到程序里的文字规范化）。
ALTER TABLE assignment_questions ADD COLUMN question_key TEXT NOT NULL DEFAULT '';
ALTER TABLE student_wrong_occurrences ADD COLUMN question_key TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_wrong_occurrences_student_key ON student_wrong_occurrences(owner_user_id, student_id, question_key, active);
CREATE INDEX idx_wrong_questions_owner_source ON student_wrong_questions(owner_user_id, source_question_id);
