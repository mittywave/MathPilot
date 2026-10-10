// 共享办公 · 成员：管理员管理同事账号和邀请码。账号只停用不删除，
// 因为讲义、学生和作业记录都引用它（users 上的级联删除会连带删掉这些数据）。
import type { AuthUser, TeamInvite, TeamMember } from "../types";
import { authBindings, hashPassword, INVITE_SETTING, inviteFromConfig, requireUser } from "./auth";

const LOCAL_ADMIN_ID = "local-admin";
// 去掉容易看错的 0/O、1/l/I，方便口头或抄写转告。
const PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

type MemberRow = { id: string; email: string; role: "admin" | "member"; created_at: number; disabled_at: number | null; last_login_at: number | null };

function responseError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { "Content-Type": "application/json" } });
}

function db() { return authBindings().DB; }

// Uniform characters by rejection sampling, so no character is favoured.
function randomText(alphabet: string, length: number) {
  const limit = 256 - (256 % alphabet.length);
  let text = "";
  while (text.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < limit && text.length < length) text += alphabet[byte % alphabet.length];
    }
  }
  return text;
}

function toMember(row: MemberRow): TeamMember {
  return { id: row.id, email: row.email, role: row.role, createdAt: row.created_at, disabledAt: row.disabled_at, lastLoginAt: row.last_login_at };
}

export async function requireAdminUser(request: Request) {
  const user = await requireUser(request);
  if (user.role !== "admin") throw responseError("只有管理员可以管理共享办公", 403);
  return user;
}

export async function listMembers(): Promise<TeamMember[]> {
  const rows = await db().prepare(`SELECT id, email, role, created_at, disabled_at, last_login_at FROM users
    WHERE id <> ? ORDER BY created_at`).bind(LOCAL_ADMIN_ID).all<MemberRow>();
  return rows.results.map(toMember);
}

async function memberRow(id: string) {
  if (id === LOCAL_ADMIN_ID) throw responseError("这位成员不存在", 404);
  const row = await db().prepare("SELECT id, email, role, created_at, disabled_at, last_login_at FROM users WHERE id = ?").bind(id).first<MemberRow>();
  if (!row) throw responseError("这位成员不存在", 404);
  return row;
}

// Changing your own role or account could lock you out, and the last working admin must stay.
export async function updateMember(actor: AuthUser, id: string, raw: unknown): Promise<TeamMember> {
  const changes = raw && typeof raw === "object" ? raw as { role?: unknown; disabled?: unknown } : {};
  if (id === actor.id) throw responseError("不能修改自己的角色或停用自己", 403);
  const target = await memberRow(id);
  const role = changes.role === "admin" || changes.role === "member" ? changes.role : target.role;
  const disabled = typeof changes.disabled === "boolean" ? changes.disabled : target.disabled_at != null;
  const stillAdmin = role === "admin" && !disabled;
  const disabledAt = disabled ? target.disabled_at ?? Date.now() : null;
  // One statement checks and writes, so two admins demoting each other at once cannot both win.
  const [update] = await db().batch([
    db().prepare(`UPDATE users SET role = ?, disabled_at = ? WHERE id = ?
      AND (? OR EXISTS (SELECT 1 FROM users AS other WHERE other.role = 'admin' AND other.disabled_at IS NULL AND other.id <> ?))`)
      .bind(role, disabledAt, id, stillAdmin ? 1 : 0, id),
    db().prepare("DELETE FROM sessions WHERE user_id = ? AND EXISTS (SELECT 1 FROM users WHERE id = ? AND disabled_at IS NOT NULL)").bind(id, id),
  ]);
  if (!update.meta.changes) throw responseError("至少要保留一位管理员", 409);
  return toMember({ ...target, role, disabled_at: disabledAt });
}

// The new password is shown to the admin once; every session of that colleague ends.
export async function resetMemberPassword(actor: AuthUser, id: string) {
  if (id === actor.id) throw responseError("不能在这里重置自己的密码", 403);
  await memberRow(id);
  const password = randomText(PASSWORD_ALPHABET, 10);
  const stored = await hashPassword(password);
  await db().batch([
    db().prepare("UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ? WHERE id = ?").bind(stored.hash, stored.salt, stored.iterations, id),
    db().prepare("DELETE FROM sessions WHERE user_id = ?").bind(id),
  ]);
  return password;
}

export async function readInvite(): Promise<TeamInvite> {
  const row = await db().prepare("SELECT value FROM app_settings WHERE key = ?").bind(INVITE_SETTING).first<{ value: string }>();
  if (row) return { mode: row.value ? "code" : "closed", code: row.value || null };
  return { mode: inviteFromConfig() ? "config" : "none", code: null };
}

// "rotate" issues a new code that replaces any earlier one (including the config file's);
// "close" stops registration until a new code is issued.
export async function changeInvite(action: unknown): Promise<TeamInvite> {
  if (action !== "rotate" && action !== "close") throw responseError("未知的邀请码操作", 400);
  const value = action === "rotate" ? randomText(INVITE_ALPHABET, 8) : "";
  await db().prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(INVITE_SETTING, value, Date.now()).run();
  return readInvite();
}
