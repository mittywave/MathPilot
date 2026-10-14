-- 学情报告：给家长看的一段时间的学习情况。data_json 是生成时从学生档案取的数据快照（作业、知识点、题型、课后反馈），
-- 报告发出去以后档案再变也不影响它；text_json 是 AI 据此写的文字（总体情况、知识掌握、能力表现、下一步安排、给家长的话），老师可以改。
CREATE TABLE IF NOT EXISTS student_reports (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  text_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_student_reports_student ON student_reports(owner_user_id, student_id, period_end DESC);
