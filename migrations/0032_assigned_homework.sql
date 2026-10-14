-- 布置作业：快速排版的资料可以布置给学生。布置时题目和答案就存进作业，学生交上来后按这份清单批改。
-- sheet_json 不为空的作业是布置的作业，记着资料怎么分组（智能组卷按天，[] 表示不分组）；
-- source_json 是这道题布置时的原样（题库原题或 Word 里读出的题），错题本和作业页按它显示题目。
ALTER TABLE homework_assignments ADD COLUMN sheet_json TEXT NOT NULL DEFAULT '';
ALTER TABLE assignment_questions ADD COLUMN source_json TEXT NOT NULL DEFAULT '';
