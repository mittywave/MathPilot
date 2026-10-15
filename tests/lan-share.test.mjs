import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { changeSharing, describeNetwork, forgetNetwork, isSharing, lanSharePlugin, parseDefaultRoute, parseRouterMac, subnetOf } from "../scripts/lan-share.mjs";

const office = describeNetwork({ gateway: "172.20.0.1", address: "172.20.5.225", netmask: "255.255.240.0", routerMac: "00:0a:f7:9f:b7:67" });
const home = describeNetwork({ gateway: "192.168.1.1", address: "192.168.1.23", netmask: "255.255.255.0", routerMac: "a4:91:b1:00:00:01" });

test("the network is recognised by its router, with the subnet as a fallback", () => {
  assert.deepEqual(parseDefaultRoute("   route to: default\ndestination: default\n    gateway: 172.20.0.1\n  interface: en0\n"), { gateway: "172.20.0.1", iface: "en0" });
  assert.deepEqual(parseDefaultRoute("default via 192.168.1.1 dev wlp2s0 proto dhcp metric 600\n"), { gateway: "192.168.1.1", iface: "wlp2s0" });
  assert.equal(parseDefaultRoute("route: writing to routing socket: not in table"), null);
  assert.equal(parseRouterMac("? (172.20.0.1) at 0:a:f7:9f:b7:67 on en0 ifscope [ethernet]"), "00:0a:f7:9f:b7:67");
  assert.equal(parseRouterMac("192.168.1.1 dev wlp2s0 lladdr A4:91:B1:0:0:1 REACHABLE"), "a4:91:b1:00:00:01");
  assert.equal(parseRouterMac("? (172.20.0.1) at (incomplete) on en0 ifscope [ethernet]"), null);
  assert.equal(subnetOf("172.20.5.225", "255.255.240.0"), "172.20.0.0/20");
  assert.equal(subnetOf("192.168.1.23", "255.255.255.0"), "192.168.1.0/24");
  assert.deepEqual(office, { id: "router:00:0a:f7:9f:b7:67", label: "网关 172.20.0.1 · 172.20.0.0/20", address: "172.20.5.225", subnet: "172.20.0.0/20" });
  assert.equal(describeNetwork({ gateway: "10.0.0.1", address: "10.0.3.4", netmask: "255.255.0.0", routerMac: null }).id, "subnet:10.0.0.0/16@10.0.0.1");
});

test("sharing follows the network: once until restart, or every time when remembered", () => {
  const off = { session: null, remembered: [] };
  const once = changeSharing(off, office, { sharing: true, remember: false });
  assert.equal(isSharing(once, office), true);
  assert.equal(isSharing(once, home), false, "a one-off share never follows the Mac to another network");
  assert.deepEqual(once.remembered, []);
  const remembered = changeSharing(off, office, { sharing: true, remember: true }, 42);
  assert.deepEqual(remembered.remembered, [{ id: office.id, label: office.label, rememberedAt: 42 }]);
  assert.equal(isSharing({ ...remembered, session: null }, office), true, "a remembered network shares after a restart");
  assert.equal(isSharing(remembered, null), false, "no LAN, no sharing");
  assert.deepEqual(changeSharing(remembered, office, { sharing: false, remember: true }), off, "turning sharing off also forgets the network");
  assert.deepEqual(forgetNetwork(remembered, office.id), off);
  assert.throws(() => changeSharing(off, null, { sharing: true, remember: false }), /没有连接局域网/);
});

function harness(root, detected) {
  const awake = [];
  let network = detected;
  const plugin = lanSharePlugin({ root, detect: async () => network, keepAwake: (on) => awake.push(on), refreshMs: 60_000, name: "Mitty-Mac.local" });
  let handler;
  const logged = [];
  plugin.configureServer({ config: { logger: { info: (message) => logged.push(message.trim()) }, server: { port: 3001 } }, middlewares: { use: (fn) => { handler = fn; } } });
  const call = ({ remoteAddress = "127.0.0.1", host = "localhost:3001", method = "GET", url = "/", headers = {}, body } = {}) => new Promise((resolve) => {
    const response = { status: 0, headers: {}, body: "", headersSent: false,
      writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
      end(text = "") { this.body = String(text); resolve(this); } };
    const request = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, url, headers: { host, ...headers }, socket: { remoteAddress, localPort: 3001 } });
    handler(request, response, () => resolve({ passedThrough: true }));
  });
  const json = (response) => JSON.parse(response.body);
  return { call, json, awake, logged, setNetwork: (next) => { network = next; } };
}

const lan = { remoteAddress: "172.20.6.40", host: "172.20.5.225:3001" };
const set = (body, extra = {}) => ({ method: "POST", url: "/__mitty/share/set", headers: { origin: "http://localhost:3001" }, body, ...extra });

test("colleagues are turned away until sharing is on; this machine always gets through", async () => {
  const { call, json, awake } = harness(await mkdtemp(join(tmpdir(), "mitty-share-")), office);
  assert.deepEqual(await call({ url: "/tools/handouts" }), { passedThrough: true });
  const page = await call({ ...lan, headers: { accept: "text/html,application/xhtml+xml" } });
  assert.equal(page.status, 403);
  assert.match(page.body, /MathPilot 暂未共享/);
  assert.match(json(await call({ ...lan, url: "/api/library" })).error, /暂未共享/);
  assert.equal((await call({ ...lan, host: "localhost:3001" })).status, 403, "a forged loopback host is refused before anything else");

  const shared = await call(set({ sharing: true, remember: false }));
  assert.equal(shared.status, 200);
  assert.deepEqual({ sharing: json(shared).sharing, local: json(shared).local, autoHere: json(shared).autoHere }, { sharing: true, local: true, autoHere: false });
  assert.deepEqual(json(shared).addresses, ["http://Mitty-Mac.local:3001", "http://172.20.5.225:3001"]);
  assert.deepEqual(awake, [true], "the Mac is kept awake while shared");
  assert.deepEqual(await call({ ...lan, url: "/api/library" }), { passedThrough: true });
  const lanStatus = await call({ ...lan, url: "/__mitty/share/status" });
  assert.equal(json(lanStatus).local, false, "colleagues may read the status but not change it");
  assert.equal((await call({ ...lan, ...set({ sharing: false, remember: false }) })).status, 403);

  assert.equal((await call(set({ sharing: false, remember: false }))).status, 200);
  assert.deepEqual(awake, [true, false]);
  assert.equal((await call({ ...lan, url: "/api/library" })).status, 403);
});

test("only a page on this machine at a loopback name may change sharing", async () => {
  const { call } = harness(await mkdtemp(join(tmpdir(), "mitty-share-")), office);
  assert.equal((await call(set({ sharing: true, remember: false }, { host: "attacker.example:3001", headers: { origin: "http://attacker.example:3001" } }))).status, 403, "DNS rebinding keeps the attacker's host");
  assert.equal((await call(set({ sharing: true, remember: false }, { headers: { origin: "http://evil.test" } }))).status, 403);
  assert.equal((await call({ url: "/__mitty/share/unknown" })).status, 404);
});

test("a remembered office network shares again after a restart, and not at home", async () => {
  const root = await mkdtemp(join(tmpdir(), "mitty-share-"));
  const first = harness(root, office);
  assert.equal(first.json(await first.call(set({ sharing: true, remember: true }))).autoHere, true);
  assert.deepEqual(JSON.parse(await readFile(join(root, ".wrangler", "share.json"), "utf8")).remembered.map((item) => item.id), [office.id]);

  const restarted = harness(root, office);
  assert.deepEqual(await restarted.call({ ...lan, url: "/api/library" }), { passedThrough: true });
  assert.deepEqual(restarted.awake, [true]);
  assert.deepEqual(restarted.logged, ["MathPilot 已共享给同事：http://Mitty-Mac.local:3001  或  http://172.20.5.225:3001"], "the terminal says where colleagues can reach it");

  const atHome = harness(root, home);
  assert.equal((await atHome.call({ remoteAddress: "192.168.1.40", host: "192.168.1.23:3001", url: "/api/library" })).status, 403);
  const status = atHome.json(await atHome.call({ url: "/__mitty/share/status" }));
  assert.deepEqual({ sharing: status.sharing, current: status.remembered.map((item) => item.current) }, { sharing: false, current: [false] });

  const once = harness(await mkdtemp(join(tmpdir(), "mitty-share-")), office);
  await once.call(set({ sharing: true, remember: false }));
  once.setNetwork(home);
  assert.equal(once.json(await once.call({ url: "/__mitty/share/status" })).sharing, false, "leaving the network ends a one-off share");
  assert.deepEqual(once.awake, [true, false]);

  const forgot = await restarted.call({ method: "POST", url: "/__mitty/share/forget", headers: { origin: "http://localhost:3001" }, body: { id: office.id } });
  assert.deepEqual(restarted.json(forgot).remembered, []);
});
