import test from "node:test";
import assert from "node:assert/strict";
import { loadSource } from "./load-source.mjs";

const { droppedImage, recognizeScreenshot } = await loadSource("lib/screenshot-recognition.ts");
const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVQIHWP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

test("dropping files picks the first image and ignores everything else", () => {
  const png = { name: "k.png", type: "image/png" };
  assert.equal(droppedImage({ dataTransfer: { files: [{ name: "a.txt", type: "text/plain" }, png] } }), png);
  assert.equal(droppedImage({ dataTransfer: { files: [{ name: "a.pdf", type: "application/pdf" }] } }), null);
  assert.equal(droppedImage({ dataTransfer: null }), null);
});

test("both screenshot entries share request shape and error wording", async t => {
  const OriginalImage = globalThis.Image; const originalFetch = globalThis.fetch;
  // A small screenshot needs no resizing, so only image decoding and the request are stubbed.
  globalThis.Image = class { naturalWidth = 120; naturalHeight = 80; set src(_value) { queueMicrotask(() => this.onload()); } };
  t.after(() => { globalThis.fetch = originalFetch; if (OriginalImage === undefined) delete globalThis.Image; else globalThis.Image = OriginalImage; });
  const reply = (body, status = 200) => async (url, init) => { reply.last = { url, body: JSON.parse(init.body) }; return new Response(typeof body === "string" ? body : JSON.stringify(body), { status }); };

  globalThis.fetch = reply({ result: { blocks: [] } });
  assert.deepEqual(await recognizeScreenshot("/api/recognize-note", image), { blocks: [] });
  assert.deepEqual(reply.last, { url: "/api/recognize-note", body: { image } });

  globalThis.fetch = reply({ result: { stem: "x" } });
  await recognizeScreenshot("/api/recognize", image, { categories: [{ id: "c", path: "初二" }] });
  assert.deepEqual(reply.last.body, { categories: [{ id: "c", path: "初二" }], image });

  globalThis.fetch = reply({ error: "尚未配置", code: "MISSING_API_KEY" }, 503);
  await assert.rejects(recognizeScreenshot("/api/recognize-note", image), /智能识别尚未配置。请检查本地 Sub2API 地址、Key 和视觉模型。/);
  globalThis.fetch = reply({ error: "模型繁忙" }, 502);
  await assert.rejects(recognizeScreenshot("/api/recognize", image), /模型繁忙/);
  globalThis.fetch = reply("<html>gateway</html>", 502);
  await assert.rejects(recognizeScreenshot("/api/recognize", image), /识别失败，请重试/);
});
