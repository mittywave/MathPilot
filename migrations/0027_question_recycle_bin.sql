-- 删除的试题先进回收站（deleted_at 为删除时间），管理员可在“分类与数据管理”中恢复；删除模块仍会彻底删除其中的试题。
ALTER TABLE library_questions_v2 ADD COLUMN deleted_at INTEGER;
