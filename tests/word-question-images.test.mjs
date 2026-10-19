import assert from "node:assert/strict";
import test from "node:test";
import { standaloneWordQuestionImages } from "../lib/word-question-images.mjs";

test("keeps supplementary images when a question also has raw Word stem XML", () => {
  assert.deepEqual(standaloneWordQuestionImages({
    stemDocxXml: ["<w:tbl/>"],
    contentImages: ["/api/assets/supplementary"],
  }), ["/api/assets/supplementary"]);
});

test("does not duplicate an image already embedded by the raw Word stem", () => {
  assert.deepEqual(standaloneWordQuestionImages({
    contentImages: ["/api/assets/embedded", "/api/assets/separate", "/api/assets/separate"],
    diagramImage: "/api/assets/separate",
    stemDocxAssets: { rId5: "/api/assets/embedded" },
  }), ["/api/assets/separate"]);
});

test("raw Word option pictures are not exported a second time as stem figures", () => {
  const q={optionsDocxXml:['<w:p/>'],optionsDocxAssets:{a:'/choice'},contentImages:['/choice','/stem']};
  assert.deepEqual(standaloneWordQuestionImages(q),['/stem']);
  assert.deepEqual(standaloneWordQuestionImages({...q,optionsDocxXml:undefined}),['/choice','/stem']);
});
