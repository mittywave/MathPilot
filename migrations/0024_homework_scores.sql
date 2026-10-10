-- 原卷印刷了分值的题目按步骤给分；满分随题目识别结果保存在 input_evidence_json.max_score。
-- 没有印刷分值、待补图或待核实的题目得分为 NULL，不当作 0 分。
ALTER TABLE grading_items ADD COLUMN score REAL;
