// 共享办公 · 共享开关. npm run dev always listens on 0.0.0.0; this middleware decides per
// request whether another machine may use the site, so sharing turns on and off without a
// restart. Only this machine may change the setting. A network is recognised by its router's
// hardware address: a remembered office network still matches after the Mac's IP changes, and a
// home network that happens to use the same address range never matches it.
import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname, networkInterfaces, platform } from "node:os";
import { dirname, join } from "node:path";
import { forgedLocalRequest, isLoopbackAddress, isPrivateAddress } from "./lan-guard.mjs";

const ROUTE = "/__mitty/share/";
const REFRESH_MS = 15_000;
const MAX_BODY_BYTES = 4096;

export class ShareRequestError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// macOS `route -n get default`, or Linux `ip route show default`.
export function parseDefaultRoute(output) {
  const text = String(output ?? "");
  const gateway = text.match(/^\s*gateway:\s*(\S+)/m)?.[1]; const iface = text.match(/^\s*interface:\s*(\S+)/m)?.[1];
  if (gateway && iface) return { gateway, iface };
  const linux = text.match(/^default via (\S+) dev (\S+)/m);
  return linux ? { gateway: linux[1], iface: linux[2] } : null;
}

// macOS `arp -n <ip>` ("at 0:a:f7:9f:b7:67") or Linux `ip neigh show <ip>` ("lladdr ...").
export function parseRouterMac(output) {
  const found = String(output ?? "").match(/\b(?:at|lladdr)\s+([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})\b/i);
  return found ? found[1].split(":").map((part) => part.padStart(2, "0")).join(":").toLowerCase() : null;
}

export function subnetOf(address, netmask) {
  const value = (ip) => ip.split(".").reduce((total, part) => total * 256 + Number(part), 0);
  const mask = value(netmask);
  const network = (value(address) & mask) >>> 0;
  return `${[24, 16, 8, 0].map((shift) => (network >>> shift) & 255).join(".")}/${mask.toString(2).replace(/0+$/, "").length}`;
}

export function describeNetwork({ gateway, address, netmask, routerMac }) {
  const subnet = subnetOf(address, netmask);
  return { id: routerMac ? `router:${routerMac}` : `subnet:${subnet}@${gateway}`, label: `网关 ${gateway} · ${subnet}`, address, subnet };
}

function run(command, args) {
  return new Promise((resolve) => { execFile(command, args, { timeout: 3000 }, (error, stdout) => resolve(error ? "" : String(stdout))); });
}

// A default route through a VPN or a public address is not a LAN anyone could share on.
export async function detectNetwork() {
  const linux = platform() === "linux";
  const route = parseDefaultRoute(await run(linux ? "ip" : "/sbin/route", linux ? ["route", "show", "default"] : ["-n", "get", "default"]));
  if (!route) return null;
  const ipv4 = (networkInterfaces()[route.iface] ?? []).find((entry) => entry.family === "IPv4" || entry.family === 4);
  if (!ipv4 || !isPrivateAddress(ipv4.address)) return null;
  const routerMac = parseRouterMac(await run(linux ? "ip" : "/usr/sbin/arp", linux ? ["neigh", "show", route.gateway] : ["-n", route.gateway]));
  return describeNetwork({ gateway: route.gateway, address: ipv4.address, netmask: ipv4.netmask, routerMac });
}

// The Mac's Bonjour name (MittydeMacBook-Pro.local) reaches it on the LAN whatever its IP is.
export function localNetworkName() {
  if (platform() === "darwin") {
    try { const name = execFileSync("/usr/sbin/scutil", ["--get", "LocalHostName"], { encoding: "utf8", timeout: 2000 }).trim(); if (name) return `${name}.local`; }
    catch { /* falls back to the host name */ }
  }
  const name = hostname();
  return name.endsWith(".local") ? name : `${name}.local`;
}

// remembered: networks that share by themselves (saved). session: the network shared until the
// server stops (not saved), so a one-off share never follows the Mac home.
export function isSharing(state, network) {
  return Boolean(network && (state.session === network.id || state.remembered.some((item) => item.id === network.id)));
}

export function changeSharing(state, network, { sharing, remember }, now = Date.now()) {
  if (!network) throw new ShareRequestError("这台电脑现在没有连接局域网", 409);
  const others = state.remembered.filter((item) => item.id !== network.id);
  if (!sharing) return { session: null, remembered: others };
  const existing = state.remembered.find((item) => item.id === network.id);
  return { session: network.id, remembered: remember ? [...others, existing ?? { id: network.id, label: network.label, rememberedAt: now }] : others };
}

export function forgetNetwork(state, id) {
  return { session: state.session === id ? null : state.session, remembered: state.remembered.filter((item) => item.id !== id) };
}

async function loadRemembered(file) {
  try {
    const saved = JSON.parse(await readFile(file, "utf8"));
    return (Array.isArray(saved?.remembered) ? saved.remembered : []).filter((item) => typeof item?.id === "string")
      .map((item) => ({ id: item.id, label: String(item.label ?? ""), rememberedAt: Number(item.rememberedAt) || 0 }));
  } catch { return []; }
}

// Colleagues lose the site when the Mac sleeps, so idle sleep is held off while sharing.
// Closing the lid still sleeps; caffeinate also exits with this server (-w).
function macKeepAwake() {
  let child = null;
  return (on) => {
    if (on && !child && platform() === "darwin") {
      child = spawn("/usr/bin/caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
      child.on("error", () => { child = null; });
      child.unref();
    } else if (!on && child) { child.kill(); child = null; }
  };
}

const NOT_SHARED_PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MathPilot 暂未共享</title>
<style>body{margin:0;display:grid;min-height:100vh;place-items:center;padding:0 16px;font:16px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f6f8f7;color:#24352f}main{max-width:420px}h1{margin:0 0 8px;font-size:20px}p{margin:0;color:#5b6b64}@media(prefers-color-scheme:dark){body{background:#0b0f14;color:#e6ece9}p{color:#9fb0a8}}</style>
<main><h1>MathPilot 暂未共享</h1><p>这台电脑上的 MathPilot 现在只供本机使用。请管理员在「工具箱 → 共享办公」里打开共享，然后刷新这个页面。</p></main></html>`;

export function lanSharePlugin({ root = process.cwd(), detect = detectNetwork, keepAwake = macKeepAwake(), refreshMs = REFRESH_MS, name = localNetworkName() } = {}) {
  const file = join(root, ".wrangler", "share.json");
  let state = { session: null, remembered: [] };
  let network = null; let sharing = false; let port = 3001; let log = () => {};

  function addresses(atPort = port) { return network ? [`http://${name}:${atPort}`, `http://${network.address}:${atPort}`] : []; }
  function settle() {
    const next = isSharing(state, network);
    if (next === sharing) return;
    sharing = next; keepAwake(next);
    log(next ? `MathPilot 已共享给同事：${addresses().join("  或  ")}` : "MathPilot 已停止共享，现在只有这台电脑能用。");
  }
  async function refresh() { network = await detect(); settle(); }
  // Starts with the server, so the first "已共享" message reaches the terminal with the real port.
  let ready = Promise.resolve();

  function status(request) {
    return {
      sharing, local: isLoopbackAddress(request.socket.remoteAddress), keepAwake: platform() === "darwin",
      network: network && { label: network.label, address: network.address },
      autoHere: Boolean(network && state.remembered.some((item) => item.id === network.id)),
      remembered: state.remembered.map((item) => ({ ...item, current: item.id === network?.id })),
      addresses: addresses(request.socket.localPort ?? port),
    };
  }

  function readBody(request) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      request.on("data", (chunk) => { size += chunk.length; if (size > MAX_BODY_BYTES) { reject(new ShareRequestError("请求过大", 413)); request.destroy(); return; } chunks.push(chunk); });
      request.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { reject(new ShareRequestError("请求格式不正确")); } });
      request.on("error", reject);
    });
  }

  // Changes come only from a page on this machine, opened at a loopback name: a page from
  // another site resolved to 127.0.0.1 (DNS rebinding) carries its own host and is refused.
  async function handle(request, response) {
    const path = (request.url ?? "").split("?")[0];
    await ready;
    if (request.method === "GET" && path === `${ROUTE}status`) { await refresh(); return sendJson(response, 200, status(request)); }
    if (request.method !== "POST" || ![`${ROUTE}set`, `${ROUTE}forget`].includes(path)) return sendJson(response, 404, { error: "未知的共享请求" });
    const host = String(request.headers.host ?? "");
    let hostName = "";
    try { hostName = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, ""); } catch { /* refused below */ }
    if (!isLoopbackAddress(request.socket.remoteAddress) || !["localhost", "127.0.0.1", "::1"].includes(hostName)) throw new ShareRequestError("只能在运行 MathPilot 的这台电脑上开关共享", 403);
    const origin = request.headers.origin;
    if (origin && new URL(origin).host !== host) throw new ShareRequestError("请求来源不受信任", 403);
    const body = await readBody(request);
    await refresh();
    state = path === `${ROUTE}set` ? changeSharing(state, network, { sharing: body.sharing === true, remember: body.remember === true }) : forgetNetwork(state, String(body.id ?? ""));
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ remembered: state.remembered }, null, 2));
    settle();
    return sendJson(response, 200, status(request));
  }

  function sendJson(response, status, payload) {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify(payload));
  }

  function refuseNotShared(request, response) {
    if (String(request.headers.accept ?? "").includes("text/html")) {
      response.writeHead(403, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(NOT_SHARED_PAGE);
    } else sendJson(response, 403, { error: "MathPilot 暂未共享，请管理员在「共享办公」里打开" });
  }

  return {
    name: "mitty-lan-share",
    apply: "serve",
    enforce: "pre",
    configureServer(server) {
      log = (message) => server.config.logger.info(`\n  ${message}\n`, { timestamp: true });
      port = server.config.server?.port ?? port;
      server.httpServer?.once("listening", () => { port = server.httpServer.address()?.port ?? port; });
      ready = loadRemembered(file).then((remembered) => { state = { ...state, remembered }; return refresh(); });
      const timer = setInterval(() => { void refresh(); }, refreshMs); timer.unref?.();
      server.httpServer?.once("close", () => { clearInterval(timer); keepAwake(false); });
      server.middlewares.use((request, response, next) => {
        const remoteAddress = request.socket.remoteAddress;
        if (forgedLocalRequest({ remoteAddress, host: request.headers.host, url: request.url })) { sendJson(response, 403, { error: "请用这台电脑的局域网地址访问" }); return; }
        const local = isLoopbackAddress(remoteAddress);
        void (local ? Promise.resolve() : ready).then(() => {
          if (!local && !sharing) { refuseNotShared(request, response); return; }
          if (!request.url?.startsWith(ROUTE)) { next(); return; }
          handle(request, response).catch((error) => {
            if (response.headersSent) { response.end(); return; }
            sendJson(response, error instanceof ShareRequestError ? error.status : 500, { error: error.message || "共享设置失败" });
          });
        });
      });
    },
  };
}
