import { loadSource } from './load-source.mjs';
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { automaticQuestionImageLayout, isCompactConclusionChoice, markDocxUnderline, optionColumnCount, splitDisplayUnderlines } from "../lib/question-presentation-rules.mjs";
import { isSafeGeoGebraCommand, scoreDiagramVisualFit, validateGeoGebraPlan } from "../lib/geogebra-reconstruction.mjs";
import { combineDiagramRasterFit, scoreProjectionProfiles, shouldAutoVectorizeDiagram, validateVectorDiagramPlan } from "../lib/vector-diagram-reconstruction.mjs";
import { correctionForCapturedRotation, fitWithinMaxEdge, isPhotographedDiagram, normalizeDiagramRotation } from "../lib/image-processing-rules.mjs";
import { cleanRecognizedAnalysis, cleanRecognizedAnswer } from "../lib/recognition-cleanup.mjs";
const { fractionSizeClass, latexFractionDepth, splitMathText, toLatexMath, toReadableNestedFractionLatex } = await loadSource("lib/math-text.ts");
import { needsWordMathEquation, normalizeMathNotation } from "../lib/math-notation.mjs";
const { orthogonalizeCoordinatePlan, printReadyInkColor, regularizeQuadraticFunctionPlan, svgFromVectorDiagramPlan, vectorDiagramAspectRatio } = await loadSource("lib/vector-diagram-renderer.ts");
import { ensureWordMathSettings, fullSizeInlineFractions, wordMathFractionDepth } from "../lib/word-math-sizing.mjs";
import { ALEVEL_PAGE_COPY } from "../lib/alevel-page-locale.mjs";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the cloud question-bank guest shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>MathPilot<\/title>/i);
  assert.match(html, /aria-label="搜索试题"/);
  const navigation = html.match(/<nav[^>]*aria-label="题库入口"[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? "";
  assert.equal((navigation.match(/>题库</g) ?? []).length, 1, "one shared library entry");
  assert.doesNotMatch(html, /我的题库|私人题库|公共资源库|复制到私人题库/);
  assert.match(html, /全部题型/);
  assert.doesNotMatch(html, /题目属性|来源待核实|provenance-filters/);
  assert.match(html, /登录后可下载/);
  assert.doesNotMatch(html, /新建试题/);
  assert.doesNotMatch(html, /⇧ 文件录入/);
  assert.doesNotMatch(html, /<button[^>]*>生成 Word/);
  assert.doesNotMatch(html, /Starter Project|Your site is taking shape/);
});

test("keeps every privileged operation behind server-side authentication", async () => {
  const auth = await readFile(new URL("../lib/server/auth.ts", import.meta.url), "utf8");
  const questionRoute = await readFile(new URL("../app/api/questions/[id]/route.ts", import.meta.url), "utf8");
  const downloadRoute = await readFile(new URL("../app/api/download/route.ts", import.meta.url), "utf8");
  const loginRoute = await readFile(new URL("../app/api/auth/login/route.ts", import.meta.url), "utf8");

  assert.equal(ALEVEL_PAGE_COPY.zh.guestBrowse, "访客 · 仅浏览");
  assert.equal(ALEVEL_PAGE_COPY.en.guestBrowse, "Guest · Browse only");
  const header = await readFile(new URL("../app/components/SiteHeader.tsx", import.meta.url), "utf8");
  assert.match(header, /copy\.guestBrowse/);
  assert.match(auth, /HttpOnly\$\{secure \? "; Secure" : ""\}; SameSite=Lax/);
  assert.match(loginRoute, /createSession\(user\.id, new URL\(request\.url\)\.protocol === "https:"\)/, "the https site keeps Secure session cookies");
  assert.match(auth, /PBKDF2/);
  assert.match(questionRoute, /await requireUser\(request\)/);
  assert.match(questionRoute, /updateScopedQuestion/);
  assert.match(downloadRoute, /await requireUser\(request\)/);
  assert.match(downloadRoute, /authorizeQuestionDownload/);
});

test("keeps the select-all control on the right without filter scroll chrome", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.doesNotMatch(page, /local-badge/);
  assert.match(css, /\.select-visible\s*\{[^}]*margin-left:auto/);
  assert.match(css, /\.filter-segments::-webkit-scrollbar\s*\{\s*display:none/);
  assert.match(css, /\.filter-segments\s*\{[^}]*scrollbar-width:none/);
  assert.match(css, /html::-webkit-scrollbar,body::-webkit-scrollbar\s*\{\s*display:none/);
});

test("keeps file import inside the new-question flow only", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const entry = await readFile(new URL("../app/components/QuestionEntry.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.doesNotMatch(page + entry, /className="file-import-top"/);
  assert.doesNotMatch(css, /\.file-import-top/);
  assert.match(entry, /<button onClick=\{openFileImport\}><b>文件批量录入<\/b>/);
});

test("keeps the Word export font and layout contract", async () => {
  const source = await readFile(
    new URL("../lib/export-word.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /eastAsia:\s*"Songti SC"/);
  assert.match(source, /<w:font w:name="Songti SC">/);
  assert.match(source, /<w:altName w:val="宋体"\/>/);
  assert.match(source, /<w:font w:name="Times New Roman">/);
  assert.match(source, /<w:font w:name="Cambria Math">/);
  assert.match(source, /archive\.file\("word\/fontTable\.xml", FONT_TABLE_XML\)/);
  assert.match(source, /columnWidths:\s*Array\.from\(\{ length: columnCount \}/);
  assert.match(source, /imageParagraph\(images\[0\], 220, 165, 80, AlignmentType\.RIGHT\)/);
  assert.match(source, /indent: \{ left: 420, hanging: 420 \}/);
  assert.doesNotMatch(source, /columnWidths:\s*\[6627, 3119\]/);
});



test("preserves Word underline runs as visible web segments", () => {
  const display = `（①${markDocxUnderline("    ")}）`;
  assert.deepEqual(splitDisplayUnderlines(display), [
    { underlined: false, value: "（①" },
    { underlined: true, value: "\u00a0\u00a0\u00a0\u00a0" },
    { underlined: false, value: "）" },
  ]);
});

test("renders a triangle area name as the subscript of S", () => {
  assert.equal(normalizeMathNotation("S△EFG=5"), "S_{△EFG}=5");
  assert.equal(normalizeMathNotation("S Δ ABC = 12"), "S_{△ABC} = 12");
  assert.equal(toLatexMath("S△EFG=5"), "S_{\\triangle EFG}=5");
  assert.equal(normalizeMathNotation("△ABC≌△DEF"), "△ABC≌△DEF");
});

test("routes triangle area notation through the Word equation path", () => {
  assert.equal(needsWordMathEquation("S△EFG=5"), true);
  assert.equal(needsWordMathEquation("△ABC≌△DEF"), false);
  assert.equal(needsWordMathEquation("普通文字"), false);
});

test("keeps explanatory parentheses outside equations and formats complete inequalities consistently", () => {
  const stem = "对称轴为直线 x＝1 的抛物线 y＝ax²＋bx＋c（a，b，c 为常数，且 a≠0），结论：①abc＜0，②b²＞4ac，③a＋b≤m(am＋b)（m 为实数）";
  const segments = splitMathText(stem);
  const math = segments.filter((segment) => segment.kind === "math").map((segment) => segment.value);
  assert.equal(segments.map((segment) => segment.value).join(""), stem);
  assert.equal(splitMathText("普通文字 普通文字").map((segment) => segment.value).join(""), "普通文字 普通文字");
  assert.deepEqual(math, ["x＝1", "y＝ax²＋bx＋c", "a", "b", "c", "a≠0", "abc＜0", "b²＞4ac", "a＋b≤m(am＋b)", "m"]);
  assert.ok(segments.some((segment) => segment.kind === "text" && segment.value === "（"));
  assert.ok(segments.some((segment) => segment.kind === "text" && segment.value === "）"));
  assert.equal(toLatexMath("abc＜0"), "abc<0");
  assert.equal(toLatexMath("b²＞4ac"), "b^{2}>4ac");
  assert.equal(needsWordMathEquation("x＝1"), true);
  assert.equal(needsWordMathEquation("abc＜0"), true);
  assert.equal(needsWordMathEquation("3a＋c＞0"), true);
  assert.equal(needsWordMathEquation("a"), false);
});

test("preserves fraction styles and Word sizes instead of forcing nested enlargement", () => {
  const deep = String.raw`1+\frac{1}{1+\frac{1}{1+\frac{1}{4x}}}=\frac{3038}{2025}`;
  const nested = String.raw`1+\frac{1}{1+\frac{1}{x}}`;
  const ordinary = String.raw`\frac{1}{2}`;
  assert.equal(latexFractionDepth(deep), 3);
  assert.equal(latexFractionDepth(nested), 2);
  assert.equal(latexFractionDepth(ordinary), 1);
  assert.equal(latexFractionDepth("ax²+bx+c"), 0);
  assert.equal(fractionSizeClass(deep), "math-fraction-deep");
  assert.equal(fractionSizeClass(nested), "math-fraction-nested");
  assert.equal(fractionSizeClass(ordinary), "");
  assert.equal(toReadableNestedFractionLatex(deep), deep);
  assert.equal(toReadableNestedFractionLatex(nested), nested);
  assert.equal(toReadableNestedFractionLatex(ordinary), ordinary);
  assert.equal(toReadableNestedFractionLatex(String.raw`1+\dfrac{1}{1+\tfrac{1}{x}}`), String.raw`1+\dfrac{1}{1+\tfrac{1}{x}}`);

  const run = (text, properties = "") => `<m:r>${properties}<m:t>${text}</m:t></m:r>`;
  const fraction = (numerator, denominator) => `<m:f><m:num>${numerator}</m:num><m:den>${denominator}</m:den></m:f>`;
  const deepXml = `<m:oMath>${run("1", '<w:rPr><w:sz w:val="24"/></w:rPr>')}+${fraction(run("1"), `${run("1+")}${fraction(run("1"), `${run("1+")}${fraction(run("1"), run("4x"))}`)}`)}=${fraction(run("3038"), run("2025"))}</m:oMath>`;
  const ordinaryXml = `<m:oMath>${fraction(run("1"), run("2"))}</m:oMath>`;
  const documentXml = fullSizeInlineFractions(`<w:p>${deepXml}${ordinaryXml}</w:p>`);
  const equations = [...documentXml.matchAll(/<m:oMath\b[^>]*>[\s\S]*?<\/m:oMath>/g)].map((match) => match[0]);
  const deepEquation = equations.find((xml) => xml.includes("3038"));
  const ordinaryEquation = equations.find((xml) => wordMathFractionDepth(xml) === 1 && !xml.includes("3038"));
  assert.ok(deepEquation);
  assert.equal(wordMathFractionDepth(deepEquation), 3);
  // Only the top-level fraction parts grow; the size the source set on "1" outside any fraction is kept.
  assert.match(deepEquation, /<w:sz w:val="24"\/>/);
  assert.equal((deepEquation.match(/<w:sz w:val="28"\/>/g) ?? []).length, 4);
  assert.doesNotMatch(documentXml, /<w:sz w:val="(?:26|30)"\/>|<m:ctrlPr\b|<w:drawing\b/);
  assert.ok(ordinaryEquation);
  assert.equal((ordinaryEquation.match(/<w:sz w:val="28"\/>/g) ?? []).length, 2);
  const importedEquation = `<m:oMath>${fraction(run("1", '<w:rPr><w:sz w:val="21"/></w:rPr>'), `${run("1", '<w:rPr><w:sz w:val="21"/></w:rPr>')}${fraction(run("1"), run("x"))}`)}</m:oMath>`.replace("<m:f>", '<m:f><m:fPr><m:type m:val="bar"/></m:fPr>');
  assert.equal(fullSizeInlineFractions(importedEquation), importedEquation);
  const settings = ensureWordMathSettings('<w:settings xmlns:w="word" xmlns:m="math"><w:compat/></w:settings>');
  assert.match(settings, /<m:mathPr>[\s\S]*?<m:smallFrac m:val="off"\/>[\s\S]*?<\/m:mathPr>/);
  assert.equal((ensureWordMathSettings(settings).match(/<m:mathPr>/g) ?? []).length, 1);
});

test("chooses distinct image positions for short, multipart, and very long questions", () => {
  assert.equal(automaticQuestionImageLayout({ imageCount: 1, stemLength: 90, paragraphCount: 1 }), null);
  assert.equal(automaticQuestionImageLayout({ imageCount: 1, stemLength: 320, paragraphCount: 4 }), "below-right");
  assert.equal(automaticQuestionImageLayout({ imageCount: 1, stemLength: 900, paragraphCount: 12 }), "below");
  assert.equal(automaticQuestionImageLayout({ imageCount: 3, stemLength: 120, paragraphCount: 2 }), "below");
});

test("puts four options on one line only when each fits a quarter of it, on the web and in Word alike", () => {
  assert.equal(optionColumnCount(["$\\frac{116}{17}$", "$\\frac{120}{17}$", "$\\frac{112}{15}$", "$\\frac{116}{15}$"]), 4);
  assert.equal(optionColumnCount(["$v_{0}=60$米/秒", "汽车行驶总时间为10秒", "$a=6$", "$n=150$米"]), 2);
  assert.equal(optionColumnCount(["相交", "平行", "垂直", "重合"]), 4);
});

test("a screenshot question places its figure where the original printed it, at the same share of the line", async () => {
  const { resolveQuestionImageLayout, sourceFigureWidth } = await loadSource("lib/question-layout.ts");
  const base = { type: "单选题", stem: "如图1，……\n①……\n②……\n下列选项中正确的是（ ）", options: ["a", "b", "c", "d"], originalImage: "/api/assets/source", diagramImage: "/api/assets/figure", imageLayout: "right" };
  const under = { ...base, diagramBox: { x: 12, y: 330, width: 460, height: 300 } };
  assert.equal(resolveQuestionImageLayout(under), "below");
  assert.equal(sourceFigureWidth(under), .46);
  const beside = { ...base, diagramBox: { x: 700, y: 60, width: 280, height: 300 } };
  assert.equal(resolveQuestionImageLayout(beside), "right");
  assert.equal(sourceFigureWidth(beside), .28, "a figure beside the text keeps its share of the line too");
  // Typed questions without a source screenshot keep the existing rules.
  assert.equal(sourceFigureWidth({ ...under, originalImage: undefined }), null);
});

test("keeps short line-based conclusion choices in a compact source-order flow", () => {
  const compactStem = "已知二次函数图象如图，有以下结论：\n①c＞0；\n②b＞0；\n③a＋b＋c＜4a－2b＋c；\n④2a＋b＞0．\n则正确的结论个数是（　　）";
  assert.equal(isCompactConclusionChoice({ type: "单选题", stem: compactStem, imageCount: 1, optionCount: 4 }), true);
  assert.equal(automaticQuestionImageLayout({ imageCount: 1, stemLength: compactStem.length, paragraphCount: 6, type: "单选题", stem: compactStem, optionCount: 4 }), "below");

  const multipartStem = "如图，在△ABC中：\n（1）求证AB＝AC；\n（2）若∠A＝40°，求∠B；\n（3）连接AD并说明理由。";
  assert.equal(isCompactConclusionChoice({ type: "解答题", stem: multipartStem, imageCount: 1, optionCount: 0 }), false);
  assert.equal(automaticQuestionImageLayout({ imageCount: 1, stemLength: 320, paragraphCount: 4, type: "解答题", stem: multipartStem, optionCount: 0 }), "below-right");

  const longStem = `长题条件\n${"说明条件。".repeat(150)}`;
  assert.equal(automaticQuestionImageLayout({ imageCount: 1, stemLength: longStem.length, paragraphCount: 12, type: "解答题", stem: longStem, optionCount: 0 }), "below");
});

test("only sends low-quality reconstructable math diagrams to vector reconstruction", () => {
  assert.equal(shouldAutoVectorizeDiagram({ score: 0.41, reconstructable: true, kind: "geometry", issues: ["模糊"] }), true);
  assert.equal(shouldAutoVectorizeDiagram({ score: 0.92, reconstructable: true, kind: "geometry", issues: [] }), false);
  assert.equal(shouldAutoVectorizeDiagram({ score: 0.3, reconstructable: false, kind: "unsupported", issues: ["实物照片"] }), false);
});

test("photographed diagrams are normalized and reconstructed even when the quality score is optimistic", () => {
  const photographed = { score: 0.85, reconstructable: true, kind: "function", capture: "photo", rotation: 90, issues: ["拍照略有透视倾斜"] };
  assert.equal(isPhotographedDiagram(photographed), true);
  assert.equal(shouldAutoVectorizeDiagram(photographed), true);
  assert.equal(shouldAutoVectorizeDiagram({ ...photographed, capture: "digital", issues: [] }), false);
  assert.equal(normalizeDiagramRotation(90), 90);
  assert.equal(correctionForCapturedRotation("90"), 270);
  assert.equal(correctionForCapturedRotation("270"), 90);
  assert.equal(normalizeDiagramRotation(45), 0);
});

test("recognition image sizing caps the longest edge instead of only landscape width", () => {
  assert.deepEqual(fitWithinMaxEdge(1024, 2280, 1800), { width: 808, height: 1800, scale: 1800 / 2280 });
  assert.deepEqual(fitWithinMaxEdge(2849, 1280, 1800), { width: 1800, height: 809, scale: 1800 / 2849 });
});

test("keeps a higher-resolution photo for diagram cropping without increasing OCR input", async () => {
  const page = await readFile(new URL("../app/components/QuestionEntry.tsx", import.meta.url), "utf8");
  const handouts = await readFile(new URL("../app/tools/handouts/page.tsx", import.meta.url), "utf8");
  const screenshots = await readFile(new URL("../lib/screenshot-recognition.ts", import.meta.url), "utf8");
  const extraction = await readFile(new URL("../lib/recognition-diagram.ts", import.meta.url), "utf8");
  assert.match(screenshots, /compressDataUrl\(await fileToDataUrl\(file\), 3200\)/);
  assert.match(screenshots, /image: await materializeImageDataUrl\(image\)/);
  // 截图录题 and 讲义知识点 share the same screenshot path.
  assert.match(page, /readScreenshot\(file\)/);
  assert.match(page, /recognizeScreenshot<RecognitionQuestionResult>\("\/api\/recognize", image/);
  assert.match(handouts, /readScreenshot\(file\)/);
  assert.match(handouts, /recognizeScreenshot<NoteRecognitionResult>\("\/api\/recognize-note", image\)/);
  assert.match(page, /extractRecognizedDiagram\(image, result\)/);
  assert.match(extraction, /cropDataUrl\(image, result\.diagram_bbox/);
});

test("uses a fast OCR reasoning profile while keeping diagram reasoning independently configurable", async () => {
  const recognitionModel = await readFile(new URL("../lib/server/recognition-model.ts", import.meta.url), "utf8");
  for (const route of ["recognize", "recognize-batch"]) {
    const source = await readFile(new URL(`../app/api/${route}/route.ts`, import.meta.url), "utf8");
    assert.match(source, /callRecognitionModel/);
  }
  assert.match(recognitionModel, /recognitionReasoningEffort/);
  const recognitionRules = await readFile(new URL("../lib/server/recognition-model-rules.mjs", import.meta.url), "utf8");
  assert.match(recognitionRules, /OPENAI_RECOGNITION_REASONING_EFFORT\s*\|\|\s*"low"/);
  const reconstruction = await readFile(new URL("../app/api/reconstruct-diagram/route.ts", import.meta.url), "utf8");
  assert.match(reconstruction, /OPENAI_DIAGRAM_REASONING_EFFORT/);
  assert.match(reconstruction, /12—40 个按原图印刷轮廓采样的点/);
});

test("renders sampled function curves as smooth paths without bending axes", () => {
  const plan = {
    diagramType: "function", confidence: .9, sourceAspectRatio: 1,
    strokes: [
      { id: "x-axis", points: [{ x: 50, y: 500 }, { x: 950, y: 500 }], closed: false, width: 4, color: "#222222", dash: [] },
      { id: "curve", points: Array.from({ length: 9 }, (_, index) => ({ x: 100 + index * 100, y: 250 + (index - 4) ** 2 * 18 })), closed: false, width: 5, color: "#222222", dash: [] },
    ],
    ellipses: [], labels: [], markers: [], expectedLabels: [], constraints: [], geogebraCommands: [], warnings: [],
  };
  const svg = svgFromVectorDiagramPlan(plan);
  assert.match(svg, /<polyline id="x-axis"/);
  assert.match(svg, /<path id="curve" d="M [^"]+ C /);
});

test("regularizes photographed quadratic curves around their printed symmetry axis", () => {
  const plan = {
    diagramType: "function", confidence: .9, sourceAspectRatio: .82,
    strokes: [
      { id: "symmetry_axis", points: [{ x: 540, y: 300 }, { x: 540, y: 900 }], closed: false, width: 4, color: "#222222", dash: [10, 8] },
      { id: "parabola", points: [{ x: 280, y: 300 }, { x: 320, y: 450 }, { x: 370, y: 650 }, { x: 430, y: 760 }, { x: 500, y: 805 }, { x: 540, y: 810 }, { x: 580, y: 807 }, { x: 650, y: 760 }, { x: 730, y: 650 }, { x: 830, y: 470 }, { x: 925, y: 330 }], closed: false, width: 5, color: "#222222", dash: [] },
    ], ellipses: [], labels: [{ text: "x=1", x: 650, y: 270, fontSize: 55, color: "#222222", italic: false, bold: false, anchor: "middle" }], markers: [], expectedLabels: ["x=1"], constraints: ["二次函数开口向上"], geogebraCommands: [], warnings: [],
  };
  const regularized = regularizeQuadraticFunctionPlan(plan);
  const curve = regularized.strokes.find((stroke) => stroke.id === "parabola");
  assert.ok(curve.points.length >= 25);
  for (let index = 0; index < Math.floor(curve.points.length / 2); index += 1) {
    const left = curve.points[index]; const right = curve.points.at(-(index + 1));
    assert.ok(Math.abs((left.x + right.x) / 2 - 540) < 1e-8);
    assert.ok(Math.abs(left.y - right.y) < 1e-8);
  }
  const croppedAspect = vectorDiagramAspectRatio(regularized, { cropToContent: true });
  assert.ok(croppedAspect > .3 && croppedAspect < 4);
  const croppedSvg = svgFromVectorDiagramPlan(regularized, { cropToContent: true });
  assert.match(croppedSvg, /viewBox="(?!0\.000 0\.000 1000\.000)/);
  const [, , , width, height] = croppedSvg.match(/viewBox="([\d.-]+) ([\d.-]+) ([\d.]+) ([\d.]+)"/).map(Number);
  assert.ok(width < 1000 || height < 1000 / plan.sourceAspectRatio);
});

test("darkens pale source ink for screen and Word while preserving already-dark ink", () => {
  assert.equal(printReadyInkColor("#828282"), "#363636");
  assert.equal(printReadyInkColor("#231f20"), "#231f20");
  assert.equal(printReadyInkColor("invalid"), "#363636");
});

test("orthogonalizes photographed coordinate axes after source-fit validation", () => {
  const plan = {
    diagramType: "function", confidence: .9, sourceAspectRatio: 1,
    strokes: [
      { id: "x_axis", points: [{ x: 80, y: 610 }, { x: 920, y: 680 }], closed: false, width: 4, color: "#222222", dash: [] },
      { id: "y_axis", points: [{ x: 360, y: 920 }, { x: 420, y: 80 }], closed: false, width: 4, color: "#222222", dash: [] },
      { id: "parabola", points: Array.from({ length: 12 }, (_, index) => ({ x: 160 + index * 60, y: 300 + (index - 6) ** 2 * 12 })), closed: false, width: 5, color: "#222222", dash: [] },
    ], ellipses: [], labels: [{ text: "x", x: 930, y: 700, fontSize: 48, color: "#222222", italic: true, bold: false, anchor: "middle" }, { text: "y", x: 390, y: 60, fontSize: 48, color: "#222222", italic: true, bold: false, anchor: "middle" }], markers: [], expectedLabels: ["x", "y"], constraints: [], geogebraCommands: [], warnings: [],
  };
  const corrected = orthogonalizeCoordinatePlan(plan);
  const xAxis = corrected.strokes.find((stroke) => stroke.id === "x_axis").points;
  const yAxis = corrected.strokes.find((stroke) => stroke.id === "y_axis").points;
  assert.ok(Math.abs(xAxis[0].y - xAxis.at(-1).y) < 1e-8);
  assert.ok(Math.abs(yAxis[0].x - yAxis.at(-1).x) < 1e-8);
  assert.match(svgFromVectorDiagramPlan(corrected), /<path id="parabola"/);
  const geometry = { ...plan, diagramType: "geometry" };
  assert.equal(orthogonalizeCoordinatePlan(geometry), geometry);
});

test("photographed-diagram fit can omit source-only student annotations", () => {
  const metrics = { precision: .9, recall: .48, projectionScore: .58, boundsScore: .62, toneScore: .9 };
  const strict = combineDiagramRasterFit(metrics, false);
  const filtered = combineDiagramRasterFit(metrics, true);
  assert.ok(strict.score < .72);
  assert.ok(filtered.score >= .72);
  assert.ok(filtered.annotationAwareScore > filtered.strictScore);
});

test("redraws low-quality figures automatically and renders from source coordinates", async () => {
  const page = await readFile(new URL("../app/components/QuestionEntry.tsx", import.meta.url), "utf8");
  const renderer = await readFile(new URL("../lib/vector-diagram-renderer.ts", import.meta.url), "utf8");

  assert.match(page, /shouldReconstructRecognizedDiagram\(reconstruction\.diagramImage, result\.diagram_quality\)/);
  assert.doesNotMatch(page, /geogebra-toggle|enableVectorReconstruction/);
  assert.match(page, /questionDraft\.vectorDiagramPlan[\s\S]*renderVectorDiagramPlan\(questionDraft\.vectorDiagramPlan, original, \{ allowSourceAnnotations: isPhotographedDiagram\(questionDraft\.diagramQuality\) \}\)/);
  assert.match(renderer, /stroke\.points\.map/);
  assert.match(renderer, /scoreDiagramRasterFit/);
  assert.match(renderer, /contourScore/);
  assert.match(renderer, /boundsScore/);
  assert.match(renderer, /sourceInkColor/);
  assert.match(renderer, /toneScore/);
});

test("validates an explicit vector scene and requires every expected label", () => {
  const plan = {
    diagramType: "geometry", confidence: .94, sourceAspectRatio: 1,
    strokes: [{ id: "AB", points: [{ x: 100, y: 100 }, { x: 100, y: 900 }], closed: false, width: 5, color: "#231f20", dash: [] }],
    ellipses: [], labels: [{ text: "A", x: 70, y: 100, fontSize: 58, color: "#231f20", italic: true, bold: false, anchor: "middle" }], markers: [],
    expectedLabels: ["A"], constraints: ["A、B 共线"], geogebraCommands: ["A=(0,1)", "B=(0,0)"], warnings: [],
  };
  assert.deepEqual(validateVectorDiagramPlan(plan), { ok: true });
  assert.match(validateVectorDiagramPlan({ ...plan, expectedLabels: ["A", "B"] }).error, /缺少标签 B/);
});

test("visual profile score rejects a stretched composition with unchanged topology", () => {
  assert.equal(scoreProjectionProfiles([0, 2, 4, 2, 0], [0, 2, 4, 2, 0]), 1);
  assert.ok(scoreProjectionProfiles([0, 2, 4, 2, 0], [4, 2, 0, 0, 0]) < .5);
});

test("rejects unsafe GeoGebra scripts while allowing deterministic constructions", () => {
  assert.equal(isSafeGeoGebraCommand("A=(0,0)"), true);
  assert.equal(isSafeGeoGebraCommand("c=Circle(A,B)"), true);
  assert.equal(isSafeGeoGebraCommand('Execute({"Delete(A)"})'), false);
  const plan = {
    diagramType: "geometry", confidence: 0.94,
    commands: ["A=(0,0)", "B=(6,0)", "C=(3,4)", "s1=Segment(A,B)", "s2=Segment(A,C)", "s3=Segment(B,C)"],
    styles: [], view: { xMin: -1, xMax: 7, yMin: -1, yMax: 5 }, sourceAspectRatio: 4 / 3,
    referencePoints: [
      { label: "A", x: 125, y: 833, labelX: 105, labelY: 865, markerVisible: false, role: "base" },
      { label: "B", x: 875, y: 833, labelX: 895, labelY: 865, markerVisible: false, role: "base" },
      { label: "C", x: 500, y: 167, labelX: 500, labelY: 125, markerVisible: false, role: "base" },
    ],
    expectedLabels: ["A", "B", "C"], constraints: ["连接三角形三边"], warnings: [],
  };
  assert.deepEqual(validateGeoGebraPlan(plan), { ok: true });
});

test("rejects visually displaced reconstructions even when topology is unchanged", () => {
  const reference = [
    { label: "A", x: 100, y: 100 }, { label: "B", x: 100, y: 900 },
    { label: "C", x: 700, y: 900 }, { label: "D", x: 700, y: 100 },
  ];
  assert.equal(scoreDiagramVisualFit(reference, reference).score, 1);
  const displaced = [
    { label: "A", x: 100, y: 100 }, { label: "B", x: 100, y: 900 },
    { label: "C", x: 930, y: 900 }, { label: "D", x: 930, y: 100 },
  ];
  assert.ok(scoreDiagramVisualFit(reference, displaced).score < .8);
});

test("does not store AI meta commentary as an answer or analysis", () => {
  assert.equal(cleanRecognizedAnswer("answer"), "");
  assert.equal(cleanRecognizedAnswer("B"), "B");
  assert.equal(cleanRecognizedAnalysis("截图中可见一道选择题，未见明确答案或解析，因此 answer 和解析相关字段留空。"), "");
  assert.equal(cleanRecognizedAnalysis("由勾股定理可得 AB=5。"), "由勾股定理可得 AB=5。");
});

test("routes every AI feature through the unified gateway and native Antigravity adapter", async () => {
  const adapter = await readFile(new URL("../lib/server/antigravity-gemini.ts", import.meta.url), "utf8");
  const gateway = await readFile(new URL("../lib/server/ai-gateway.ts", import.meta.url), "utf8");
  const recognitionModel = await readFile(new URL("../lib/server/recognition-model.ts", import.meta.url), "utf8");
  assert.match(adapter, /aiProviderModelsUrl/);
  assert.match(adapter, /:generateContent/);
  assert.match(adapter, /responseMimeType:\s*"application\/json"/);
  assert.match(adapter, /thinkingConfig:\s*\{\s*thinkingLevel:\s*thinkingLevel\(reasoningEffort\)\s*\}/);
  assert.match(adapter, /responseSchema:\s*geminiResponseSchema\(schema\)/);
  assert.match(adapter, /nullable:\s*true/);
  assert.match(adapter, /inlineData:\s*\{\s*mimeType:/);
  assert.match(gateway, /callAntigravityGemini/);
  assert.match(gateway, /resolveAiRuntime/);
  for (const route of ["optimize", "reconstruct-diagram"]) {
    const source = await readFile(new URL(`../app/api/${route}/route.ts`, import.meta.url), "utf8");
    assert.match(source, /callStructuredAi/);
    assert.match(source, /signal: request.signal/);
    assert.doesNotMatch(source, /process\.env\.OPENAI_API_KEY/);
  }
  for (const route of ["recognize", "recognize-batch"]) {
    const source = await readFile(new URL(`../app/api/${route}/route.ts`, import.meta.url), "utf8");
    assert.match(source, /callRecognitionModel/);
  }
  assert.match(recognitionModel, /callStructuredAi/);
  assert.match(recognitionModel, /signal: input.signal/);
  assert.match(recognitionModel, /recognitionReasoningEffort\(\)/);
});
