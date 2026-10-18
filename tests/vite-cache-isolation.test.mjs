import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, loadConfigFromFile } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("a database-isolated preview cannot invalidate the running editor's dependency chunks", { timeout: 60_000 }, async () => {
  const fixture = await realpath(await mkdtemp(join(tmpdir(), "mathpilot-vite-cache-")));
  const servers = [];
  const savedState = process.env.STUDIO_TEST_STATE;
  try {
    await mkdir(join(fixture, "node_modules"));
    await writeFile(join(fixture, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(join(fixture, "editor.js"), 'import { baseKeymap } from "prosemirror-commands"; export { baseKeymap };');
    // Link packages individually so this fixture never touches the live server's cache.
    for (const name of ["prosemirror-commands", "prosemirror-history", "prosemirror-keymap", "prosemirror-model", "prosemirror-state", "prosemirror-transform", "prosemirror-view", "orderedmap", "rope-sequence", "w3c-keyname"]) {
      await symlink(join(root, "node_modules", name), join(fixture, "node_modules", name), "dir");
    }
    delete process.env.STUDIO_TEST_STATE;
    const normal = (await loadConfigFromFile({ command: "serve", mode: "development" }, join(root, "vite.config.ts"), root)).config;
    process.env.STUDIO_TEST_STATE = join(fixture, "preview-state");
    const preview = (await loadConfigFromFile({ command: "serve", mode: "development" }, join(root, "vite.config.ts"), root)).config;
    if (savedState === undefined) delete process.env.STUDIO_TEST_STATE;
    else process.env.STUDIO_TEST_STATE = savedState;

    async function start(config, include) {
      const server = await createServer({
        root: fixture,
        configFile: false,
        logLevel: "silent",
        cacheDir: config.cacheDir,
        server: { host: "127.0.0.1", port: 0, hmr: false, preTransformRequests: false },
        optimizeDeps: { include, noDiscovery: true },
      });
      servers.push(server);
      await server.listen();
      const { port } = server.httpServer.address();
      return `http://127.0.0.1:${port}`;
    }

    const first = await start(normal, ["prosemirror-commands", "prosemirror-history"]);
    const source = (await servers[0].transformRequest("/editor.js")).code;
    const entry = source.match(/from\s*["']([^"']+prosemirror-commands[^"']+)["']/)?.[1];
    assert.ok(entry, `the editor imports a real optimized dependency: ${source.slice(0, 500)}`);
    const bundled = await (await fetch(new URL(entry, first))).text();
    const chunks = [...bundled.matchAll(/(?:from\s*|import\s*)["']([^"']+\.js(?:\?[^"']*)?)["']/g)].map((match) => new URL(match[1], new URL(entry, first)));
    assert.ok(chunks.length, "the dependency has shared chunks that a stale browser would request");
    // Leave these chunks cold in the first server, as when the editor is first opened later.
    for (const chunk of chunks) await access(join(servers[0].config.cacheDir, "deps", basename(chunk.pathname)));

    // A different dependency graph forces the second server to rebuild its cache.
    const second = await start(preview, ["prosemirror-commands", "prosemirror-history", "prosemirror-view"]);
    const secondSource = (await servers[1].transformRequest("/editor.js")).code;
    const secondEntry = secondSource.match(/from\s*["']([^"']+prosemirror-commands[^"']+)["']/)?.[1];
    assert.ok(secondEntry);
    assert.equal((await fetch(new URL(secondEntry, second))).status, 200);
    for (const chunk of chunks) {
      assert.equal((await fetch(chunk)).status, 200, `opening a preview must preserve the original editor's cached import ${chunk.pathname}`);
    }
  } finally {
    if (savedState === undefined) delete process.env.STUDIO_TEST_STATE;
    else process.env.STUDIO_TEST_STATE = savedState;
    await Promise.all(servers.map((server) => server.close()));
    await rm(fixture, { recursive: true, force: true });
  }
});
