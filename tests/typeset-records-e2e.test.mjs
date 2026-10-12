import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loopbackFetch as fetch } from "./helpers/loopback-fetch.mjs";
import { localD1Rows } from "./helpers/local-d1-observer.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const WRANGLER = join(ROOT, "node_modules", ".bin", "wrangler");
const CONFIG = join(ROOT, "dist", "server", "wrangler.json");
const INVITE = "typeset-e2e-invite";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

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

async function call(base, path, { cookie = "", method = "GET", json, origin = base } = {}) {
  const headers = cookie ? { Cookie: cookie } : {};
  if (json !== undefined) Object.assign(headers, { "Content-Type": "application/json", Origin: origin });
  return fetch(`${base}${path}`, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
}

// The page sends the Word file as a data URL, the way image uploads do.
const word = (name, text) => ({ fileName: name, file: `data:${DOCX};base64,${Buffer.from(`PK fake docx: ${text}`).toString("base64")}` });
const recordBody = ({ file, title = "", questionCount = 3, settings = { answers: "none", linePitch: 8, groupRoom: {}, ownRoom: {} } }) => ({ ...file, title, questionCount, settings });

test("快速排版 history: each teacher sees, reopens and deletes only their own typeset materials", { timeout: 120_000 }, async () => {
  const port = await freePort();
  const state = await mkdtemp(join(tmpdir(), "zhiti-typeset-"));
  const migrate = spawnSync(WRANGLER, ["d1", "migrations", "apply", "DB", "--local", "--persist-to", state, "--config", join(ROOT, "wrangler.jsonc")], { cwd: ROOT, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  if (migrate.status !== 0) throw new Error(`${migrate.stdout}\n${migrate.stderr}`);
  const vars = { LOCAL_ADMIN_MODE: "false", REGISTRATION_INVITE_CODE: INVITE, ADMIN_EMAIL: "admin@typeset.test" };
  const worker = spawn(process.execPath, [join(ROOT, "scripts/start-local-test-worker.mjs"), CONFIG, String(port), state, JSON.stringify(vars)], { cwd: ROOT, env: { ...process.env, NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; worker.stdout.on("data", (chunk) => { output += chunk; }); worker.stderr.on("data", (chunk) => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let ready = false, deadline = Date.now() + 30_000; !ready;) {
      if (worker.exitCode != null || Date.now() > deadline) throw new Error(`Worker 未能启动\n${output}`);
      try { ready = (await fetch(`${base}/api/auth/me`)).ok; } catch { /* 等待监听端口 */ }
      if (!ready) await new Promise((wait) => setTimeout(wait, 120));
    }
    assert.equal((await call(base, "/api/typeset-records")).status, 401);
    const cookies = [];
    for (const email of ["one@typeset.test", "two@typeset.test"]) {
      const registration = await call(base, "/api/auth/register", { method: "POST", json: { email, password: "password123", inviteCode: INVITE } });
      assert.equal(registration.status, 201);
      cookies.push((registration.headers.get("set-cookie") ?? "").split(";", 1)[0]);
    }
    const [one, two] = cookies;

    // A record keeps the Word file, the title, the question count and the settings.
    const settings = { answers: "end", linePitch: 9, groupRoom: { "解答题|行": 5 }, ownRoom: { 3: 8 } };
    const createdResponse = await call(base, "/api/typeset-records", { cookie: one, method: "POST", json: recordBody({ file: word("第3讲 一元一次方程.docx", "lesson 3"), title: "第3讲 一元一次方程", questionCount: 25, settings }) });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json()).record;
    assert.equal(created.title, "第3讲 一元一次方程"); assert.equal(created.fileName, "第3讲 一元一次方程.docx"); assert.equal(created.questionCount, 25);
    assert.deepEqual(created.settings, settings); assert.equal(created.createdAt, created.updatedAt);
    const second = (await (await call(base, "/api/typeset-records", { cookie: one, method: "POST", json: recordBody({ file: word("周练.docx", "weekly") }) })).json()).record;
    assert.equal(second.title, "周练", "an empty title falls back to the file name");

    // Wrong input is refused, and nothing is created for it.
    assert.equal((await call(base, "/api/typeset-records", { cookie: one, method: "POST", json: recordBody({}) })).status, 400, "no file");
    assert.equal((await call(base, "/api/typeset-records", { cookie: one, method: "POST", json: recordBody({ file: word("notes.pdf", "x") }) })).status, 400, "not a .docx");
    assert.equal((await call(base, "/api/typeset-records", { cookie: one, method: "POST", json: recordBody({ file: word("a.docx", "x"), settings: [1, 2] }) })).status, 400, "settings must be an object");
    assert.equal((await call(base, "/api/typeset-records", { cookie: one, method: "POST", origin: "https://evil.example", json: recordBody({ file: word("a.docx", "x") }) })).status, 403);

    // Newest first; the other teacher sees none of it.
    let list = (await (await call(base, "/api/typeset-records", { cookie: one })).json()).records;
    assert.deepEqual(list.map((record) => record.id), [second.id, created.id]);
    assert.deepEqual((await (await call(base, "/api/typeset-records", { cookie: two })).json()).records, []);

    // The Word file comes back byte for byte, to its owner only, and never through the shared asset route.
    const source = await call(base, `/api/typeset-records/${created.id}/source`, { cookie: one });
    assert.equal(source.status, 200); assert.equal(source.headers.get("content-type"), DOCX);
    assert.equal(new TextDecoder().decode(await source.arrayBuffer()), "PK fake docx: lesson 3");
    assert.equal((await call(base, `/api/typeset-records/${created.id}/source`, { cookie: two })).status, 404);
    const [asset] = localD1Rows(state, "SELECT source_asset_id AS id FROM typeset_records WHERE id = ?", [created.id]);
    assert.equal((await call(base, `/api/assets/${asset.id}`, { cookie: one })).status, 404, "the shared asset route does not serve it");

    // An edit updates the record and makes it the latest; another teacher cannot edit it.
    assert.equal((await call(base, `/api/typeset-records/${created.id}`, { cookie: two, method: "PATCH", json: { title: "改名" } })).status, 404);
    await new Promise((wait) => setTimeout(wait, 5));
    const editedResponse = await call(base, `/api/typeset-records/${created.id}`, { cookie: one, method: "PATCH", json: { title: "第3讲 方程", settings: { ...settings, answers: "each" } } });
    assert.equal(editedResponse.status, 200);
    const edited = (await editedResponse.json()).record;
    assert.equal(edited.title, "第3讲 方程"); assert.equal(edited.settings.answers, "each"); assert.equal(edited.createdAt, created.createdAt);
    assert.ok(edited.updatedAt > created.updatedAt);
    list = (await (await call(base, "/api/typeset-records", { cookie: one })).json()).records;
    assert.deepEqual(list.map((record) => record.id), [created.id, second.id], "the edited record moves to the top");
    assert.equal((await call(base, `/api/typeset-records/${created.id}`, { cookie: one, method: "PATCH", json: { settings: "oops" } })).status, 400);

    // The same Word file opened twice shares one stored copy, which goes with the last record that uses it.
    const twin = (await (await call(base, "/api/typeset-records", { cookie: one, method: "POST", json: recordBody({ file: word("第3讲 一元一次方程.docx", "lesson 3") }) })).json()).record;
    const stored = () => localD1Rows(state, "SELECT COUNT(*) AS n FROM question_assets WHERE id = ?", [asset.id])[0].n;
    assert.equal(localD1Rows(state, "SELECT COUNT(*) AS n FROM typeset_records WHERE source_asset_id = ?", [asset.id])[0].n, 2);
    assert.equal((await call(base, `/api/typeset-records/${created.id}`, { cookie: two, method: "DELETE", json: {} })).status, 404);
    assert.equal((await call(base, `/api/typeset-records/${created.id}`, { cookie: one, method: "DELETE", json: {} })).status, 200);
    assert.equal(stored(), 1, "still used by the twin record");
    assert.equal((await call(base, `/api/typeset-records/${created.id}/source`, { cookie: one })).status, 404);
    assert.equal((await call(base, `/api/typeset-records/${twin.id}`, { cookie: one, method: "DELETE", json: {} })).status, 200);
    assert.equal(stored(), 0, "the last record takes the file with it");
    assert.equal(localD1Rows(state, "SELECT COUNT(*) AS n FROM question_asset_chunks WHERE asset_id = ?", [asset.id])[0].n, 0);
    list = (await (await call(base, "/api/typeset-records", { cookie: one })).json()).records;
    assert.deepEqual(list.map((record) => record.id), [second.id]);
  } finally {
    worker.kill("SIGTERM");
  }
});
