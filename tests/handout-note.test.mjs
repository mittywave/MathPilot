import test from "node:test";
import assert from "node:assert/strict";
import { noteFromBlocks, noteImageSources, noteSpans, noteTableMarkup, parseHandoutNote, proofSteps } from "../lib/handout-note.mjs";
import { loadSource } from "./load-source.mjs";

const asset = "/api/assets/0123abcd-0123-4567-89ab-0123456789ab";
const second = "/api/assets/89abcdef-0123-4567-89ab-0123456789ab";
const box = (x, y, width = 100, height = 60) => ({ x, y, width, height });

test("note lines become headings by level, points, rows of figures and text with bold spans", () => {
  const lines = parseHandoutNote([
    "# 反比例函数几何综合",
    "## 正方形的判定",
    "### 面积相等",
    "判定正方形，只需判定它**既是矩形又是菱形**：",
    "（1）**先证它是矩形**，再证邻边相等；",
    "① 对角线 $AC\\perp BD$",
    "2、对角线相等",
    "1.5 不是序号",
    `![图](${asset})`,
    `![$O$ 可在 $y$ 轴上移动](${asset}) ![含 \\] 的图注](${second}) $S_{\\triangle ABO}=\\frac{1}{2}|k|$，**同底等高**`,
    "![外链](https://example.com/x.png)",
    "![外链](https://example.com/x.png) 旁边的字留下",
    "",
    "**未闭合的星号 ** 保留**原样",
  ].join("\n"));
  assert.deepEqual(lines.map(line => line.kind), ["heading", "heading", "heading", "text", "item", "item", "item", "text", "figures", "figures", "text", "text"]);
  assert.deepEqual(lines.slice(0, 3).map(line => line.level), [1, 2, 3]);
  assert.deepEqual(lines[3].spans, [{ text: "判定正方形，只需判定它", bold: false }, { text: "既是矩形又是菱形", bold: true }, { text: "：", bold: false }]);
  assert.equal(lines[4].marker, "（1）");
  assert.deepEqual(lines[4].spans[0], { text: "先证它是矩形", bold: true });
  assert.equal(lines[5].marker, "①");
  assert.equal(lines[6].marker, "2、");
  assert.deepEqual(lines[8], { kind: "figures", figures: [{ src: asset, caption: [] }], side: [] }, "a figure written before captions existed has none");
  assert.deepEqual(lines[9].figures, [{ src: asset, caption: [{ text: "$O$ 可在 $y$ 轴上移动", bold: false }] }, { src: second, caption: [{ text: "含 ] 的图注", bold: false }] }]);
  assert.deepEqual(lines[9].side, [[{ text: "$S_{\\triangle ABO}=\\frac{1}{2}|k|$，", bold: false }, { text: "同底等高", bold: true }]]);
  assert.deepEqual(lines[10].spans, [{ text: "旁边的字留下", bold: false }], "an outside image is dropped, the text beside it stays");
  assert.deepEqual(noteImageSources(`前言\n![图](${asset}) ![](${second}) 旁注\n![x](data:image/png;base64,AAAA)`), [asset, second], "only stored assets are images");
  assert.deepEqual(noteSpans("a**b"), [{ text: "a**b", bold: false }]);
});

test("recognized blocks turn into editable note text in reading order", () => {
  const text = noteFromBlocks([
    { type: "heading", level: 1, text: "反比例函数几何综合", bbox: null },
    { type: "heading", level: 3, text: "面积相等", bbox: null },
    { type: "paragraph", text: "判定一个四边形是正方形时：", bbox: null },
    { type: "item", marker: "（1）", text: "**先证它是矩形**", bbox: null },
    { type: "figures", figures: [{ bbox: box(1, 2), caption: "$S_①=S_②$", captionBox: null }, { bbox: box(5, 5), caption: "没裁出来", captionBox: null }, { bbox: box(9, 9), caption: "f[x]", captionBox: null }], side: "同底等高", sideBox: null },
    { type: "figures", figures: [{ bbox: box(5, 5), caption: "", captionBox: null }], side: "只剩旁注", sideBox: null },
    { type: "paragraph", text: "容易证明 $\\triangle APB$ 是等腰直角三角形。", bbox: null },
  ], figure => figure.bbox.x === 1 ? asset : figure.bbox.x === 9 ? second : null);
  assert.equal(text, [
    "# 反比例函数几何综合", "### 面积相等", "判定一个四边形是正方形时：", "（1）**先证它是矩形**",
    `![$S_①=S_②$](${asset}) ![f[x\\]](${second}) 同底等高`, "只剩旁注", "容易证明 $\\triangle APB$ 是等腰直角三角形。",
  ].join("\n"));
  assert.deepEqual(parseHandoutNote(text).map(line => line.kind), ["heading", "heading", "text", "item", "figures", "text", "text"]);
});

test("model output is cleaned into the layout contract", async () => {
  const { normalizeNoteRecognitionResult } = await loadSource("lib/recognition-contract.ts");
  const result = normalizeNoteRecognitionResult({
    blocks: [
      { type: "heading", level: 7, marker: "", text: "**正方形的判定**", bbox: box(10, 10), figures: [] },
      { type: "heading", level: 1, marker: "", text: "大标题", bbox: null, figures: [] },
      { type: "paragraph", level: 0, marker: "", text: "第一行\n  第二行\n$x$ 与\n$y$", bbox: box(10, 80), figures: [] },
      { type: "item", level: 0, marker: "（1）", text: "**先证它是矩形；**", bbox: null, figures: [] },
      { type: "item", level: 0, marker: "", text: "没有序号的要点", bbox: null, figures: [] },
      { type: "figures", level: 0, marker: "", text: "$S_{\\triangle ABO}=\\frac{1}{2}|k|$\n同底等高", bbox: box(620, 410, 280, 110), figures: [
        { bbox: box(126, 395, 188, 105), caption: "$O$ 可在 $y$ 轴上移动", caption_bbox: box(200, 500, 230, 40) },
        { bbox: box(10, 10, 3, 3), caption: "", caption_bbox: null },
        "not a figure",
      ] },
      { type: "figures", level: 0, marker: "", text: "图都没框到", bbox: null, figures: [] },
      { type: "paragraph", level: 0, marker: "", text: "   ", bbox: null, figures: [] },
      "not a block",
    ],
    warnings: ["公式存疑", "公式存疑", ""],
  });
  assert.deepEqual(result.blocks, [
    { type: "heading", level: 3, text: "正方形的判定", bbox: box(10, 10) },
    { type: "heading", level: 1, text: "大标题", bbox: null },
    { type: "paragraph", text: "第一行第二行 $x$ 与 $y$", bbox: box(10, 80) },
    { type: "item", marker: "（1）", text: "**先证它是矩形；**", bbox: null },
    { type: "paragraph", text: "没有序号的要点", bbox: null },
    { type: "figures", figures: [{ bbox: box(126, 395, 188, 105), caption: "$O$ 可在 $y$ 轴上移动", captionBox: box(200, 500, 230, 40) }], side: "$S_{\\triangle ABO}=\\frac{1}{2}|k|$ 同底等高", sideBox: box(620, 410, 280, 110) },
    { type: "paragraph", text: "图都没框到", bbox: null },
  ]);
  assert.deepEqual(result.warnings, ["公式存疑"]);
  assert.throws(() => normalizeNoteRecognitionResult(null));
});

test("notes render the same structure in the PDF source", async () => {
  const { buildHandoutLatex } = await loadSource("lib/handout-latex.ts");
  const note = [
    "# 反比例函数", "## 正方形的判定", "（1）**先证它是矩形**", `![图](${asset})`,
    `![$S_①=S_②$](${asset}) ![](${second}) ![](/api/assets/ffffffff-0123-4567-89ab-0123456789ab) ☆《拉窗帘》同底等高`,
    "容易证明 $\\triangle APB$。",
  ].join("\n");
  const latex = buildHandoutLatex({ title: "讲义", answers: "none", modules: [{ heading: "一、正方形", note, bands: { example: [], practice: [], variant: [] } }] },
    source => source === asset ? "figures/fig-1.png" : source === second ? "figures/fig-2.png" : null);
  const body = latex.slice(latex.indexOf("\\begin{handoutnote}"), latex.indexOf("\\end{handoutnote}"));
  assert.match(body, /\\handoutnoteheading\[1\]\{反比例函数\}\n\n\\handoutnoteheading\[2\]\{正方形的判定\}\n\n\\handoutnoteitem\{（1）\}\{\\textbf\{先证它是矩形\}\}/);
  assert.match(body, /\\begin\{handoutfigurerow\}\n\\handoutrowfigure\{0\.300\\linewidth\}\{40mm\}\{figures\/fig-1\.png\}\{\}\n\\end\{handoutfigurerow\}/, "every figure has a cell of one size");
  assert.match(body, /\\begin\{handoutfigurerow\}\n\\handoutrowfigure\{0\.300\\linewidth\}\{40mm\}\{figures\/fig-1\.png\}\{\$S_①=S_②\$\}\\hspace\{0\.03\\linewidth\}%\n\\handoutrowfigure\{0\.300\\linewidth\}\{40mm\}\{figures\/fig-2\.png\}\{\}\\hspace\{0\.03\\linewidth\}%\n\\handoutrowside\{0\.32\\linewidth\}\{\$\\bigwhitestar\$《拉窗帘》同底等高\}\n\\end\{handoutfigurerow\}/, "a figure that could not be read is left out of its row");
  assert.match(body, /容易证明 \$\\triangle APB\$。\n$/);
});

test("a proof is read one step per line: every ∵ / ∴ starts a new line", () => {
  assert.deepEqual(proofSteps("$\\because S_{\\triangle AMO}=\\frac{1}{2}|k|$ 又$\\because$ 双曲线中心对称 $\\therefore MO$ 为 $\\triangle AMB$ 中线 $\\therefore S_{\\triangle AMB}=|k|$."), [
    "$\\because S_{\\triangle AMO}=\\frac{1}{2}|k|$", "又$\\because$ 双曲线中心对称", "$\\therefore MO$ 为 $\\triangle AMB$ 中线", "$\\therefore S_{\\triangle AMB}=|k|$.",
  ]);
  assert.deepEqual(proofSteps("证明：设 $P(x,y)$ ∵$P_1$ 和 $P$ 关于原点对称 ∴$P_1(-x,-y)$"), ["证明：设 $P(x,y)$", "∵$P_1$ 和 $P$ 关于原点对称", "∴$P_1(-x,-y)$"]);
  assert.deepEqual(proofSteps("证明：∵$a=b$ ∴$c=d$"), ["证明：∵$a=b$", "∴$c=d$"], "a lead-in stays with the first step");
  assert.deepEqual(proofSteps("$\\because a=b \\therefore c=d$"), ["$\\because a=b$", "$\\therefore c=d$"], "a formula holding two steps is split");
  assert.deepEqual(proofSteps("$$a=b\\therefore c=d$$"), ["$$a=b$$", "$$\\therefore c=d$$"]);
  assert.deepEqual(proofSteps("**∵甲∴乙** 不拆"), ["**∵甲∴乙** 不拆"], "bold text is never cut");
  assert.deepEqual(proofSteps("∵ 只有一步"), ["∵ 只有一步"]);
  assert.deepEqual(parseHandoutNote("甲 ∵乙 ∴丙\n（1）∵要点 ∴不拆").map(line => [line.kind, line.spans[0].text]), [["text", "甲"], ["text", "∵乙"], ["text", "∴丙"], ["item", "∵要点 ∴不拆"]]);
  assert.deepEqual(parseHandoutNote(`![](${asset}) ∵A ∴B\n> 又∵C\n> D\n> 落单`).map(line => line.side?.map(spans => spans[0].text)), [["∵A", "∴B", "又∵C", "D", "落单"]]);
  assert.deepEqual(parseHandoutNote("> 没有图").map(line => line.kind), ["text"]);
});

test("a proof written right below a row of one or two figures is set beside them", () => {
  const lines = parseHandoutNote([`![](${asset}) ![](${second})`, "证明：设 $P(x,y)$ ∵甲 ∴乙", "证明：如图 ∵丙", "∴丁", "结论之后的正文", "### 下一节"].join("\n"));
  assert.deepEqual(lines.map(line => line.kind), ["figures", "text", "heading"]);
  assert.deepEqual(lines[0].side.map(spans => spans[0].text), ["证明：设 $P(x,y)$", "∵甲", "∴乙", "证明：如图", "∵丙", "∴丁"]);
  assert.equal(lines[1].spans[0].text, "结论之后的正文", "text that is not a proof step stays below");
  assert.deepEqual(parseHandoutNote(`![](${asset})\n普通说明`).map(line => line.kind), ["figures", "text"], "only a proof moves");
  assert.deepEqual(parseHandoutNote(`![](${asset}) ![](${asset}) ![](${second})\n∵甲`).map(line => line.kind), ["figures", "text"], "three figures leave no room");
});

test("bold never splits a formula, and LaTeX written outside $ is read as a formula", () => {
  const [bold, rest] = noteSpans("**整数和分数统称有理数**；$\\begin{cases}\\text{**整数**：正整数}\\\\\\text{**分数**：负分数}\\end{cases}$");
  assert.deepEqual(bold, { text: "整数和分数统称有理数", bold: true });
  assert.equal(rest.text, "；$\\begin{cases}\\text{\\textbf{整数}：正整数}\\\\\\text{\\textbf{分数}：负分数}\\end{cases}$");
  assert.equal(noteSpans("是\\underline{有理数}；$\\pi$ 等\\underline{不是有理数}。")[0].text, "是$\\underline{\\text{有理数}}$；$\\pi$ 等$\\underline{\\text{不是有理数}}$。");
  assert.equal(noteSpans("$\\frac{1}{2}$ 与 \\\\ 换行")[0].text, "$\\frac{1}{2}$ 与 \\\\ 换行", "an escaped backslash is left alone");
});

test("a comparison table keeps merged cells, formulas and figures together through storage and PDF generation", async () => {
  const { normalizeNoteRecognitionResult, buildNoteRecognitionPrompt, noteRecognitionSchema } = await loadSource("lib/recognition-contract.ts");
  const cell = (text, col_span = 1, row_span = 1, figures = []) => ({ text, col_span, row_span, figures, bbox: null });
  const result = normalizeNoteRecognitionResult({ blocks: [{ type: "table", bbox: box(20, 20, 940, 940), rows: [
    [cell("反比例函数"), cell("$y=\\frac{k}{x}$（$k\\ne0$）", 2)],
    [cell("图象", 1, 2), cell("$k>0$"), cell("$k<0$")],
    [cell("", 1, 1, [{ bbox: box(390, 470, 120, 160), caption: "", caption_bbox: null }]), cell("", 1, 1, [{ bbox: box(740, 470, 120, 160), caption: "", caption_bbox: null }])],
    [cell("性质"), cell("在每一象限内，**增大而减小**\n$x>0$ & $y>0$"), cell("在每一象限内，**增大而增大**\n$x<0$")],
  ] }], warnings: [] });
  const note = noteFromBlocks(result.blocks, figure => figure.bbox.x === 390 ? asset : second);
  assert.equal(note.split("\n").length, 1, "cell paragraphs are escaped inside one table block");
  assert.match(note, /colspan="2" rowspan="1"/);
  assert.match(note, /colspan="1" rowspan="2"/);
  assert.match(note, /&amp;/);
  assert.match(note, /&lt;/);
  const [table] = parseHandoutNote(note);
  assert.equal(table.kind, "table");
  assert.equal(table.rows.length, 4);
  assert.equal(table.rows[2].length, 2, "a row-spanning cell has no duplicate placeholder");
  assert.equal(table.rows[3][2].content, "在每一象限内，**增大而增大**\n$x<0$");
  assert.deepEqual(noteImageSources(note), [asset, second]);
  assert.equal(noteTableMarkup(table.rows), note);
  const { buildHandoutLatex } = await loadSource("lib/handout-latex.ts");
  const latex = buildHandoutLatex({ title: "知识表格", answers: "none", modules: [{ heading: "反比例函数", note, bands: { example: [], practice: [], variant: [] } }] }, source => source === asset ? "fig-1.png" : "fig-2.png");
  assert.match(latex, /\\begin\{tabularx\}\{\\linewidth\}/);
  assert.match(latex, /\\multicolumn\{2\}/);
  assert.match(latex, /\\multirow\{2\}\{=\}/);
  assert.match(latex, /\\handoutrowfigure\{0\.980\\linewidth\}\{32mm\}\{fig-1.png\}/);
  assert.match(latex, /fig-2.png/);
  assert.match(buildNoteRecognitionPrompt(), /不得把表格拆成/);
  assert.ok(noteRecognitionSchema.properties.blocks.items.properties.type.enum.includes("table"));
  const combined = noteTableMarkup([
    [{ content: "横纵合并", colSpan: 2, rowSpan: 2 }, { content: "甲", colSpan: 1, rowSpan: 1 }],
    [{ content: "乙", colSpan: 1, rowSpan: 1 }],
  ]);
  const mergedLatex = buildHandoutLatex({ title: "合并表格", answers: "none", modules: [{ heading: "", note: combined, bands: { example: [], practice: [], variant: [] } }] });
  assert.match(mergedLatex, /\\multicolumn\{2\}\{\|c\|\}\{\} & 乙/, "a merge spanning both rows and columns has no interior ruling in its continuation");
});
