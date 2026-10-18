import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loopbackFetch as fetch } from './helpers/loopback-fetch.mjs';
import { bootstrapAdmin } from './helpers/migrated-d1.mjs';

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const WRANGLER = join(ROOT, "node_modules", ".bin", "wrangler");
const CONFIG = join(ROOT, "dist", "server", "wrangler.json");
const INVITE = "team-e2e-invite";

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function jsonRequest(base, path, { cookie = "", method = "GET", body, origin = base } = {}) {
  const headers = cookie ? { Cookie: cookie } : {};
  if (body !== undefined) Object.assign(headers, { "Content-Type": "application/json", Origin: origin });
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { response, payload: await response.json().catch(() => ({})) };
}

test("admins manage colleagues and the invite code; disabled accounts and reset passwords take effect at once", { timeout: 120_000 }, async () => {
  const port = await freePort();
  const state = await mkdtemp(join(tmpdir(), "zhiti-team-"));
  const migrate = spawnSync(WRANGLER, ["d1", "migrations", "apply", "DB", "--local", "--persist-to", state, "--config", join(ROOT, "wrangler.jsonc")], { cwd: ROOT, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  if (migrate.status !== 0) throw new Error(`${migrate.stdout}\n${migrate.stderr}`);
  const vars = { LOCAL_ADMIN_MODE: "false", REGISTRATION_INVITE_CODE: INVITE, ADMIN_EMAIL: "admin@team.test" };
  const worker = spawn(process.execPath, [join(ROOT, "scripts/start-local-test-worker.mjs"), CONFIG, String(port), state, JSON.stringify(vars)], { cwd: ROOT, env: { ...process.env, NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; worker.stdout.on("data", (chunk) => { output += chunk; }); worker.stderr.on("data", (chunk) => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  const register = (email, inviteCode) => jsonRequest(base, "/api/auth/register", { method: "POST", body: { email, password: "password123", inviteCode } });
  const login = (email, password = "password123") => jsonRequest(base, "/api/auth/login", { method: "POST", body: { email, password } });
  const cookieOf = (result) => (result.response.headers.get("set-cookie") ?? "").split(";", 1)[0];
  try {
    for (let ready = false, deadline = Date.now() + 30_000; !ready;) {
      if (worker.exitCode != null || Date.now() > deadline) throw new Error(`Worker 未能启动\n${output}`);
      try { ready = (await fetch(`${base}/api/auth/me`)).ok; } catch { /* 等待监听端口 */ }
      if (!ready) await new Promise((wait) => setTimeout(wait, 120));
    }
    const administrator = await register("admin@team.test", INVITE);
    assert.equal(administrator.payload.user.role, "member", "ADMIN_EMAIL is not an authorization grant");
    assert.equal((await register("admin@team.test", INVITE)).response.status, 409);
    bootstrapAdmin(state, administrator.payload.user.id);
    const admin = cookieOf(administrator);
    const one = cookieOf(await register("one@team.test", INVITE));
    const two = cookieOf(await register("two@team.test", INVITE));

    assert.equal((await jsonRequest(base, "/api/admin/members")).response.status, 401);
    assert.equal((await jsonRequest(base, "/api/admin/members", { cookie: one })).response.status, 403, "teachers cannot open 共享办公");
    const team = await jsonRequest(base, "/api/admin/members", { cookie: admin });
    assert.equal(team.response.status, 200);
    assert.deepEqual(team.payload.invite, { mode: "config", code: null });
    assert.deepEqual(team.payload.members.map((member) => [member.email, member.role, member.disabledAt]), [["admin@team.test", "admin", null], ["one@team.test", "member", null], ["two@team.test", "member", null]]);
    assert.ok(team.payload.members.every((member) => member.lastLoginAt > 0), "registering signs in and records it");
    const ids = Object.fromEntries(team.payload.members.map((member) => [member.email.split("@")[0], member.id]));

    // The invite code set here replaces the config file's; closing it stops registration.
    assert.equal((await jsonRequest(base, "/api/admin/invite", { cookie: one, method: "POST", body: { action: "rotate" } })).response.status, 403);
    const rotated = await jsonRequest(base, "/api/admin/invite", { cookie: admin, method: "POST", body: { action: "rotate" } });
    assert.equal(rotated.payload.invite.mode, "code");
    assert.match(rotated.payload.invite.code, /^[A-HJ-NP-Z2-9]{8}$/);
    assert.equal((await register("three@team.test", INVITE)).response.status, 403, "the config file's code no longer works");
    assert.equal((await register("three@team.test", rotated.payload.invite.code)).response.status, 201);
    assert.deepEqual((await jsonRequest(base, "/api/admin/invite", { cookie: admin, method: "POST", body: { action: "close" } })).payload.invite, { mode: "closed", code: null });
    assert.equal((await register("four@team.test", rotated.payload.invite.code)).response.status, 403);
    assert.equal((await register("four@team.test", "")).response.status, 403, "a closed registration accepts no empty code");
    assert.equal((await jsonRequest(base, "/api/admin/invite", { cookie: admin, method: "POST", body: { action: "unknown" } })).response.status, 400);

    // Roles: promoting gives access at once; nobody changes their own role.
    assert.equal((await jsonRequest(base, `/api/admin/members/${ids.admin}`, { cookie: admin, method: "PATCH", body: { role: "member" } })).response.status, 403);
    assert.equal((await jsonRequest(base, `/api/admin/members/${ids.one}`, { cookie: admin, method: "PATCH", body: { role: "admin" } })).payload.member.role, "admin");
    assert.equal((await jsonRequest(base, "/api/admin/members", { cookie: one })).response.status, 200);
    assert.equal((await jsonRequest(base, `/api/admin/members/${ids.admin}`, { cookie: one, method: "PATCH", body: { role: "member" } })).payload.member.role, "member");
    assert.equal((await jsonRequest(base, "/api/admin/members", { cookie: admin })).response.status, 403, "a demoted admin loses access immediately");
    assert.equal((await jsonRequest(base, `/api/admin/members/${ids.admin}`, { cookie: one, method: "PATCH", body: { role: "admin" } })).response.status, 200);
    assert.equal((await jsonRequest(base, "/api/admin/members/local-admin", { cookie: admin, method: "PATCH", body: { role: "member" } })).response.status, 404);

    // Disabling ends the session and blocks sign-in; the account and its data stay.
    const disabled = await jsonRequest(base, `/api/admin/members/${ids.two}`, { cookie: admin, method: "PATCH", body: { disabled: true } });
    assert.ok(disabled.payload.member.disabledAt > 0);
    assert.equal((await jsonRequest(base, "/api/auth/me", { cookie: two })).payload.user, null);
    const blocked = await login("two@team.test");
    assert.equal(blocked.response.status, 403);
    assert.match(blocked.payload.error, /已停用/);
    assert.equal((await login("two@team.test", "wrong-password")).response.status, 401, "a wrong password never reveals that the account is disabled");
    assert.equal((await jsonRequest(base, `/api/admin/members/${ids.two}`, { cookie: admin, method: "PATCH", body: { disabled: false } })).payload.member.disabledAt, null);
    const relogged = await login("two@team.test");
    assert.equal(relogged.response.status, 200);
    const twoAgain = cookieOf(relogged);

    // A reset password replaces the old one and signs the colleague out everywhere.
    assert.equal((await jsonRequest(base, `/api/admin/members/${ids.admin}/password`, { cookie: admin, method: "POST", body: {} })).response.status, 403);
    ids.three = (await jsonRequest(base, "/api/admin/members", { cookie: admin })).payload.members.find((member) => member.email === "three@team.test").id;
    const reset = await jsonRequest(base, `/api/admin/members/${ids.three}/password`, { cookie: admin, method: "POST", body: {} });
    assert.match(reset.payload.password, /^[a-hjkmnp-z2-9]{10}$/);
    assert.equal((await login("three@team.test")).response.status, 401);
    assert.equal((await login("three@team.test", reset.payload.password)).response.status, 200);
    assert.equal((await jsonRequest(base, `/api/admin/members/${ids.three}/password`, { cookie: twoAgain, method: "POST", body: {} })).response.status, 403);
  } finally {
    worker.kill("SIGINT");
    await Promise.race([new Promise((done) => worker.once("exit", done)), new Promise((done) => setTimeout(done, 3_000))]);
    if (worker.exitCode == null) worker.kill("SIGKILL");
  }
});
