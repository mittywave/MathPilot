import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadSource } from "./load-source.mjs";

const { buildHandoutLatex, choiceColumns, latexInline, latexPlain, splitHandoutTitle, wrapCjkInMath } = await loadSource("lib/handout-latex.ts");
const base = { categoryId: "c", difficulty: "基础", tags: [], options: [], answer: "", analysis: "", source: "" };
const choice = { ...base, id: "a", type: "单选题", stem: "方程 $2x+1=5$ 的解是（　　）", options: ["$x=1$", "$x=2$", "$x=3$", "$x=4$"], answer: "B", analysis: "【分析】移项。\n【解答】$x=2$，故选 B。", source: "2024 期中", tags: ["一元一次方程", "移项"] };
const proof = { ...base, id: "b", type: "解答题", stem: "如图，在 □ABCD 中，求证：AE=CF。", answer: "见解析", analysis: "∵AB∥CD，∴∠1=∠2。", contentImages: ["fig://one"], imageLayout: "right" };
const blank = { ...base, id: "c", type: "填空题", stem: "若 x-7=2，则 x=____。", answer: "9" };
const docx = {
  ...base, id: "d", type: "解答题", stem: "根据下表求 a。",
  stemDocxXml: [
    '<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:r><w:t>5．根据下表求 </w:t></w:r><m:oMath><m:f><m:num><m:r><m:t>a</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f></m:oMath><w:r><w:t>。</w:t></w:r></w:p>',
    '<w:tbl xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:tr><w:tc><w:p><w:r><w:t>月份</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>销量</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>一月</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>a+12</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
  ],
};
const empty = { example: [], practice: [], variant: [] };
const modules = [
  { heading: "一、平行四边形的性质", note: "对边相等：$AB=CD$\n对角线互相平分", bands: { example: [choice, proof], practice: [blank], variant: [docx] } },
  { heading: "", note: "", bands: { ...empty, practice: [{ ...blank, id: "e" }] } },
];
const build = answers => buildHandoutLatex({ title: "第一讲-平行四边形的性质", modules, answers }, source => source === "fig://one" ? "figures/fig-1.png" : null);
// Word-imported content with its pictures where the document put them, and screenshot figures beside or under the text.
const wordParagraph = body => `<w:p xmlns:w="w">${body}</w:p>`;
const wordText = value => `<w:r><w:t>${value}</w:t></w:r>`;
const wordPicture = (id, cx, cy) => `<w:r><w:drawing><wp:inline><wp:extent cx="${cx}" cy="${cy}"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="${id}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
const modelling = {
  ...base, id: "m", type: "解答题", stem: "【建立模型】\n如图1，求证：AB=CD。\n【模型应用】如图2，求点 C 的坐标。", answer: "见解析", contentImages: ["fig://row"],
  stemDocxXml: [wordParagraph(wordText("16．【建立模型】")), wordParagraph(wordText("如图1，求证：AB=CD。")), wordParagraph(wordPicture("rId24", 4617730, 1962916)), wordParagraph(wordText("【模型应用】如图2，求点 C 的坐标。"))],
  stemDocxAssets: { rId24: "fig://row" },
  analysisDocxXml: [wordParagraph(wordText("【解答】解：如图：")), wordParagraph(wordPicture("rId50", 1563627, 2033020)), wordParagraph(wordText("故 C(6,2)。"))],
  analysisDocxAssets: { rId50: "fig://work" },
};
const shot = (id, diagramBox) => ({ ...base, id, type: "填空题", stem: "如图，直线与 x 轴交于点 B，则 C 点坐标为____。", originalImage: "fig://page", diagramImage: `fig://${id}`, diagramBox, imageLayout: "right" });
const figureModules = [{ heading: "图位", note: "", bands: { ...empty, practice: [modelling, shot("beside", { x: 820, y: 60, width: 180, height: 800 }), shot("under", { x: 60, y: 300, width: 620, height: 400 })] } }];
const buildFigures = answers => buildHandoutLatex({ title: "图位测试", modules: figureModules, answers }, source => source.startsWith("fig://") ? `figures/${source.slice(6)}.png` : null);
const buildList = answers => buildHandoutLatex({ title: "第一讲-平行四边形的性质", answers, sheet: "小测", questions: [choice, proof, blank] }, source => source === "fig://one" ? "figures/fig-1.png" : null);

test("plain text is escaped and keeps blanks and Word-style symbols printable", () => {
  assert.equal(latexPlain("100% & #1 {a_b} ~^\\"), "100\\% \\& \\#1 \\{a\\_b\\} \\textasciitilde{}\\textasciicircum{}\\textbackslash{}");
  assert.match(latexPlain("x=____。"), /^x=\\handoutblank\{3\.0em\}。$/);
  assert.equal(latexPlain("∵AB∥CD，∴∠1=∠2，a≥0，﹣2"), "$\\because$AB$\\parallel$CD，$\\therefore$$\\angle$1=$\\angle$2，a$\\geq$0，$-$2");
  assert.equal(latexPlain("在□ABCD中"), "在$\\parallelogram$ABCD中");
});

test("formulas follow the web conversion and keep Chinese out of math mode", () => {
  assert.equal(latexInline("方程 $2x+1=5$ 的解"), "方程 $2x+1=5$ 的解");
  assert.equal(latexInline("在 □ABCD 中"), "在 $\\parallelogram$$ABCD$ 中");
  assert.match(latexInline("DE=AD·sin60°=3√3"), /\$\\sin 60\^\{\\circ\}=3\\sqrt\{3\}\$/);
  assert.equal(wrapCjkInMath("x=\\text{米}+y，z"), "x=\\text{米}+y\\text{，}z");
});

test("titles and option columns follow the handout conventions", () => {
  assert.deepEqual(splitHandoutTitle("第一讲-平行四边形的性质"), { series: "第一讲", title: "平行四边形的性质" });
  assert.deepEqual(splitHandoutTitle("第3讲 一元一次方程"), { series: "第3讲", title: "一元一次方程" });
  assert.deepEqual(splitHandoutTitle("期中复习"), { series: "", title: "期中复习" });
  assert.equal(choiceColumns([2, 3, 2, 4]), 4);
  assert.equal(choiceColumns([12, 8, 9, 15]), 2);
  assert.equal(choiceColumns([30, 8]), 1);
  assert.equal(choiceColumns([2, 2, 2, 2, 2]), 2);
});

test("every module runs 知识点 → 例题 → 练习 → 变式 with per-band numbering", () => {
  const student = build("none");
  assert.match(student, /\\handoutseries\{第一讲\}\n\\handouttitle\{平行四边形的性质\}\n\\handoutedition\{学生版\}/);
  const order = ["\\handoutsection{一}{平行四边形的性质}", "\\handoutpart{知识点}{本模块要掌握的内容}", "\\begin{handoutnote}", "\\handoutpart{例题}{跟着老师，看知识点怎么用}", "\\handoutnumberwidth{例2}",
    "\\begin{handoutquestion}{例1}", "\\begin{handoutquestion}{例2}", "\\handoutpart{练习}{自己动手，检验掌握}", "\\begin{handoutquestion}{1}", "\\handoutpart{变式}{换个情境，抓住本质}",
    "\\begin{handoutquestion}{变式1}", "\\handoutsection{二}{模块二}", "\\begin{handoutquestion}{2}"];
  const positions = order.map(marker => student.indexOf(marker));
  assert.ok(positions.every(position => position >= 0), order.filter((_, index) => positions[index] < 0).join(", "));
  assert.deepEqual([...positions].sort((x, y) => x - y), positions);
  assert.equal((student.match(/\\handoutnotesarea\{4\}/g) ?? []).length, 2, "学生版 例题 get a note area");
  assert.equal((student.match(/\\handoutworkspace\{4\}/g) ?? []).length, 1, "only the 变式 解答题 gets working lines");
  assert.match(student, /\\handoutpoints\{一元一次方程、移项\}/);
  assert.match(student, /\\handoutsource\{2024 期中\}方程/);
  assert.match(student, /\\begin\{handoutsidefigure\}\{figures\/fig-1\.png\}/);
  assert.doesNotMatch(student, /handoutanswer|handoutkey/);

  const key = build("end");
  assert.match(key, /\\handoutedition\{附答案\}/);
  const keyOrder = ["\\handoutanswerkey", "\\handoutkeygroup{例题解析}{例2}", "\\begin{handoutkey}{例1}", "\\begin{handoutkey}{例2}", "\\handoutkeygroup{练习答案}{2}", "\\begin{handoutkey}{1}", "\\begin{handoutkey}{2}", "\\handoutkeygroup{变式答案}{变式1}", "\\begin{handoutkey}{变式1}"];
  const keyPositions = keyOrder.map(marker => key.indexOf(marker));
  assert.ok(keyPositions.every(position => position > key.lastIndexOf("\\end{handoutquestion}")), "the key follows the last question");
  assert.deepEqual([...keyPositions].sort((x, y) => x - y), keyPositions);
  assert.match(key, /\\begin\{handoutkey\}\{例1\}\n\\handoutanswerline\{B\}\n\\handoutanalysis\{分析\}\{移项。\}\n\\handoutanalysis\{解答\}\{\$x=2\$，故选 \$B\$。\}/);
  assert.equal((key.match(/\\handoutnotesarea/g) ?? []).length, 2, "附答案 keeps the 学生版 body");

  const teacher = build("each");
  assert.match(teacher, /\\handoutedition\{教师版\}/);
  assert.equal((teacher.match(/\\begin\{handoutanswer\}/g) ?? []).length, 5);
  assert.doesNotMatch(teacher, /handoutworkspace|handoutnotesarea|handoutanswerkey/);
});

test("a 小测 or 作业 prints one numbered list under its name, without 考点", () => {
  const student = buildList("none");
  assert.match(student, /\\handoutseries\{第一讲\\enspace 小测\}\n\\handouttitle\{平行四边形的性质\}\n\\handoutedition\{学生版\}\n\\handoutfields\{姓名,班级,得分\}/);
  assert.match(buildHandoutLatex({ title: "有理数", answers: "none", sheet: "作业", questions: [blank] }), /\\handoutseries\{作业\}\n\\handouttitle\{有理数\}/);
  const order = ["\\handoutnumberwidth{3}", "\\begin{handoutquestion}{1}", "\\begin{handoutquestion}{2}", "\\begin{handoutquestion}{3}"];
  const positions = order.map(marker => student.indexOf(marker));
  assert.ok(positions.every(position => position >= 0), order.filter((_, index) => positions[index] < 0).join(", "));
  assert.deepEqual([...positions].sort((x, y) => x - y), positions);
  assert.doesNotMatch(student, /handoutsection|handoutpart|handoutpoints|handoutnotesarea|handoutkey/);
  assert.equal((student.match(/\\handoutworkspace\{4\}/g) ?? []).length, 1, "the 解答题 gets working lines");
  const key = buildList("end");
  assert.match(key, /\\end\{handoutquestion\}\n\\handoutanswerkey\n\\begin\{handoutkey\}\{1\}/);
  assert.deepEqual([...key.matchAll(/\\begin\{handoutkey\}\{(\d+)\}/g)].map(match => match[1]), ["1", "2", "3"], "the key uses the list numbers");
  assert.doesNotMatch(key, /handoutkeygroup/);
  assert.equal((buildList("each").match(/\\begin\{handoutanswer\}/g) ?? []).length, 3);
  assert.doesNotMatch(buildHandoutLatex({ title: "空", answers: "none", sheet: "小测", questions: [] }), /handoutquestion|handoutnumberwidth/);
});

test("Word-imported stems keep formulas and tables", () => {
  const latex = build("none");
  assert.match(latex, /\\begin\{handoutquestion\}\{变式1\}\n根据下表求 \$\\frac\{a\}\{2\}\$。/);
  assert.match(latex, /\\begin\{tabular\}\{\|c\|c\|\}\\hline\n\\handoutheadrow 月份 & 销量 \\\\\\hline\n一月 & a\+12 \\\\\\hline\n\\end\{tabular\}/);
  assert.match(buildHandoutLatex({ title: "小测", modules, answers: "none" }), /\\handoutfields\{姓名,班级,得分\}/);
});

test("Word-imported pictures stay where the document put them, at its size", () => {
  const student = buildFigures("none");
  assert.match(student, /\\begin\{handoutquestion\}\{1\}\n【建立模型】\\par\n如图1，求证：AB=CD。\\par\n\\handoutfigureline\{l\}\{\\handoutfigure\[\.45\\textheight\]\{128\.3mm\}\{figures\/row\.png\}\}\\par\n【模型应用】如图2/);
  assert.equal((student.match(/figures\/row\.png/g) ?? []).length, 1, "a picture placed in the stem is not repeated beside or under it");
  assert.match(student, /\\begin\{handoutsidefigure\}\[0\.18\]\{figures\/beside\.png\}/, "a screenshot figure on the right keeps its share of the line");
  assert.match(student, /\\handoutfigureline\{l\}\{\\handoutfigure\[\.45\\textheight\]\{0\.62\\linewidth\}\{figures\/under\.png\}\}/, "a screenshot figure under the text keeps its share of the line");
  assert.doesNotMatch(student, /figures\/work\.png/, "学生版 prints no analysis");
  assert.match(buildFigures("end"), /\\handoutanalysis\{解答\}\{解：如图：\\par \\handoutfigureline\{l\}\{\\handoutfigure\[\.45\\textheight\]\{43\.4mm\}\{figures\/work\.png\}\}\\par 故 C\(6,2\)。\}/, "analysis pictures keep their place too");
  // A question is one unbreakable unit; the 教师版 answer box follows it and may run on to the next page.
  const teacher = buildFigures("each");
  assert.ok(teacher.match(/\\begin\{handoutquestion\}[\s\S]*?\\end\{handoutquestion\}/g).every(question => !question.includes("handoutanswer")), "no answer box sits inside a question");
  assert.equal((teacher.match(/\\end\{handoutquestion\}\n\\begin\{handoutanswer\}/g) ?? []).length, 3);
});

test("every handout command the generator emits is defined by the class", async () => {
  const cls = await readFile(new URL("../latex/mitty-handout.cls", import.meta.url), "utf8");
  const used = new Set([...["none", "end", "each"].flatMap(answers => [...`${build(answers)}${buildFigures(answers)}${buildList(answers)}`.matchAll(/\\(handout[a-z]+|makehandouttitle)/g)].map(match => match[1]))]);
  for (const command of used) assert.match(cls, new RegExp(`\\\\(?:newcommand|newenvironment|newtcolorbox)\\{?\\\\?${command}\\b`), `${command} is defined`);
});

test("the class file is well formed: every brace closes", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = (await readFile("latex/mitty-handout.cls", "utf8")).split("\n").map(line => line.replace(/(^|[^\\])%.*$/, "$1")).join("\n").replace(/\\[{}%\\]/g, "");
  let depth = 0;
  for (const [index, line] of source.split("\n").entries()) {
    for (const char of line) { if (char === "{") depth += 1; if (char === "}") depth -= 1; assert.ok(depth >= 0, `extra } on line ${index + 1}`); }
  }
  assert.equal(depth, 0, "every { has its }");
});
