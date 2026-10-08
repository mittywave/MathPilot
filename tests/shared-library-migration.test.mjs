import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const MIGRATIONS = new URL("../migrations/", import.meta.url);

async function migrate(db, until) {
  for (const name of (await readdir(MIGRATIONS)).filter((file) => file.endsWith(".sql")).sort()) {
    if (name >= until) break;
    db.exec(await readFile(new URL(name, MIGRATIONS), "utf8"));
  }
}

test("0021 folds every personal library and handout reference into the shared library", async () => {
  const db = new DatabaseSync(":memory:");
  await migrate(db, "0021");
  const publication = db.prepare("SELECT active_publication_id AS id FROM libraries_v2 WHERE id = 'public'").get().id;
  db.exec(`
    INSERT INTO users (id, email, password_hash, password_salt, password_iterations, role, created_at) VALUES ('u1', 'one@test', 'h', 's', 1, 'member', 0);
    INSERT INTO libraries_v2 (id, kind, owner_user_id, created_at) VALUES ('personal:u1', 'personal', 'u1', 0);
    INSERT INTO library_modules_v2 (row_id, source_id, library_id, publication_id, name, created_at, updated_at) VALUES ('personal:u1:personal:module:m1', 'm1', 'personal:u1', NULL, '私人模块', 0, 0);
    INSERT INTO library_categories_v2 (row_id, source_id, library_id, publication_id, module_source_id, name, created_at) VALUES ('personal:u1:personal:category:c1', 'c1', 'personal:u1', NULL, 'm1', '私人分类', 0);
    INSERT INTO library_questions_v2 (row_id, source_id, library_id, publication_id, module_source_id, category_source_id, payload_json, created_at, updated_at) VALUES ('personal:u1:personal:question:q1', 'q1', 'personal:u1', NULL, 'm1', 'c1', '{}', 0, 0);
    INSERT INTO question_assets (id, content_type, byte_size, created_at) VALUES ('a1', 'image/png', 1, 0);
    INSERT INTO asset_library_access (access_key, asset_id, library_id, publication_id, created_at) VALUES ('personal:u1|personal|a1', 'a1', 'personal:u1', NULL, 0);
    INSERT INTO handouts (id, owner_user_id, title, items_json, created_at, updated_at) VALUES ('h1', 'u1', '讲义', '[{"id":"i1","kind":"question","scope":"mine","questionId":"q1","band":"example"}]', 0, 0);
  `);
  db.exec(await readFile(new URL("0021_shared_library.sql", MIGRATIONS), "utf8"));

  for (const table of ["library_modules_v2", "library_categories_v2", "library_questions_v2"]) {
    const rows = db.prepare(`SELECT library_id, publication_id, row_id FROM ${table} WHERE source_id IN ('m1', 'c1', 'q1')`).all();
    assert.equal(rows.length, 1, table);
    assert.equal(rows[0].library_id, "public");
    assert.equal(rows[0].publication_id, publication);
    assert.match(rows[0].row_id, new RegExp(`^public:${publication}:(module|category|question):`));
  }
  assert.ok(db.prepare("SELECT 1 FROM asset_library_access WHERE asset_id = 'a1' AND library_id = 'public' AND publication_id = ?").get(publication), "figures stay readable");
  assert.match(db.prepare("SELECT items_json FROM handouts WHERE id = 'h1'").get().items_json, /"scope":"public","questionId":"q1"/);
});
