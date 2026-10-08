import { authBindings, authRateLimited, clientAddress, createSession, hashPassword, inviteMatches, normalizeEmail, recordAuthAttempt, requireSameOrigin, roleForEmail, validEmail, validPassword } from "../../../../lib/server/auth";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const body = await request.json() as { email?: string; password?: string; inviteCode?: string };
    const email = normalizeEmail(body.email ?? "");
    const password = body.password ?? "";
    const key = `${clientAddress(request)}:${email}`;
    if (await authRateLimited("register", key)) return Response.json({ error: "尝试次数过多，请 15 分钟后再试" }, { status: 429 });
    if (!validEmail(email)) return Response.json({ error: "请输入有效邮箱" }, { status: 400 });
    if (!validPassword(password)) return Response.json({ error: "密码需为 8—128 个字符" }, { status: 400 });
    if (!await inviteMatches(body.inviteCode ?? "")) {
      await recordAuthAttempt("register", key);
      return Response.json({ error: "邀请码不正确" }, { status: 403 });
    }
    const db = authBindings().DB;
    const existing = await db.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
    if (existing) return Response.json({ error: "这个邮箱已经注册，请直接登录" }, { status: 409 });
    const id = crypto.randomUUID();
    const passwordData = await hashPassword(password);
    const role = roleForEmail(email);
    await db.prepare("INSERT INTO users (id, email, password_hash, password_salt, password_iterations, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, email, passwordData.hash, passwordData.salt, passwordData.iterations, role, Date.now()).run();
    const cookie = await createSession(id, new URL(request.url).protocol === "https:");
    return Response.json({ user: { id, email, role } }, { status: 201, headers: { "Set-Cookie": cookie } });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "注册失败" }, { status: 500 });
  }
}
