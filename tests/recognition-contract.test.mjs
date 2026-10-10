import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const recognitionBuild = await build({ entryPoints: ["lib/recognition-contract.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const {
  batchRecognitionSchema,
  buildBatchRecognitionPrompt,
  buildSingleRecognitionPrompt,
  commonRecognitionRequirements,
  normalizeBatchRecognitionResult,
  normalizeSingleRecognitionResult,
  recognitionQuestionSchema,
  singleRecognitionSchema,
} = await import("data:text/javascript;base64," + Buffer.from(recognitionBuild.outputFiles[0].text).toString("base64"));
import { hasUsableRecognitionDiagramBox, MIN_RECOGNITION_DIAGRAM_EDGE, shouldReconstructRecognizedDiagram } from "../lib/recognition-diagram-rules.mjs";
import { recognitionReasoningEffort } from "../lib/server/recognition-model-rules.mjs";

const categories = [{ id: "equation", path: "七年级数学 / 一元一次方程" }];

test("single and batch recognition use one shared question schema", () => {
  const single = singleRecognitionSchema;
  const batchQuestion = batchRecognitionSchema.properties.questions.items;
  const batchProperties = Object.fromEntries(Object.entries(batchQuestion.properties).filter(([name]) => name !== "question_number"));
  assert.deepEqual(batchProperties, single.properties);
  assert.deepEqual(batchQuestion.required.filter((field) => field !== "question_number"), single.required);
  assert.deepEqual(recognitionQuestionSchema(), single);
  assert.equal(batchQuestion.additionalProperties, false);
  assert.equal(single.additionalProperties, false);
});

test("single screenshots and PDF pages receive every shared formula and diagram rule", () => {
  const single = buildSingleRecognitionPrompt(categories);
  const batch = buildBatchRecognitionPrompt({ categories, fileName: "回归.pdf", pageNumber: 2, textHint: "2．计算分式" });
  for (const requirement of commonRecognitionRequirements) {
    assert.ok(single.includes(requirement));
    assert.ok(batch.includes(requirement));
  }
  assert.match(single, /不得用图片代替公式/);
  assert.match(batch, /不得用图片代替公式/);
  assert.match(batch, /answers 只放答案表或解析区/);
  assert.doesNotMatch(single, /answers 只放答案表或解析区/);
  assert.match(batch, /第 2 页/);
});

test("single and batch results pass through the same normalization contract", () => {
  const raw = {
    type: "单选题", difficulty: "基础", stem: "  计算 x＝1  ", options: ["A. 1", "B．2", "B．2", ""],
    answer: "answer", analysis: "截图中没有明确解析，因此解析字段留空。", source: "  2026·深圳  ", tags: ["方程", "方程", "一次方程"],
    suggested_category_id: "equation", diagram_bbox: { x: -10, y: 950, width: 1_100, height: 100 },
    diagram_quality: { score: 1.4, reconstructable: true, kind: "function", issues: ["拍照倾斜", "拍照倾斜"], capture: "photo", rotation: "90" },
    confidence: 1.2, warnings: ["请核对", "请核对"],
  };
  const single = normalizeSingleRecognitionResult(raw, categories);
  const batch = normalizeBatchRecognitionResult({ questions: [{ ...raw, question_number: " 12 " }], answers: [] }, categories).questions[0];
  const { question_number, ...batchQuestion } = batch;
  assert.equal(question_number, "12");
  assert.deepEqual(batchQuestion, single);
  assert.deepEqual(single.options, ["1", "2"]);
  assert.equal(single.answer, "");
  assert.equal(single.analysis, "");
  assert.deepEqual(single.diagram_bbox, { x: 0, y: 950, width: 1_000, height: 50 });
  assert.equal(single.diagram_quality.rotation, 90);
  assert.equal(single.diagram_quality.score, 1);
  assert.equal(single.confidence, 1);
});

test("normalization rejects stale categories and clears diagram quality without a valid crop", () => {
  const normalized = normalizeSingleRecognitionResult({
    type: "填空题", difficulty: "中等", stem: "x＝____", options: ["不应保留"], answer: "1", analysis: "", source: "", tags: [],
    suggested_category_id: "missing", diagram_bbox: { x: 1_000, y: 1_000, width: 20, height: 20 },
    diagram_quality: { score: .5, reconstructable: true, kind: "geometry", issues: [], capture: "scan", rotation: "0" }, confidence: .8, warnings: [],
  }, categories);
  assert.equal(normalized.suggested_category_id, null);
  assert.deepEqual(normalized.options, []);
  assert.equal(normalized.diagram_bbox, null);
  assert.equal(normalized.diagram_quality, null);
});

test("single and PDF diagram extraction share one minimum box and reconstruction gate", () => {
  assert.equal(MIN_RECOGNITION_DIAGRAM_EDGE, 20);
  assert.equal(hasUsableRecognitionDiagramBox({ x: 0, y: 0, width: 20, height: 20 }), true);
  assert.equal(hasUsableRecognitionDiagramBox({ x: 0, y: 0, width: 19.9, height: 20 }), false);
  const photographed = { score: .95, reconstructable: true, kind: "geometry", issues: [], capture: "photo", rotation: 0 };
  assert.equal(shouldReconstructRecognizedDiagram("data:image/png;base64,AA==", photographed), true);
  assert.equal(shouldReconstructRecognizedDiagram("data:image/png;base64,AA==", { ...photographed, capture: "digital", score: 1 }), false);
  assert.equal(shouldReconstructRecognizedDiagram(undefined, photographed), false);
});

test("recognition reasoning effort is shared by both API routes", () => {
  assert.equal(recognitionReasoningEffort("low"), "low");
  assert.equal(recognitionReasoningEffort("max"), "max");
  assert.equal(recognitionReasoningEffort("unsupported"), "low");
});

test("a recognized diagram box keeps every figure whole and leaves the question text out", async () => {
  const { PNG } = await import("pngjs");
  const { readFileSync } = await import("node:fs");
  const { loadSource } = await import("./load-source.mjs");
  const { diagramInk } = await loadSource("lib/image-tools.ts");
  // A real single-question screenshot: two lines of stem, 图1 and 图2 side by side, a page frame around it all.
  const { data, width, height } = PNG.sync.read(readFileSync("tests/fixtures/screenshot-layout-two-figures.png"));
  // diagram_bbox the model returned for it (0–1000), in pixels.
  const box = { x: 51, y: 204, width: 462, height: 397 };
  const target = { minX: Math.floor(box.x / 1000 * width), minY: Math.floor(box.y / 1000 * height), maxX: Math.ceil((box.x + box.width) / 1000 * width), maxY: Math.ceil((box.y + box.height) / 1000 * height) };
  const ink = diagramInk(data, width, height, target);
  const isInk = (x, y) => { const o = (y * width + x) * 4; return data[o] * .299 + data[o + 1] * .587 + data[o + 2] * .114 < 160; };
  const kept = (x0, y0, x1, y1) => { let total = 0; let left = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (isInk(x, y)) { total++; if (!ink.foreign[y * width + x]) left++; } return { total, left }; };
  // 图1 (triangle, x 94–433) and 图2 (axes and curves, x 445–940) with their labels and captions all fit inside.
  assert.ok(ink.rect.minX <= 94 && ink.rect.maxX >= 941 && ink.rect.minY <= 167 && ink.rect.maxY >= 485, JSON.stringify(ink.rect));
  for (const figure of [[94, 167, 434, 485], [445, 167, 941, 485]]) { const { total, left } = kept(...figure); assert.ok(total > 1000); assert.equal(left, total); }
  // The stem line just above (ending at y 156) and the page frame stay out of the picture.
  assert.ok(ink.rect.maxX < 1000);
  const stem = kept(ink.rect.minX, ink.rect.minY, ink.rect.maxX, 157);
  assert.equal(stem.left, 0);
});

test("a box that stops mid-drawing still yields the whole figure; picture options are cut as one row", async () => {
  const { PNG } = await import("pngjs");
  const { readFileSync } = await import("node:fs");
  const { loadSource } = await import("./load-source.mjs");
  const { diagramInk } = await loadSource("lib/image-tools.ts");
  // A cube net at the top right (bottom row D, F at y≈165–230), four cube drawings A–D as options below.
  const { data, width, height } = PNG.sync.read(readFileSync("tests/fixtures/screenshot-picture-options.png"));
  const pixels = (box) => ({ minX: Math.floor(box.x / 1000 * width), minY: Math.floor(box.y / 1000 * height), maxX: Math.ceil((box.x + box.width) / 1000 * width), maxY: Math.ceil((box.y + box.height) / 1000 * height) });
  // Two boxes the model actually returned for this screenshot; the second stops halfway down the net.
  for (const box of [{ x: 816, y: 64, width: 164, height: 303 }, { x: 818, y: 38, width: 162, height: 222 }]) {
    const net = diagramInk(data, width, height, pixels(box));
    assert.ok(net.rect.maxY >= 230, `the D/F row is kept: ${JSON.stringify(net.rect)}`);
    assert.ok(net.rect.minX > 1300, "the stem text on the left stays out");
  }
  const options = diagramInk(data, width, height, pixels({ x: 16, y: 605, width: 866, height: 305 }));
  assert.ok(options.rect.minX <= 35 && options.rect.maxX >= 1515 && options.rect.minY >= 240, `all four options and their letters, nothing above: ${JSON.stringify(options.rect)}`);
});

test("tick labels under a number line stay with the figure even when the box stops at the axis", async () => {
  const { PNG } = await import("pngjs");
  const { readFileSync } = await import("node:fs");
  const { loadSource } = await import("./load-source.mjs");
  const { diagramInk } = await loadSource("lib/image-tools.ts");
  // A ruler over a number line; labels −4 … 4 at y≈250–276, the options row at y≈355, stem text above y≈112.
  const { data, width, height } = PNG.sync.read(readFileSync("tests/fixtures/screenshot-number-line.png"));
  const box = { x: 22, y: 308, width: 435, height: 269 };
  const ink = diagramInk(data, width, height, { minX: Math.floor(box.x / 1000 * width), minY: Math.floor(box.y / 1000 * height), maxX: Math.ceil((box.x + box.width) / 1000 * width), maxY: Math.ceil((box.y + box.height) / 1000 * height) });
  assert.ok(ink.rect.maxY >= 276, `the −4 … 4 labels are kept: ${JSON.stringify(ink.rect)}`);
  assert.ok(ink.rect.maxY < 340 && ink.rect.minY > 112, "neither the options nor the stem come along");
});
