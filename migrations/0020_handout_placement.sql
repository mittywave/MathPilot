-- 讲义按 年级 → 学期 → 课次 编排。grade 为 7/8/9（初一至初三），term 为
-- summer/autumn/winter/spring；课次号由同一学期内 position 的先后得出。
-- 两者都为空的讲义是“未归类”，旧讲义迁移后都在这里。
ALTER TABLE handouts ADD COLUMN grade INTEGER;
ALTER TABLE handouts ADD COLUMN term TEXT;
ALTER TABLE handouts ADD COLUMN position INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_handouts_owner_placement ON handouts(owner_user_id, grade, term, position);
