import { loadSource } from './load-source.mjs';
import assert from "node:assert/strict";
import test from "node:test";
const { docxWebContentText, docxWebInlineText, parseDocxWebContent, parseDocxWebOptions } = await loadSource("lib/docx-web-content.ts");
const { plainTextWebLines, toLatexMath } = await loadSource("lib/math-text.ts");

const paragraph = (body) => `<w:p xmlns:w="word" xmlns:m="math"><w:pPr><w:jc w:val="left"/></w:pPr>${body}</w:p>`;
const textRun = (value, properties = "") => `<w:r><w:rPr>${properties}</w:rPr><w:t xml:space="preserve">${value}</w:t></w:r>`;
const mathRun = (body) => `<w:r><m:oMath>${body}</m:oMath></w:r>`;

test("turns Word fractions, ordered scripts and percentages into semantic web math", () => {
  const xml = paragraph(`${textRun("7．由题可列方程为")}${mathRun([
    "<m:f><m:num><m:r><m:t>3000</m:t></m:r></m:num><m:den><m:r><m:t>x</m:t></m:r></m:den></m:f>",
    "<m:r><m:t>-2=</m:t></m:r>",
    "<m:f><m:num><m:r><m:t>3000</m:t></m:r></m:num><m:den><m:sSubSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sub><m:r><m:t>1</m:t></m:r></m:sub><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSubSup><m:r><m:t>(1+20%)</m:t></m:r></m:den></m:f>",
  ].join(""))}`);
  const content = parseDocxWebContent([xml], { stripLeadingQuestionNumber: true });
  assert.equal(docxWebContentText(content), "由题可列方程为$\\frac{3000}{x}-2=\\frac{3000}{{x}_{1}^{2}(1+20\\%)}$");
  assert.equal(toLatexMath("20%"), "20\\%");
  assert.equal(toLatexMath("20\\%"), "20\\%");
});

test("keeps Word run styles and normalizes an entire formula option consistently", () => {
  const xml = paragraph([
    textRun("A．"),
    textRun("a", "<w:i/>"),
    textRun("2", "<w:vertAlign w:val=\"superscript\"/>"),
    textRun("•"),
    textRun("a", "<w:i/>"),
    textRun("4", "<w:vertAlign w:val=\"superscript\"/>"),
    textRun("＝"),
    textRun("a", "<w:i/>"),
    textRun("6", "<w:vertAlign w:val=\"superscript\"/>"),
    "<w:r><w:tab/></w:r>",
    textRun("B．普通文字"),
  ].join(""));
  const options = parseDocxWebOptions([xml]);
  assert.equal(options.length, 2);
  assert.equal(docxWebInlineText(options[0].inlines), "$a^{2}\\cdot a^{4}=a^{6}$");
  assert.equal(docxWebInlineText(options[1].inlines), "普通文字");
});

test("preserves table rows, nested tables, column spans and vertical merges", () => {
  const nested = `<w:tbl><w:tr><w:tc>${paragraph(textRun("0"))}<w:tcPr/></w:tc><w:tc>${paragraph(textRun("3"))}<w:tcPr/></w:tc></w:tr></w:tbl>`;
  const xml = `<w:tbl xmlns:w="word">
    <w:tr>
      <w:tc>${paragraph(textRun("素材1"))}<w:tcPr><w:vMerge w:val="restart"/></w:tcPr></w:tc>
      <w:tc>${paragraph(textRun("说明"))}<w:tcPr><w:gridSpan w:val="2"/></w:tcPr></w:tc>
    </w:tr>
    <w:tr>
      <w:tc>${paragraph("")}<w:tcPr><w:vMerge/></w:tcPr></w:tc>
      <w:tc>${paragraph(textRun("数据"))}${nested}<w:tcPr><w:gridSpan w:val="2"/></w:tcPr></w:tc>
    </w:tr>
  </w:tbl>`;
  const content = parseDocxWebContent([xml]);
  assert.equal(content.blocks.length, 1);
  const table = content.blocks[0];
  assert.equal(table.type, "table");
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[0][0].rowSpan, 2);
  assert.equal(table.rows[0][1].colSpan, 2);
  assert.equal(table.rows[1].length, 1);
  assert.equal(table.rows[1][0].blocks[1].type, "table");
  assert.match(docxWebContentText(content), /素材1\t说明/);
  assert.match(docxWebContentText(content), /数据\n0\t3/);
});

test("keeps analysis paragraphs separate and leaves plain text questions on their fallback path", () => {
  const analysis = parseDocxWebContent([
    paragraph(textRun("【分析】先读题．")),
    paragraph(`${textRun("【解答】")}${mathRun("<m:f><m:num><m:r><m:t>1</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f>")}`),
  ]);
  assert.equal(analysis.blocks.length, 2);
  assert.equal(docxWebContentText(analysis), "【分析】先读题．\n【解答】$\\frac{1}{2}$");
  assert.deepEqual(parseDocxWebContent([]), { blocks: [] });
  assert.deepEqual(parseDocxWebOptions([]), []);
});

test("keeps English prose and standalone formulas on separate web lines", () => {
  const stem = "The equation\nx²＋kx＋3＝0\nhas no real roots.\nShow that\nk²＜12";
  const lines = plainTextWebLines(stem);
  assert.deepEqual(lines, [
    { value: "The equation", align: "left" },
    { value: "x²＋kx＋3＝0", align: "center" },
    { value: "has no real roots.", align: "left" },
    { value: "Show that", align: "left" },
    { value: "k²＜12", align: "center" },
  ]);
  assert.equal(lines.map((line) => line.value).join("\n"), stem);
});

test("centers only formula-only fallback lines and keeps prose controls left aligned", () => {
  assert.deepEqual(plainTextWebLines("12. Let x＝1.\ny＝2", { stripLeadingQuestionNumber: true }), [
    { value: "Let x＝1.", align: "left" },
    { value: "y＝2", align: "center" },
  ]);
  assert.deepEqual(plainTextWebLines("普通文字\n\n继续说明"), [
    { value: "普通文字", align: "left" },
    { value: "", align: "left" },
    { value: "继续说明", align: "left" },
  ]);
});

test("a line of inline formulas stays in the running text; a fraction in it is printed full size", async () => {
  const stem = "把下列各数填入相应的集合中：\n$+6$, $0.75$, $-3$, $\\frac{24}{5}$, $-\\frac{1}{3}$, $9\\%$.\n$$x^{2}=4$$";
  assert.deepEqual(plainTextWebLines(stem).map((line) => line.align), ["left", "left", "center"]);
  const { renderKatex } = await loadSource("lib/math-render.ts");
  assert.match(renderKatex("-\\frac{1}{3}").html, /\\displaystyle -\\frac\{1\}\{3\}/);
  assert.doesNotMatch(renderKatex("x^{2}").html, /\\displaystyle/);
});
