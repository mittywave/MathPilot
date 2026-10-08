-- 共享办公：管理员在页面里管理邀请码和同事账号。
-- 停用的账号不能登录，原有会话立即失效；账号本身保留，因为题库、讲义和学生记录都引用它。
ALTER TABLE users ADD COLUMN disabled_at INTEGER;
ALTER TABLE users ADD COLUMN last_login_at INTEGER;

-- 页面里设置的值优先于环境变量：invite_code 行存在时以它为准（空字符串 = 关闭注册），
-- 没有这一行时沿用 REGISTRATION_INVITE_CODE。
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
