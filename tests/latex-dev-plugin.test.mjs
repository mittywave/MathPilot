import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { latexDevPlugin, latexIssues, validateLatexFiles } from "../scripts/latex-dev-plugin.mjs";

const encoded = value => Buffer.from(value).toString("base64");

test("only flat project files with a .tex main file are accepted", () => {
  const files = validateLatexFiles({ main: "handout.tex", files: { "handout.tex": encoded("x"), "mitty-handout.cls": encoded("y"), "figures/fig-1.png": encoded("z") } });
  assert.deepEqual(files.entries.map(([name, data]) => [name, data.toString()]), [["handout.tex", "x"], ["mitty-handout.cls", "y"], ["figures/fig-1.png", "z"]]);
  for (const name of ["../escape.tex", "/etc/passwd", ".hidden", "figures/../../x", "a/b/c.png", "figures\\fig.png", ""]) {
    assert.throws(() => validateLatexFiles({ main: "handout.tex", files: { "handout.tex": encoded("x"), [name]: encoded("y") } }), /文件名不合法/, name);
  }
  assert.throws(() => validateLatexFiles({ main: "handout.pdf", files: { "handout.pdf": "" } }), /缺少排版文件/);
  assert.throws(() => validateLatexFiles({ main: "handout.tex", files: { "other.tex": encoded("x") } }), /缺少主文件/);
  assert.throws(() => validateLatexFiles({ main: "handout.tex", files: { "handout.tex": 42 } }), /文件内容不合法/);
});

test("TeX errors are reported as issues without failing the export", () => {
  const output = "note: Running TeX ...\nerror: handout.tex:25: Undefined control sequence\nwarning: errors were issued by the TeX engine\nerror: handout.tex:40: Missing $ inserted\n";
  assert.deepEqual(latexIssues(output), ["Undefined control sequence", "Missing $ inserted"]);
});

function middleware(root, signedIn) {
  let handler;
  latexDevPlugin({ root, ...(signedIn ? { signedIn } : {}) }).configureServer({ middlewares: { use: (fn) => { handler = fn; } } });
  return (request) => new Promise((resolve) => {
    const response = { status: 0, headers: {}, body: "", headersSent: false,
      writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
      end(body = "") { this.body = String(body); resolve(this); } };
    // A real request stream holds its body until the handler starts reading it.
    const { body, ...rest } = request;
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(body)]), { method: "GET", headers: { host: "127.0.0.1:3001" }, socket: { remoteAddress: "127.0.0.1" }, ...rest });
    handler(req, response, () => resolve({ passedThrough: true }));
  });
}

test("the typesetter answers this machine and leaves other routes alone", async () => {
  const call = middleware(await mkdtemp(join(tmpdir(), "mitty-latex-test-")));
  assert.deepEqual(await call({ url: "/tools/handouts" }), { passedThrough: true });
  const status = await call({ url: "/__mitty/latex/status" });
  assert.equal(status.status, 200);
  assert.deepEqual(JSON.parse(status.body), { available: true, installed: false });
  assert.equal((await call({ url: "/__mitty/latex/compile", method: "POST", headers: { host: "127.0.0.1:3001", origin: "http://evil.test" }, body: "{}" })).status, 403);
  const malformed = await call({ url: "/__mitty/latex/compile", method: "POST", body: "{not json" });
  assert.equal(malformed.status, 400);
  assert.match(JSON.parse(malformed.body).error, /格式不正确/);
  const traversal = await call({ url: "/__mitty/latex/compile", method: "POST", body: JSON.stringify({ main: "handout.tex", files: { "handout.tex": "", "../x": "" } }) });
  assert.equal(traversal.status, 400);
  assert.equal((await call({ url: "/__mitty/latex/unknown" })).status, 404);
});

test("colleagues on the LAN may typeset once signed in; other networks and forged hosts may not", async () => {
  const asked = [];
  const call = middleware(await mkdtemp(join(tmpdir(), "mitty-latex-test-")), async (request) => { asked.push(request.headers.cookie); return request.headers.cookie === "session=ok"; });
  const lan = { url: "/__mitty/latex/status", socket: { remoteAddress: "192.168.1.20" } };
  assert.equal((await call({ ...lan, headers: { host: "192.168.0.234:3001", cookie: "session=ok" } })).status, 200);
  const signedOut = await call({ ...lan, headers: { host: "192.168.0.234:3001" } });
  assert.equal(signedOut.status, 401);
  assert.match(JSON.parse(signedOut.body).error, /请先登录/);
  assert.equal((await call({ ...lan, socket: { remoteAddress: "8.8.8.8" }, headers: { host: "192.168.0.234:3001", cookie: "session=ok" } })).status, 403);
  assert.equal((await call({ ...lan, headers: { host: "localhost:3001", cookie: "session=ok" } })).status, 403);
  assert.deepEqual(asked, ["session=ok", undefined], "the session is only consulted for genuine LAN requests");
  const compile = await call({ url: "/__mitty/latex/compile", method: "POST", socket: { remoteAddress: "192.168.1.20" }, headers: { host: "192.168.0.234:3001", origin: "http://192.168.0.234:3001", cookie: "session=ok" }, body: "{not json" });
  assert.equal(compile.status, 400, "a signed-in colleague reaches the compiler itself");
});

test("the sign-in check asks the app with the browser's own cookie and host", async () => {
  const seen = [];
  const app = createServer((request, response) => {
    seen.push({ path: request.url, host: request.headers.host, cookie: request.headers.cookie });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ user: request.headers.cookie === "mitty_session=valid" ? { id: "teacher" } : null }));
  });
  await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
  try {
    const call = middleware(await mkdtemp(join(tmpdir(), "mitty-latex-test-")));
    const lan = (cookie) => call({ url: "/__mitty/latex/status", socket: { remoteAddress: "192.168.1.20", localPort: app.address().port }, headers: { host: "192.168.0.234:3001", ...(cookie ? { cookie } : {}) } });
    assert.equal((await lan("mitty_session=valid")).status, 200);
    assert.equal((await lan("mitty_session=expired")).status, 401);
    assert.equal((await lan()).status, 401);
    assert.deepEqual(seen.map((item) => [item.path, item.host]), Array(3).fill(["/api/auth/me", "192.168.0.234:3001"]));
    assert.deepEqual(seen.map((item) => item.cookie), ["mitty_session=valid", "mitty_session=expired", ""]);
  } finally { app.close(); }
});
