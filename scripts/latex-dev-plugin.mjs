// Local PDF typesetting for 讲义编撰. The Worker runtime cannot start programs, so the
// Vite dev server (npm run dev / 启动知题) answers this route; deployed sites only offer
// the LaTeX source. This machine may always typeset; colleagues on the LAN must be signed in.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { arch, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { forgedLocalRequest, isLoopbackAddress, isPrivateAddress } from "./lan-guard.mjs";

const ROUTE = "/__mitty/latex/";
const TECTONIC_VERSION = "0.17.0";
// Pinned release archives with the SHA-256 digests GitHub publishes for them.
const TECTONIC_BUILDS = {
  "darwin-arm64": ["tectonic-0.17.0-aarch64-apple-darwin.tar.gz", "a3f1cac7c5678f01661a92212f58480ae3b0634115d880dbc59e2953ded45667"],
  "darwin-x64": ["tectonic-0.17.0-x86_64-apple-darwin.tar.gz", "7c90ef5b6ddb1eb1937e4337add5237b79338e4b9676459fa91187d24d6cdf80"],
  "linux-x64": ["tectonic-0.17.0-x86_64-unknown-linux-musl.tar.gz", "8533d07f9ccbd7a65824b9e0459041bca34af1eb33daba48f59215593753a3b7"],
};
const MAX_BODY_BYTES = 80 * 1024 * 1024;
const MAX_FILES = 400;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,80})?$/;

export class LatexRequestError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// Only flat project files may be written: no absolute paths, no traversal, no hidden files.
export function validateLatexFiles(body) {
  const main = body?.main; const files = body?.files;
  if (typeof main !== "string" || !main.endsWith(".tex") || !files || typeof files !== "object" || Array.isArray(files)) throw new LatexRequestError("缺少排版文件");
  const entries = Object.entries(files);
  if (!entries.length || entries.length > MAX_FILES) throw new LatexRequestError("排版文件数量不合理");
  const result = entries.map(([name, data]) => {
    if (!FILE_NAME.test(name)) throw new LatexRequestError(`文件名不合法：${name}`);
    if (typeof data !== "string") throw new LatexRequestError(`文件内容不合法：${name}`);
    return [name, Buffer.from(data, "base64")];
  });
  if (!Object.hasOwn(files, main)) throw new LatexRequestError("缺少主文件");
  return { main, entries: result };
}

export function latexIssues(output) {
  return [...output.matchAll(/^error: [^\n]*?\.tex:\d+: ([^\n]+)$/gm)].map((match) => match[1]);
}

function run(command, args, cwd, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk) => { output = (output + chunk).slice(-200_000); };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, output }); });
  });
}

async function installTectonic(directory) {
  const build = TECTONIC_BUILDS[`${platform()}-${arch()}`];
  if (!build) throw new Error(`当前系统（${platform()} ${arch()}）暂不支持自动安装排版引擎`);
  const [file, digest] = build;
  const response = await fetch(`https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/${file}`);
  if (!response.ok) throw new Error(`排版引擎下载失败（HTTP ${response.status}）`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(archive).digest("hex") !== digest) throw new Error("排版引擎校验未通过，已停止安装");
  await mkdir(directory, { recursive: true });
  const archivePath = join(directory, file);
  await writeFile(archivePath, archive);
  try {
    const { code, output } = await run("tar", ["-xzf", archivePath, "-C", directory], directory, 120_000);
    if (code !== 0) throw new Error(`排版引擎解压失败：${output.slice(-300)}`);
  } finally { await rm(archivePath, { force: true }); }
  await chmod(join(directory, "tectonic"), 0o755);
}

// Asks the app itself whether this browser is signed in: same cookie and same Host, so the app
// judges the request exactly as it judged the page that sent it.
function appSignedIn(request) {
  return new Promise((resolve) => {
    const probe = httpRequest({ host: "127.0.0.1", port: request.socket.localPort, path: "/api/auth/me", method: "GET", timeout: 10_000,
      headers: { host: request.headers.host ?? "", cookie: request.headers.cookie ?? "" } }, (reply) => {
      const chunks = [];
      reply.on("data", (chunk) => chunks.push(chunk));
      reply.on("end", () => { try { resolve(Boolean(JSON.parse(Buffer.concat(chunks).toString("utf8")).user)); } catch { resolve(false); } });
      reply.on("error", () => resolve(false));
    });
    probe.on("timeout", () => probe.destroy());
    probe.on("error", () => resolve(false));
    probe.end();
  });
}

export function latexDevPlugin({ root = process.cwd(), signedIn = appSignedIn } = {}) {
  const engineDirectory = join(root, ".tools", "tectonic");
  const engine = join(engineDirectory, "tectonic");
  let installing = null;
  let queue = Promise.resolve();

  async function ensureEngine() {
    if (existsSync(engine)) return engine;
    installing ??= installTectonic(engineDirectory).finally(() => { installing = null; });
    await installing;
    return engine;
  }

  async function compile({ main, entries }) {
    const directory = await mkdtemp(join(tmpdir(), "mitty-latex-"));
    try {
      for (const [name, data] of entries) {
        const target = join(directory, name);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, data);
      }
      // The first run downloads the TeX packages it needs and caches them for later runs.
      const { output } = await run(await ensureEngine(), ["-X", "compile", main, "--untrusted", "-Z", "continue-on-errors"], directory, 300_000);
      const pdfPath = join(directory, main.replace(/\.tex$/, ".pdf"));
      if (!existsSync(pdfPath)) throw Object.assign(new Error("排版失败"), { log: output.slice(-4000) });
      return { pdf: await readFile(pdfPath), issues: latexIssues(output) };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  function readBody(request) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      request.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { reject(new LatexRequestError("讲义文件过大", 413)); request.destroy(); return; }
        chunks.push(chunk);
      });
      request.on("end", () => resolve(Buffer.concat(chunks)));
      request.on("error", reject);
    });
  }

  function sendJson(response, status, payload) {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(payload));
  }

  async function authorize(request) {
    const remoteAddress = request.socket.remoteAddress;
    if (isLoopbackAddress(remoteAddress)) return;
    if (!isPrivateAddress(remoteAddress) || forgedLocalRequest({ remoteAddress, host: request.headers.host, url: request.url })) {
      throw new LatexRequestError("精排 PDF 仅限本机和局域网使用", 403);
    }
    if (!await signedIn(request)) throw new LatexRequestError("请先登录后再导出精排 PDF", 401);
  }

  async function handle(request, response) {
    await authorize(request);
    const origin = request.headers.origin;
    if (origin && new URL(origin).host !== request.headers.host) return sendJson(response, 403, { error: "请求来源不受信任" });
    const path = (request.url ?? "").split("?")[0];
    if (request.method === "GET" && path === `${ROUTE}status`) return sendJson(response, 200, { available: true, installed: existsSync(engine) });
    if (request.method !== "POST" || path !== `${ROUTE}compile`) return sendJson(response, 404, { error: "未知的排版请求" });
    let body;
    try { body = JSON.parse((await readBody(request)).toString("utf8")); } catch (error) { if (error instanceof LatexRequestError) throw error; throw new LatexRequestError("排版请求格式不正确"); }
    const files = validateLatexFiles(body);
    const job = queue.then(() => compile(files));
    queue = job.catch(() => undefined);
    const { pdf, issues } = await job;
    response.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": pdf.length, "X-Latex-Issues": String(issues.length) });
    response.end(pdf);
  }

  return {
    name: "mitty-latex-pdf",
    apply: "serve",
    enforce: "pre",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!request.url?.startsWith(ROUTE)) { next(); return; }
        handle(request, response).catch((error) => {
          if (response.headersSent) { response.end(); return; }
          sendJson(response, error instanceof LatexRequestError ? error.status : 500, { error: error.message || "排版失败", ...(error.log ? { log: error.log } : {}) });
        });
      });
    },
  };
}
