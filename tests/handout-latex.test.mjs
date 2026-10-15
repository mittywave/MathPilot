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
  assert.equal((student.match(/\\handoutnotesarea\{6\}/g) ?? []).length, 2, "学生版 例题 get a note area");
  assert.equal((student.match(/\\handoutworkspace\{6\}/g) ?? []).length, 1, "only the 变式 解答题 gets working lines");
  assert.doesNotMatch(student, /handoutlinepitch/, "a 讲义 keeps the class's line pitch");
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
  assert.equal((student.match(/\\handoutworkspace\{6\}/g) ?? []).length, 1, "the 解答题 gets working lines");
  const key = buildList("end");
  assert.match(key, /\\end\{handoutquestion\}\n\\handoutanswerkey\n\\begin\{handoutkey\}\{1\}/);
  assert.deepEqual([...key.matchAll(/\\begin\{handoutkey\}\{(\d+)\}/g)].map(match => match[1]), ["1", "2", "3"], "the key uses the list numbers");
  assert.doesNotMatch(key, /handoutkeygroup/);
  assert.equal((buildList("each").match(/\\begin\{handoutanswer\}/g) ?? []).length, 3);
  assert.doesNotMatch(buildHandoutLatex({ title: "空", answers: "none", sheet: "小测", questions: [] }), /handoutquestion|handoutnumberwidth/);
});

test("sheets keep permanent library IDs with optional sources across editions, reordered sections and days", () => {
  const questions = [{ ...docx, code: "10023" }, { ...choice, code: "0046" }, { ...proof, code: "0921" }, { ...blank, id: "typeset-4" }];
  for (const answers of ["none", "end", "each"]) {
    for (const groupMode of [undefined, "sections", "days"]) {
      for (const showSource of [false, true]) {
        const source = buildHandoutLatex({ title: "练习", sheet: "练习", answers, showSource, questions,
          ...(groupMode ? { groupMode, groups: [{ title: "第一组", size: 2 }, { title: "第二组", size: 2 }] } : {}),
        }, () => "figures/proof.png");
        const bodies = [...source.matchAll(/\\begin\{handoutquestion\}\{(\d+)\}\n([\s\S]*?)\\end\{handoutquestion\}/g)];
        assert.deepEqual(bodies.map((body) => body[1]), groupMode === "days" ? ["1", "2", "1", "2"] : ["1", "2", "3", "4"]);
        assert.deepEqual([...source.matchAll(/\\handoutsource\{ID ([^}]+)\}/g)].map((match) => match[1]), ["10023", "0046", "0921"], "IDs come from the questions, preserve leading zeros and do not restart with daily numbering");
        assert.match(bodies[0][2], /^\\handoutsource\{ID 10023\}根据下表求/);
        assert.ok(bodies[1][2].startsWith(`\\handoutsource{ID 0046}${showSource ? "\\handoutsource{2024 期中}" : ""}方程`), "hiding provenance keeps the permanent ID ahead of the stem");
        assert.equal(source.includes("2024 期中"), showSource, "the source setting applies to every edition and group mode");
        assert.match(bodies[2][2], /\\begin\{handoutsidefigure\}[^\n]*\n\\handoutsource\{ID 0921\}如图/);
        assert.doesNotMatch(bodies[3][2], /ID |typeset-4/, "an unbanked Word question gets no invented library ID");
        assert.match(bodies[0][2], /\\begin\{tabular\}/, "the ID keeps the original Word table");
      }
    }
  }
  assert.doesNotMatch(buildHandoutLatex({ title: "讲义", answers: "none", modules: [{ heading: "", note: "", bands: { ...empty, practice: questions } }] }), /\\handoutsource\{ID /, "the existing module handout path keeps its layout");
});

test("Word-imported stems keep formulas and tables", () => {
  const latex = build("none");
  assert.match(latex, /\\begin\{handoutquestion\}\{变式1\}\n根据下表求 \$\\displaystyle \\frac\{a\}\{2\}\$。/);
  assert.match(latex, /\\begin\{tabular\}\{\|c\|c\|\}\\hline\n\\handoutheadrow 月份 & 销量 \\\\\\hline\n一月 & \$a\+12\$ \\\\\\hline\n\\end\{tabular\}/);
  assert.match(buildHandoutLatex({ title: "小测", modules, answers: "none" }), /\\handoutfields\{姓名,班级,得分\}/);
});

test("Word-imported pictures stay where the document put them, at its size", () => {
  const student = buildFigures("none");
  assert.match(student, /\\begin\{handoutquestion\}\{1\}\n【建立模型】\\par\n如图1，求证：\$AB=CD\$。\\par\n\\handoutfigureline\{l\}\{\\handoutfigure\[\.45\\textheight\]\{128\.3mm\}\{figures\/row\.png\}\}\\par\n【模型应用】如图2/);
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

// Word documents type many formulas as plain runs: italic letters, full-width （）＝﹣ and superscript runs.
const run = (value, props = "") => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${value}</w:t></w:r>`;
const italic = value => run(value, "<w:i/>");
const sup = value => run(value, '<w:vertAlign w:val="superscript"/>');
const equation = body => `<m:oMath>${body}</m:oMath>`;
const fraction = (num, den) => `<m:f><m:num><m:r><m:t>${num}</m:t></m:r></m:num><m:den><m:r><m:t>${den}</m:t></m:r></m:den></m:f>`;
const stemOf = (...paragraphs) => buildHandoutLatex({ title: "练习", answers: "none", sheet: "练习", questions: [{ ...base, id: "w", type: "填空题", stem: "", stemDocxXml: paragraphs.map(wordParagraph) }] })
  .match(/\\begin\{handoutquestion\}\{1\}\n([\s\S]*?)\n\\end\{handoutquestion\}/)[1];

test("formulas typed as Word text are set as one formula, like the document's equations", () => {
  assert.equal(stemOf(run("1．") + run("（6）5（3") + italic("x") + run("﹣4）﹣2（") + italic("x") + run("﹣1）＝5（2") + italic("x") + run("﹣1）．")), "（6）$5(3x-4)-2(x-1)=5(2x-1)$．");
  assert.equal(stemOf(run("1．如果方程（") + italic("m") + run("+1）") + italic("x") + sup("2|") + run("m", '<w:i/><w:vertAlign w:val="superscript"/>') + sup("|﹣1") + run("+2＝0是关于") + italic("x") + run("的一元一次方程")),
    "如果方程$(m+1)x^{2|m|-1}+2=0$是关于$x$的一元一次方程", "superscript runs become one exponent");
  assert.equal(stemOf(run("1．（2）3") + italic("x") + run("﹣") + equation(fraction(1, 4)) + italic("x") + run("＝11；")), "（2）$\\displaystyle 3x- \\frac{1}{4} x=11$；", "text and a Word equation beside it make one formula");
  assert.equal(stemOf(run("1．（3）") + equation("<m:r><m:t>x：2.4=5：</m:t></m:r>" + fraction(1, 5)) + run("．")), "（3）$\\displaystyle x:2.4=5:\\frac{1}{5}$．", "a ratio's colon is the ratio sign");
  assert.equal(stemOf(run("1．在Rt△") + italic("ABC") + run("中，∠") + italic("C") + run("＝90°，长25") + italic("cm")), "在$\\mathrm{Rt}\\triangle ABC$中，$\\angle C=90^{\\circ}$，长$25\\mathrm{cm}$");
});

test("text that only looks like a formula stays text", () => {
  assert.equal(stemOf(run("1．2026-2027学年第（1）题，得分18%，x=____")), "2026-2027学年第（1）题，得分18\\%，$x=$\\handoutblank{3.0em}");
  assert.equal(stemOf(run("1．在□ABCD中，（　　）")), "在$\\parallelogram ABCD$中，（　　）");
  assert.equal(stemOf(run("1．Find the value of x such that 2x + 3 = 7.")), "Find the value of x such that $2x + 3 = 7$.", "English words are not variables");
});

test("a sheet can set the room after each question", () => {
  const sheet = spacing => buildHandoutLatex({ title: "练习", answers: "none", sheet: "练习", questions: [choice, proof, blank], spacing });
  assert.equal((sheet().match(/\\handoutworkspace\{6\}/g) ?? []).length, 1, "without spacing a 解答题 gets six lines");
  assert.doesNotMatch(sheet(), /handoutlinepitch/);
  assert.match(buildHandoutLatex({ title: "练习", answers: "none", sheet: "练习", questions: [proof], linePitch: 10 }), /\\handoutfields\{[^}]*\}\n\\handoutlinepitch\{10mm\}\n\\begin\{document\}/, "the line pitch is set before the document");
  assert.doesNotMatch(sheet(), /handoutgap/);
  const set = sheet([6, 2, 12.5]);
  assert.match(set, /\\end\{handoutchoices\}\n\\handoutgap\{6\}\n\\end\{handoutquestion\}/, "a choice question gets blank millimetres");
  assert.match(set, /\\handoutworkspace\{2\}\n\\end\{handoutquestion\}/, "a 解答题 gets that many answer lines");
  assert.match(set, /\\handoutgap\{12\.5\}/);
  assert.doesNotMatch(sheet([0, 0, 0]), /handoutgap|handoutworkspace/, "nothing left blank");
  assert.doesNotMatch(buildHandoutLatex({ title: "练习", answers: "each", sheet: "练习", questions: [choice, proof], spacing: [6, 3] }), /handoutgap|handoutworkspace/, "教师版 leaves no room");
});

test("every handout command the generator emits is defined by the class", async () => {
  const cls = await readFile(new URL("../latex/mitty-handout.cls", import.meta.url), "utf8");
  const spaced = buildHandoutLatex({ title: "练习", answers: "none", sheet: "练习", questions: [choice, proof], spacing: [4, 3], linePitch: 9 });
  const used = new Set([...["none", "end", "each"].flatMap(answers => [...`${build(answers)}${buildFigures(answers)}${buildList(answers)}${spaced}`.matchAll(/\\(handout[a-z]+|makehandouttitle)/g)].map(match => match[1]))]);
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

test("a sheet in days (智能组卷): each day under its own heading from a new page, numbers from 1, the key in days", () => {
  const days = [{ title: "第 1 天 · 去括号", size: 2 }, { title: "第 2 天 · 通分", size: 1 }];
  const source = buildHandoutLatex({ title: "计算打卡", answers: "end", sheet: "练习", questions: [proof, blank, { ...blank, id: "f" }], groups: days });
  assert.match(source, /\\handoutfields\{姓名,班级\}/, "each day scores itself; the title keeps name and class");
  assert.match(source, /\\handoutnumberwidth\{2\}/, "the number column fits the longest day");
  const order = ["\\handoutgroup{第 1 天 · 去括号}{2}", "{1}", "{2}", "\\handoutgroup{第 2 天 · 通分}{1}", "{1}", "\\handoutanswerkey", "\\handoutkeygroup{第 1 天 · 去括号}{2}", "\\begin{handoutkey}{1}", "\\begin{handoutkey}{2}", "\\handoutkeygroup{第 2 天 · 通分}{1}", "\\begin{handoutkey}{1}"];
  order.reduce((from, marker) => { const index = source.indexOf(marker, from); assert.ok(index >= 0, `missing ${marker} after ${from}`); return index + marker.length; }, 0);
  // Groups that do not cover every question (or are empty) are ignored rather than misnumbering the sheet.
  const plain = buildHandoutLatex({ title: "练习", answers: "none", sheet: "练习", questions: [proof, blank], groups: [{ title: "第 1 天", size: 1 }] });
  assert.doesNotMatch(plain, /handoutgroup/);
  assert.match(plain, /\\handoutfields\{姓名,班级,得分\}/);
  assert.match(buildHandoutLatex({ title: "练习", answers: "none", sheet: "练习", questions: [proof], groups: [{ title: "第 1 天", size: 1 }, { title: "第 2 天", size: 0 }] }), /\\handoutgroup\{第 1 天\}\{1\}/);
});

test("basket sections flow naturally, keep global question anchors/numbers, and repeat headings in the key", () => {
  const groups = [{ title: "一、热身", size: 2 }, { title: "二、应用", size: 1 }];
  const input = { title: "结构化组卷", sheet: "练习", questions: [proof, blank, { ...blank, id: "third" }], groups, groupMode: "sections" };
  for (const answers of ["none", "end", "each"]) {
    const source = buildHandoutLatex({ ...input, answers });
    assert.match(source, /\\handoutfields\{姓名,班级,得分\}/);
    assert.match(source, /\\handoutnumberwidth\{3\}/);
    assert.doesNotMatch(source, /\\handoutgroup\{/);
    assert.deepEqual([...source.matchAll(/\\begin\{handoutquestion\}\{(\d+)\}/g)].map((match) => match[1]), ["1", "2", "3"]);
    assert.match(source, /\\handoutsection\{\}\{一、热身\}/);
    assert.match(source, /\\handoutsection\{\}\{二、应用\}/);
    if (answers === "end") {
      const key = source.slice(source.indexOf("\\handoutanswerkey"));
      assert.match(key, /\\handoutkeygroup\{一、热身\}\{3\}/);
      assert.match(key, /\\handoutkeygroup\{二、应用\}\{3\}/);
      assert.deepEqual([...key.matchAll(/\\begin\{handoutkey\}\{(\d+)\}/g)].map((match) => match[1]), ["1", "2", "3"]);
    }
  }
});
