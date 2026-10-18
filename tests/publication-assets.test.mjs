import assert from "node:assert/strict";
import test from "node:test";
import { deduplicatePublicationAssets } from "../lib/publication-assets.mjs";
import { migratedDatabase, d1 } from "./helpers/migrated-d1.mjs";
import { loadSource } from "./load-source.mjs";

const TOKEN = "synthetic-publication-regression-token";
async function publicationFixture(t) {
  const sqlite = await migratedDatabase(); t.after(() => sqlite.close());
  const base = d1(sqlite), counts = [];
  const database = { ...base, prepare(sql) {
    const statement = base.prepare(sql), bind = statement.bind;
    statement.bind = (...values) => { counts.push(values.length); assert.ok(values.length <= 100, "D1 accepts at most 100 bound parameters"); return bind(...values); };
    return statement;
  } };
  const route = await loadSource("app/api/publications/route.ts", { DB: database, PUBLIC_LIBRARY_PUBLISH_TOKEN: TOKEN, LOCAL_ADMIN_MODE: "false" });
  const request = (body, headers = { Authorization: `Bearer ${TOKEN}` }) => route.POST(new Request("https://fixture.invalid/api/publications", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  }));
  return { sqlite, request, counts };
}

test("rejected publication requests cannot fail a staging job; the authorized fail action still can", async t => {
  const f = await publicationFixture(t);
  f.sqlite.prepare("INSERT INTO library_publications(id,library_id,status,created_at) VALUES(?,'public','staging',0)").run("victim");
  for (const headers of [{ Authorization: "Bearer invalid-fixture-token" }, { Origin: "https://untrusted.invalid" }, {}]) {
    const response = await f.request({ action: "fail", publicationId: "victim" }, headers);
    assert.equal(response.status, 403);
    assert.equal(f.sqlite.prepare("SELECT status FROM library_publications WHERE id='victim'").get().status, "staging");
  }
  assert.equal((await f.request({ action: "fail", publicationId: "victim" })).status, 200);
  assert.equal(f.sqlite.prepare("SELECT status FROM library_publications WHERE id='victim'").get().status, "failed");
});

for (const count of [100, 101, 173]) test(`publication compares and commits ${count} assets within the D1 parameter limit`, async t => {
  const f = await publicationFixture(t);
  const assets = Array.from({ length: count }, (_, index) => ({ hash: (index + 1).toString(16).padStart(64, "0"), contentType: "image/png", byteSize: 1 }));
  for (const asset of assets) f.sqlite.prepare("INSERT INTO question_assets(id,content_type,byte_size,created_at,content_hash) VALUES(?,?,?,0,?)")
    .run(crypto.randomUUID(), asset.contentType, asset.byteSize, asset.hash);
  const manifest = { modules: [], categories: [], questions: [], assets };
  const begin = await f.request({ action: "begin", manifest });
  assert.equal(begin.status, 200); const pending = await begin.json();
  assert.deepEqual(pending.missingAssetHashes, []);
  const commit = await f.request({ action: "commit", publicationId: pending.publicationId, manifest, changes: { modules: [], categories: [], questions: [] } });
  assert.equal(commit.status, 200, JSON.stringify(await commit.clone().json()));
  assert.equal(f.sqlite.prepare("SELECT active_publication_id FROM libraries_v2 WHERE id='public'").get().active_publication_id, pending.publicationId);
  assert.ok(Math.max(...f.counts) <= 100);
});

test("a missing asset blocks activation and a legitimate publisher can explicitly fail the job", async t => {
  const f = await publicationFixture(t), hash = "a".repeat(64);
  const manifest = { modules: [], categories: [], questions: [], assets: [{ hash, contentType: "image/png", byteSize: 1 }] };
  const before = f.sqlite.prepare("SELECT active_publication_id FROM libraries_v2 WHERE id='public'").get().active_publication_id;
  const pending = await (await f.request({ action: "begin", manifest })).json();
  assert.deepEqual(pending.missingAssetHashes, [hash]);
  assert.equal((await f.request({ action: "commit", publicationId: pending.publicationId, manifest, changes: { modules: [], categories: [], questions: [] } })).status, 409);
  assert.equal(f.sqlite.prepare("SELECT active_publication_id FROM libraries_v2 WHERE id='public'").get().active_publication_id, before);
  assert.equal((await f.request({ action: "fail", publicationId: pending.publicationId })).status, 200);
});

test("publishes one asset manifest entry when legacy asset IDs share identical content", () => {
  const shared = "a".repeat(64);
  const unique = "b".repeat(64);
  const result = deduplicatePublicationAssets([
    { localId: "first", hash: shared, contentType: "image/png", byteSize: 10 },
    { localId: "second", hash: shared, contentType: "image/png", byteSize: 10 },
    { localId: "third", hash: unique, contentType: "image/jpeg", byteSize: 20 },
  ]);

  assert.deepEqual(result, [
    { localId: "first", hash: shared, contentType: "image/png", byteSize: 10 },
    { localId: "third", hash: unique, contentType: "image/jpeg", byteSize: 20 },
  ]);
});
