-- 作业按课程体系批改：school 为校内数学（原有流程），international 为 IGCSE / A Level（按小问与 mark scheme 给分）。
ALTER TABLE homework_assignments ADD COLUMN curriculum TEXT NOT NULL DEFAULT 'school' CHECK(curriculum IN ('school','international'));
-- 国际课程的家长报告：逐题考查内容、失分分析与练习计划，结构见 lib/homework-report.mjs。
ALTER TABLE submission_reports ADD COLUMN details_json TEXT NOT NULL DEFAULT '{}';
