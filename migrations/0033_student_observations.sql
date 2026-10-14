-- 定档 · 能力（主观）：老师课后说的一段话（打字或语音听写）和 AI 从中读出的能力判断。
-- abilities_json：[{key, polarity: strength|weakness, evidence: 老师原话}]，key 是固定的五项能力（粗心、计算能力、思维能力·逆向/分析/转化）；
-- keywords_json：原话里其他要点；extracted_at 为空表示还没读成功（AI 未配置或失败），原话照样保存。
CREATE TABLE IF NOT EXISTS student_observations (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  observed_at INTEGER NOT NULL,
  text TEXT NOT NULL,
  abilities_json TEXT NOT NULL DEFAULT '[]',
  keywords_json TEXT NOT NULL DEFAULT '[]',
  extracted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_student_observations_student ON student_observations(owner_user_id, student_id, observed_at DESC);
