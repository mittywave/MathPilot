-- 作业批改是独立工具：每份作业上传时选择批改结果要写入哪些学生模块。
-- 已有作业保持原来的行为：写入错题本并生成错题报告，不写入学生画像。
ALTER TABLE homework_assignments ADD COLUMN outputs_json TEXT NOT NULL DEFAULT '{"wrongBook":true,"report":true,"profile":false}';
