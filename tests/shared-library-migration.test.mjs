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


test("question codes backfill all versions and remain unique after deletion, retries and new publications", async () => {
  const db = new DatabaseSync(":memory:");
  await migrate(db, "0028");
  const insert = db.prepare(`INSERT INTO library_questions_v2
    (row_id, source_id, library_id, publication_id, module_source_id, payload_json, created_at, updated_at)
    VALUES (?, ?, 'public', ?, 'test-module', '{}', ?, 0) ON CONFLICT DO NOTHING`);
  insert.run('a', 'qa', 'v1', 1);
  insert.run('b', 'qb', 'v1', 2);
  insert.run('c', 'qa', 'v2', 1);
  db.exec(await readFile(new URL("0028_question_codes.sql", MIGRATIONS), "utf8"));
  const code = id => db.prepare("SELECT printf('%04d', number) AS code FROM question_codes WHERE question_id = ?").get(id)?.code;
  assert.equal(code('qa'), '0001');
  assert.equal(code('qb'), '0002');
  insert.run('d', 'qa', 'v3', 1);
  insert.run('d', 'qa', 'v3', 1);
  db.exec("UPDATE library_questions_v2 SET deleted_at = 1 WHERE source_id = 'qa'");
  db.exec("UPDATE library_questions_v2 SET deleted_at = NULL WHERE source_id = 'qa'");
  assert.equal(code('qa'), '0001');
  db.exec("DELETE FROM library_questions_v2 WHERE source_id = 'qb'");
  insert.run('e', 'qc', 'v1', 3);
  assert.equal(code('qc'), '0003');
  assert.equal(code('qb'), '0002', 'permanently deleted codes remain reserved');
  insert.run('f', 'qb', 'v2', 2);
  assert.equal(code('qb'), '0002');
  assert.throws(() => db.prepare('INSERT INTO question_codes (number, question_id) VALUES (1, ?)').run('duplicate'));
  db.exec("UPDATE sqlite_sequence SET seq = 9999 WHERE name = 'question_codes'");
  insert.run('g', 'qd', 'v1', 4);
  assert.equal(code('qd'), '10000', 'overflow must never wrap to another question');
  db.close();
});
