import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS = new URL("../../migrations/", import.meta.url);

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
        execute() { const prepared = sqlite.prepare(sql); return { success: true, results: prepared.columns().length ? prepared.all(...args) : (prepared.run(...args), []) }; },
      };
      return statement;
    },
    async batch(statements) { sqlite.exec("BEGIN"); try { const results = statements.map((statement) => statement.execute()); sqlite.exec("COMMIT"); return results; } catch (error) { sqlite.exec("ROLLBACK"); throw error; } },
  };
}
