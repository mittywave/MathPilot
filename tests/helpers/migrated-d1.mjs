import { readdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);

/** The documented, privileged first-admin bootstrap against an isolated fixture only. */
export function bootstrapAdmin(state, userId) {
  if (!/^[0-9a-f-]{36}$/.test(userId) || !state.startsWith(tmpdir())) throw new Error("Expected synthetic account and isolated database");
  const result = spawnSync("./node_modules/.bin/wrangler", ["d1", "execute", "DB", "--local", "--persist-to", state, "--config", "wrangler.jsonc", "--command",
    `UPDATE users SET role='admin' WHERE id='${userId}' AND role='member' AND disabled_at IS NULL AND NOT EXISTS (SELECT 1 FROM users WHERE role='admin' AND disabled_at IS NULL)`], { encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  if (result.status !== 0) throw new Error(result.stdout + result.stderr);
}

/** Real local D1/R2 for fault injection and query measurements; never opens a live database. */
export async function localD1(t) {
  const state = await mkdtemp(join(tmpdir(), "mathpilot-d1-regression-"));
  const require = createRequire(import.meta.url);
  const { Miniflare } = createRequire(require.resolve("wrangler"))("miniflare");
  const migrated = spawnSync("./node_modules/.bin/wrangler", ["d1", "migrations", "apply", "DB", "--local", "--persist-to", state, "--config", "wrangler.jsonc"], { encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  if (migrated.status !== 0) throw new Error(migrated.stdout + migrated.stderr);
  const config = JSON.parse(await readFile("dist/server/wrangler.json", "utf8"));
  const mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('isolated fixture'); } }", cf: false,
    d1Databases: { DB: config.d1_databases.find(binding => binding.binding === "DB").database_id }, d1Persist: join(state, "v3/d1"), r2Buckets: ["ASSETS"] });
  t.after(async () => { await mf.dispose(); await rm(state, { recursive: true, force: true }); });
  return { db: await mf.getD1Database("DB"), bucket: await mf.getR2Bucket("ASSETS") };
}

/** An in-memory database with every migration applied, as the app's local D1 has. */
export async function migratedDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys=ON;");
  for (const name of (await readdir(MIGRATIONS)).filter((file) => file.endsWith(".sql")).sort()) sqlite.exec(await readFile(new URL(name, MIGRATIONS), "utf8"));
  return sqlite;
}

/** Actual SQLite behind the D1 method shape the server modules use; a batch is one transaction. */
export function d1(sqlite) {
  return {
    prepare(sql) {
      let args = [];
      const statement = {
        bind(...values) { args = values; return statement; },
        async first() { return sqlite.prepare(sql).get(...args) ?? null; },
        async all() { return { success: true, results: sqlite.prepare(sql).all(...args) }; },
        async run() { const result = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: result.changes } }; },
        execute() {
          const prepared = sqlite.prepare(sql);
          if (prepared.columns().length) return { success: true, results: prepared.all(...args), meta: { changes: 0 } };
          const result = prepared.run(...args);
          return { success: true, results: [], meta: { changes: result.changes } };
        },
      };
      return statement;
    },
    async batch(statements) { sqlite.exec("BEGIN"); try { const results = statements.map((statement) => statement.execute()); sqlite.exec("COMMIT"); return results; } catch (error) { sqlite.exec("ROLLBACK"); throw error; } },
  };
}
