import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { contentFingerprint } from "../lib/content-fingerprint.mjs";

test("secure origins fingerprint page images with SHA-256", async () => {
  const image = "data:image/jpeg;base64,/9j/4AAQ";
  assert.equal(await contentFingerprint(image), createHash("sha256").update(image).digest("hex"));
});

test("plain-http LAN origins get a stable fallback fingerprint", async () => {
  const insecure = {};
  const first = await contentFingerprint("data:image/jpeg;base64,AAAA", insecure);
  assert.match(first, /^c53-[0-9a-f]{28}$/);
  assert.equal(await contentFingerprint("data:image/jpeg;base64,AAAA", insecure), first, "the same page keeps its identity");
  const seen = new Set();
  for (let index = 0; index < 2000; index += 1) seen.add(await contentFingerprint(`data:image/jpeg;base64,${index}`, insecure));
  assert.equal(seen.size, 2000, "different pages do not collide");
});
