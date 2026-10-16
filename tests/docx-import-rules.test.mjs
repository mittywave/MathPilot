import assert from "node:assert/strict";
import test from "node:test";
import { docxInferredQuestionType, docxQuestionHeading, docxStudioRole, docxTitleLine, docxVmlPicturesToDrawing, isDocxOptionBlock, normalizedDocxPageLookup, splitDocxOptionBlocks } from "../lib/docx-import-rules.mjs";
import { crossPageRepeat, numberedImportTarget, orderedImportTimestamp, retainedQuestionCreatedAt } from "../lib/question-order-rules.mjs";

test("splits four DOCX options stored in one paragraph", () => {
  assert.deepEqual(splitDocxOptionBlocks(["A．1 B．2 C．3 D．4"]), ["1", "2", "3", "4"]);
  assert.deepEqual(splitDocxOptionBlocks(["A．+35mVB．-35mVC．+30mVD．+70mV"]), ["+35mV", "-35mV", "+30mV", "+70mV"]);
});

test("collects DOCX options across two or four paragraphs", () => {
  assert.deepEqual(splitDocxOptionBlocks(["A．甲 B．乙", "C．丙 D．丁"]), ["甲", "乙", "丙", "丁"]);
  assert.deepEqual(splitDocxOptionBlocks(["A．甲", "B．乙", "C．丙", "D．丁"]), ["甲", "乙", "丙", "丁"]);
});

test("classifies only leading option blocks so options can be removed from the stem", () => {
  const blocks = ["1．下列结论正确的是（　　）", "补充条件 A 不等于零。", "A．甲 B．乙", "C．丙 D．丁"];
  const optionBlocks = blocks.filter(isDocxOptionBlock);
  assert.deepEqual(optionBlocks, ["A．甲 B．乙", "C．丙 D．丁"]);
  assert.deepEqual(blocks.filter((block) => !optionBlocks.includes(block)), ["1．下列结论正确的是（　　）", "补充条件 A 不等于零。"]);
});

test("normalizes the complete rendered page and lets the caller shorten only the lookup key", () => {
  const prefix = "这是超过四十八个字符的题干".repeat(5);
  const suffix = "唯一页尾标记";
  const normalized = normalizedDocxPageLookup(`${prefix}，${suffix}`);
  assert.ok(normalized.length > 48);
  assert.ok(normalized.endsWith(suffix));
  assert.equal(normalizedDocxPageLookup(` $x^2$ ${prefix}，${suffix}`), normalized);
});

test("keeps document order when concurrently saved questions are sorted newest first", () => {
  const startedAt = 2_000_000;
  const timestamps = Array.from({ length: 20 }, (_, index) => orderedImportTimestamp(startedAt, index));
  assert.deepEqual([...timestamps].sort((a, b) => b - a), timestamps);
  assert.equal(retainedQuestionCreatedAt(timestamps[19], startedAt), timestamps[19]);
  assert.equal(retainedQuestionCreatedAt(0, startedAt), startedAt);
  assert.equal(retainedQuestionCreatedAt(startedAt + 1, startedAt), startedAt);
});

test("sections that restart their numbering keep every question; only a page-break repeat is suspect", () => {
  // S8 寒创讲义 pages 3–4: 例题精练 1–3 on each page, read as bare numbers.
  const last = { pageNumber: 1, type: "解答题", number: "3" };
  assert.equal(crossPageRepeat(last, { pageNumber: 2, type: "解答题", number: "1" }, true), false);
  assert.equal(crossPageRepeat(last, { pageNumber: 2, type: "解答题", number: "3" }, true), true, "the next page starts with the same question");
  assert.equal(crossPageRepeat(last, { pageNumber: 2, type: "解答题", number: "3" }, false), false, "only the first question of a page");
  assert.equal(crossPageRepeat(last, { pageNumber: 3, type: "解答题", number: "3" }, true), false, "pages must be adjacent");
  assert.equal(crossPageRepeat(last, { pageNumber: 2, type: "填空题", number: "3" }, true), false);
  assert.equal(crossPageRepeat({ ...last, number: "" }, { pageNumber: 2, type: "解答题", number: "" }, true), false);
  assert.equal(crossPageRepeat(undefined, { pageNumber: 1, type: "解答题", number: "1" }, true), false);
});

test("answers go to the one question with that number, never to the first of several", () => {
  const items = [{ documentNumber: "1", selected: true }, { documentNumber: "2", selected: true }, { documentNumber: "1", selected: true }, { documentNumber: "2", selected: false }];
  assert.deepEqual(numberedImportTarget(items, "2"), { target: items[1], clash: [] }, "an unselected page-break repeat does not count");
  assert.deepEqual(numberedImportTarget(items, "1"), { target: undefined, clash: [items[0], items[2]] });
  assert.deepEqual(numberedImportTarget(items, "3"), { target: undefined, clash: [] });
  assert.deepEqual(numberedImportTarget([{ documentNumber: "", selected: true }], ""), { target: undefined, clash: [] });
});

// Paragraphs as 文件转录 writes them (S8寒创讲义_压缩版_10MB以内_题目版.docx).
const boldLine = (text) => `<w:p><w:pPr><w:keepNext/><w:spacing w:after="120" w:before="240"/></w:pPr><w:r><w:rPr><w:b/><w:bCs/><w:color w:val="000000"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const plainLine = (text) => `<w:p><w:r><w:rPr><w:bCs/></w:rPr><w:t>${text}</w:t></w:r></w:p>`;
const vmlPicture = (inner = "") => `<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:pict xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><v:group id="studio0" style="width:105.3pt;height:100pt" coordorigin="-12,-12" coordsize="457,434"><v:rect id="studio0_base" style="position:absolute;left:0;top:0;width:433;height:410" stroked="f"><v:imagedata r:id="rIdStudio4" o:title="原题底图"/></v:rect>${inner}</v:group></w:pict></w:r></w:p>`;

test("讲义 question headings name a section and a number on a short bold line", () => {
  for (const [text, label, number] of [["例题精练 1", "例题精练", "1"], ["例题精练2 1", "例题精练2", "1"], ["知识拼接 1 1", "知识拼接 1", "1"], ["例题 6-1", "例题", "6-1"], ["自主练习 7", "自主练习", "7"]]) {
    assert.deepEqual(docxQuestionHeading(text, boldLine(text)), { label, number }, text);
  }
  assert.equal(docxQuestionHeading("例题精练 1", plainLine("例题精练 1")), null, "a heading is bold");
  assert.equal(docxQuestionHeading("图 1", boldLine("图 1")), null, "a figure caption is not a heading");
  assert.equal(docxQuestionHeading("五心综合", boldLine("五心综合")), null);
  assert.equal(docxQuestionHeading("求证：1", boldLine("求证：1")), null);
  assert.equal(docxQuestionHeading("在 中，AC=3", boldLine("在 中，AC=3") .replace("</w:r>", "</w:r><m:oMath/>")), null);
  assert.equal(docxQuestionHeading("例题精练 1", boldLine("例题精练 1").replace("<w:b/>", '<w:b w:val="0"/>')), null);
  assert.equal(docxTitleLine("五心综合", boldLine("五心综合")), true, "a lesson title closes the question above it");
  assert.equal(docxTitleLine("例题精练 1", boldLine("例题精练 1")), false);
  assert.equal(docxTitleLine("求证：", boldLine("求证：")), false);
});

test("without a 题型 section the type comes from options and blanks", () => {
  assert.equal(docxInferredQuestionType([{ text: "下列说法正确的是（　　）", xml: "" }], 4), "单选题");
  assert.equal(docxInferredQuestionType([{ text: "那么外接圆半径是_______．", xml: "" }], 0), "填空题");
  assert.equal(docxInferredQuestionType([{ text: "则 ∠A 的度数为　．", xml: '<w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t xml:space="preserve">      </w:t></w:r>' }], 0), "填空题");
  assert.equal(docxInferredQuestionType([{ text: "求 △ABC 的外接圆面积．", xml: "" }], 0), "解答题");
});

test("文件转录 solution and note paragraphs are told apart from the stem", () => {
  assert.equal(docxStudioRole("解：连接 OA", '<w:p><w:pPr><w:pStyle w:val="StudioAnswer"/></w:pPr></w:p>'), "analysis");
  assert.equal(docxStudioRole("$x=2$", '<w:p><w:pPr><w:pStyle w:val="StudioMathAnswer"/></w:pPr></w:p>'), "analysis");
  assert.equal(docxStudioRole("转录提示：第 3 页右下角模糊", '<w:p><w:pPr><w:pStyle w:val="StudioAnswer"/></w:pPr></w:p>'), "warning");
  assert.equal(docxStudioRole("已知 O 为外心", '<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr></w:p>'), null);
});

test("VML pictures become inline DrawingML pictures of the same size", () => {
  const { xml, pictures, overlays } = docxVmlPicturesToDrawing(vmlPicture(), 7);
  assert.equal(pictures, 1); assert.equal(overlays, 0);
  assert.doesNotMatch(xml, /<w:pict|v:imagedata/);
  assert.match(xml, /<w:r><w:drawing><wp:inline [^>]*><wp:extent cx="1337310" cy="1270000"\/><wp:docPr id="7"/);
  assert.match(xml, /<a:blip xmlns:r="[^"]+" r:embed="rIdStudio4"\/>/);
  assert.match(xml, /^<w:p><w:pPr><w:jc w:val="center"\/><\/w:pPr><w:r><w:drawing>/, "the paragraph and its alignment stay");
  assert.equal(docxVmlPicturesToDrawing(vmlPicture('<v:line from="0,0" to="10,10"/><v:textbox>A</v:textbox>')).overlays, 1, "labels drawn over a picture are reported");
  const plain = '<w:p><w:r><w:pict><v:shapetype id="_x0000_t75"/><v:shape style="width:2in;height:1in"><v:imagedata r:id="rId9"/></v:shape></w:pict></w:r></w:p>';
  const word = docxVmlPicturesToDrawing(plain);
  assert.equal(word.overlays, 0); assert.match(word.xml, /cx="1828800" cy="914400"/);
  const noPicture = '<w:p><w:r><w:pict><v:line from="0,0" to="1,1"/></w:pict></w:r></w:p>';
  assert.deepEqual(docxVmlPicturesToDrawing(noPicture), { xml: noPicture, pictures: 0, overlays: 0 });
});
