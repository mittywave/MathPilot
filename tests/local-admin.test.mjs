import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ALEVEL_PAGE_COPY } from "../lib/alevel-page-locale.mjs";
import { migratedDatabase, d1 } from "./helpers/migrated-d1.mjs";
import { loadSource } from "./load-source.mjs";

test("MP-08 ordinary invitations never grant admin by email; the operator can bootstrap one account by ID", async t => {
  const sqlite = await migratedDatabase(); t.after(() => sqlite.close());
  const bindings = { DB: d1(sqlite), REGISTRATION_INVITE_CODE: "ordinary-invite", ADMIN_EMAIL: "admin@bootstrap.test", LOCAL_ADMIN_MODE: "false" };
  const { POST } = await loadSource("app/api/auth/register/route.ts", bindings);
  const register = email => POST(new Request("https://fixture.test/api/auth/register", { method: "POST", headers: { Origin: "https://fixture.test", "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "fixture-password", inviteCode: "ordinary-invite" }) }));
  const response = await register(bindings.ADMIN_EMAIL), { user } = await response.json();
  assert.equal(response.status, 201); assert.equal(user.role, "member");
  assert.equal((await register(bindings.ADMIN_EMAIL)).status, 409);
  // This is the documented operator-only D1 action, never an HTTP registration capability.
  const bootstrap = sqlite.prepare("UPDATE users SET role='admin' WHERE id=? AND role='member' AND disabled_at IS NULL AND NOT EXISTS (SELECT 1 FROM users WHERE role='admin' AND disabled_at IS NULL)");
  assert.equal(bootstrap.run(user.id).changes, 1);
  const next = await (await register("next@bootstrap.test")).json();
  assert.equal(bootstrap.run(next.user.id).changes, 0, "subsequent promotions belong to an authenticated administrator");
  assert.equal(sqlite.prepare("SELECT role FROM users WHERE id=?").get(user.id).role, "admin");
});

test("repeated local environment sync preserves the watched file while applying actual changes", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "mathpilot-local-env-"));
  const worker = join(fixture, ".dev.vars");
  const local = join(fixture, ".env.local");
  const script = fileURLToPath(new URL("../scripts/sync-local-env.mjs", import.meta.url));
  const sync = () => execFileSync(process.execPath, [script], { cwd: fixture, encoding: "utf8" });
  try {
    await writeFile(worker, 'WORKER_ONLY="worker-value"\nSHARED="from-worker"\nLOCAL_ADMIN_MODE=false\n');
    await writeFile(local, 'LOCAL_ONLY="local-value"\nSHARED="from-local"\n');
    assert.doesNotMatch(sync(), /worker-value|local-value|from-local/);
    const merged = 'WORKER_ONLY="worker-value"\nSHARED="from-local"\nLOCAL_ADMIN_MODE=true\nLOCAL_ONLY="local-value"\n';
    assert.equal(await readFile(worker, "utf8"), merged);
    assert.equal((await stat(worker)).mode & 0o777, 0o600);

    // A second startup must not replace/touch the file: Vite restarts its Worker
    // when this file changes, aborting requests already in progress.
    const earlier = new Date("2020-01-01T00:00:00Z");
    await utimes(worker, earlier, earlier);
    const before = await stat(worker);
    sync();
    const after = await stat(worker);
    assert.equal(after.ino, before.ino, "unchanged configuration must not be replaced");
    assert.equal(after.mtimeMs, before.mtimeMs, "unchanged configuration must not be touched");
    assert.equal(after.ctimeMs, before.ctimeMs, "unchanged permissions must not be rewritten");

    await chmod(worker, 0o644);
    sync();
    assert.equal((await stat(worker)).mode & 0o777, 0o600);
    assert.equal((await stat(worker)).mtimeMs, before.mtimeMs);

    await writeFile(local, 'LOCAL_ONLY="updated-value"\nSHARED="from-local"\n');
    assert.doesNotMatch(sync(), /worker-value|updated-value|from-local/);
    assert.equal(await readFile(worker, "utf8"), merged.replace("local-value", "updated-value"));
    assert.equal((await stat(worker)).mode & 0o777, 0o600);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("limits automatic administrator access to loopback hostnames", async () => {
  const auth = await readFile(new URL("../lib/server/auth.ts", import.meta.url), "utf8");
  assert.match(auth, /hostname === "localhost"/);
  assert.match(auth, /hostname === "127\.0\.0\.1"/);
  assert.match(auth, /hostname === "::1"/);
  assert.match(auth, /hostname\.endsWith\("\.localhost"\)/);
  assert.match(auth, /if \(isLocalRequest\(request\)\)/);
  assert.match(auth, /return LOCAL_ADMIN/);
  assert.match(auth, /INSERT OR IGNORE INTO users/);
});

test("shows local administrator labels without internal account details and hides logout", async () => {
  const page = await readFile(new URL("../app/library/page.tsx", import.meta.url), "utf8");
  const header = await readFile(new URL("../app/components/SiteHeader.tsx", import.meta.url), "utf8");
  assert.equal(ALEVEL_PAGE_COPY.zh.localAdmin, "本机管理员");
  assert.equal(ALEVEL_PAGE_COPY.en.localAdmin, "Local Admin");
  for (const copy of Object.values(ALEVEL_PAGE_COPY)) {
    assert.equal("localAdminSuffix" in copy, false);
    assert.equal("loggedInAs" in copy, false);
    assert.equal("noLogin" in copy, false);
  }
  // Shared headers own logout; the 题库 callback keeps its existing state cleanup.
  assert.match(header, /user\?\.local \? copy\.localAdmin/);
  assert.match(header, /user && !user\.local && <button/);
  assert.match(page, /onSignOut=\{signOut\}/);
  assert.doesNotMatch(page, /pageCopy\.(localAdminSuffix|loggedInAs)/);
  assert.match(page, /question\.createdBy === "local-admin"/);
  assert.match(page, /"Entered by local admin" : "本机管理员 录入"/);
});
