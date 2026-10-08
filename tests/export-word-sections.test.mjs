import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";
import { loadSource } from "./load-source.mjs";

const { buildWordBlob, handoutWordSections } = await loadSource("lib/export-word.ts");
const base = { categoryId: "one", difficulty: "基础", tags: [], analysis: "" };
const questions = [
  { ...base, id: "a", type: "解答题", stem: "ALPHAQUESTION", options: [], answer: "ALPHAANSWER", analysis: "ALPHAANALYSIS" },
  { ...base, id: "b", type: "单选题", stem: "BETAQUESTION", options: ["一", "二", "三", "四"], answer: "BETAANSWER" },
  { ...base, id: "c", type: "填空题", stem: "GAMMAQUESTION", options: [], answer: "GAMMAANSWER" },
];
const sections = [
  { heading: "一、知识梳理", note: "SUMMARYLINE 分数 $\\frac{1}{2}$\n\nSECONDLINE", questions: [] },
  { heading: "二、例题精讲", note: "", questions: questions.slice(0, 2) },
  { heading: "", questions: questions.slice(2) },
];

async function documentXml(answers) {
  const blob = await buildWordBlob({ title: "第3讲 讲义", sections, answers });
  return (await JSZip.loadAsync(await blob.arrayBuffer())).file("word/document.xml").async("string");
}

function order(xml, markers) {
  const positions = markers.map(marker => { const index = xml.indexOf(marker); assert.ok(index >= 0, `missing ${marker}`); return index; });
  assert.deepEqual([...positions].sort((x, y) => x - y), positions, `out of order: ${markers.join(" → ")}`);
}

test("handout sections keep headings, notes and continuous numbering in order", async () => {
  const xml = await documentXml("none");
  order(xml, ["一、知识梳理", "SUMMARYLINE", "SECONDLINE", "二、例题精讲", "ALPHAQUESTION", "BETAQUESTION", "GAMMAQUESTION"]);
  assert.match(xml, /<m:f>/, "a formula in the note becomes native Word math");
  assert.match(xml, /3．<\/w:t>[\s\S]*?GAMMAQUESTION/, "numbering continues across sections");
  assert.doesNotMatch(xml, /试题（共/, "an empty heading adds no paragraph");
  assert.doesNotMatch(xml, /ALPHAANSWER|参考答案与试题解析/);
});

test("answers can be omitted, collected at the end, or placed after each question", async () => {
  const end = await documentXml("end");
  order(end, ["GAMMAQUESTION", "参考答案与试题解析", "1．答案：", "ALPHAANSWER", "ALPHAANALYSIS", "2．答案：", "BETAANSWER", "3．答案：", "GAMMAANSWER"]);
  const each = await documentXml("each");
  order(each, ["ALPHAQUESTION", "ALPHAANSWER", "ALPHAANALYSIS", "BETAQUESTION", "BETAANSWER", "GAMMAQUESTION", "GAMMAANSWER"]);
  assert.doesNotMatch(each, /参考答案与试题解析|．答案：/, "inline answers have no end page or repeated numbers");
  const between = each.slice(each.indexOf("ALPHAQUESTION"), each.indexOf("ALPHAANSWER"));
  assert.doesNotMatch(between, /\u3000/, "no blank working lines when the answer follows directly");
});

test("section notes keep sub-headings, bold points and figures in Word", async t => {
  const OriginalImage = globalThis.Image; const originalFetch = globalThis.fetch;
  // Only browser image decoding and the asset request are stubbed; the DOCX builder is real.
  globalThis.Image = class { naturalWidth = 160; naturalHeight = 100; set src(_value) { queueMicrotask(() => this.onload()); } };
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVQIHWP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
  globalThis.fetch = async () => new Response(png, { headers: { "Content-Type": "image/png" } });
  t.after(() => { globalThis.fetch = originalFetch; if (OriginalImage === undefined) delete globalThis.Image; else globalThis.Image = OriginalImage; });
  const note = "## 正方形的判定\n（1）**先证它是矩形**，再证邻边相等\n![图](/api/assets/0123abcd-0123-4567-89ab-0123456789ab)\n普通说明";
  const blob = await buildWordBlob({ title: "讲义", answers: "none", sections: [{ heading: "一、正方形", note, questions: [] }] });
  const xml = await (await JSZip.loadAsync(await blob.arrayBuffer())).file("word/document.xml").async("string");
  const run = text => (xml.match(/<w:r>(?:(?!<\/w:r>)[\s\S])*?<\/w:r>/g) ?? []).find(item => item.includes(text)) ?? "";
  assert.match(run("正方形的判定"), /<w:b\/>/, "sub-heading is bold");
  assert.match(run("先证它是矩形"), /<w:b\/>/, "bold span stays bold");
  assert.doesNotMatch(run("再证邻边相等"), /<w:b\/>/);
  assert.match(xml, /<w:ind w:left="420" w:hanging="420"\/>[\s\S]*?（1）/, "points hang their marker");
  order(xml, ["正方形的判定", "先证它是矩形", "<w:drawing>", "普通说明"]);

  // Heading levels and a row of figures with captions and the note beside them.
  const asset = "/api/assets/0123abcd-0123-4567-89ab-0123456789ab";
  const rowNote = `# 大标题\n### 面积相等\n![$S_①=S_②$](${asset}) ![图注二](${asset}) 旁边的说明 **同底等高**`;
  const rowBlob = await buildWordBlob({ title: "讲义", answers: "none", sections: [{ note: rowNote, questions: [] }] });
  const rowXml = await (await JSZip.loadAsync(await rowBlob.arrayBuffer())).file("word/document.xml").async("string");
  const rowRun = text => (rowXml.match(/<w:r>(?:(?!<\/w:r>)[\s\S])*?<\/w:r>/g) ?? []).find(item => item.includes(text)) ?? "";
  assert.match(rowRun("大标题"), /<w:sz w:val="26"\/>/, "大标题 is 13pt");
  assert.match(rowRun("面积相等"), /<w:sz w:val="21"\/>/, "更小的标题 is body size");
  const table = rowXml.slice(rowXml.indexOf("<w:tbl>"), rowXml.indexOf("</w:tbl>"));
  assert.equal((table.match(/<w:tc>/g) ?? []).length, 3, "two figure cells and one for the note beside them");
  assert.equal((table.match(/<w:drawing>/g) ?? []).length, 2);
  // $S_①=S_②$ is a simple formula, so it is set as text: S with a subscript ①.
  ["<w:drawing>", '<w:vertAlign w:val="subscript"/>', "<w:drawing>", "图注二", "旁边的说明", "同底等高"].reduce((from, marker) => {
    const index = table.indexOf(marker, from); assert.ok(index >= 0, `missing ${marker} after ${from}`); return index + marker.length;
  }, 0);
  assert.match(rowRun("图注二"), /<w:sz w:val="18"\/>/, "captions are set small");
});

test("a 讲义 in Word follows 模块 → 知识点 → 例题 → 练习 → 变式 with the PDF's numbering", async () => {
  const q = (id, type, extra = {}) => ({ ...base, id, type, stem: `${id}STEM`, options: [], answer: `${id}ANSWER`, ...extra });
  const modules = [
    { heading: "一、平行四边形的性质", note: "对边相等", bands: { example: [q("EXONE", "填空题", { tags: ["平行四边形的性质"] })], practice: [q("PRONE", "解答题")], variant: [q("VAONE", "解答题")] } },
    { heading: "判定", note: "", bands: { example: [q("EXTWO", "填空题")], practice: [], variant: [] } },
  ];
  const text = async answers => {
    const blob = await buildWordBlob({ title: "第一讲", sections: handoutWordSections(modules, answers), answers });
    return (await (await JSZip.loadAsync(await blob.arrayBuffer())).file("word/document.xml").async("string")).replace(/<[^>]+>/g, "");
  };
  const student = await text("none");
  order(student, ["模块一\u3000平行四边形的性质", "知识点\u3000本模块要掌握的内容", "对边相等", "例题\u3000跟着老师，看知识点怎么用", "例1．EXONESTEM", "考点：平行四边形的性质", "课堂笔记",
    "练习\u3000自己动手，检验掌握", "1．PRONESTEM", "变式\u3000换个情境，抓住本质", "变式1．VAONESTEM", "模块二\u3000判定", "例2．EXTWOSTEM"]);
  assert.doesNotMatch(student, /答案：/);
  const key = await text("end");
  order(key, ["EXTWOSTEM", "参考答案与试题解析", "例题解析", "例1．答案：EXONEANSWER", "例2．答案：EXTWOANSWER", "练习答案", "1．答案：PRONEANSWER", "变式答案", "变式1．答案：VAONEANSWER"]);
  assert.match(key, /课堂笔记/);
  const teacher = await text("each");
  order(teacher, ["EXONESTEM", "答案：", "EXONEANSWER", "PRONESTEM", "PRONEANSWER"]);
  assert.doesNotMatch(teacher, /课堂笔记|例题解析/);
});

test("formulas the small converter cannot read become native Word equations, never leaked commands", async () => {
  const note = [
    "$\\begin{cases}\\text{正数：}\\underline{\\text{大于 0}}\\\\\\text{负数}\\end{cases}$",
    "变化：$\\left[\\begin{array}{ll}上升+&\\uparrow\\\\下降-&\\downarrow\\end{array}\\right.$",
    "**统称有理数**；$\\begin{cases}\\text{**整数**}\\\\\\text{**分数**}\\end{cases}$ 是\\underline{有理数}，$\\overline{AB}$ 与 $\\frac{1}{2}$",
  ].join("\n");
  const blob = await buildWordBlob({ title: "t", answers: "none", sections: [{ note, questions: [] }] });
  const xml = await (await JSZip.loadAsync(await blob.arrayBuffer())).file("word/document.xml").async("string");
  const text = xml.replace(/<[^>]+>/g, "");
  assert.doesNotMatch(text, /begin|end(cases|array)|underline|overline|textbf|__ZHITI/, "no command names leak into the text");
  assert.equal((xml.match(/<m:d>/g) ?? []).length, 3, "cases and arrays get stretching brackets");
  assert.equal((xml.match(/<m:pos m:val="bot"\/>/g) ?? []).length, 2, "underlines are bars below");
  assert.equal((xml.match(/<m:pos m:val="top"\/>/g) ?? []).length, 1, "overlines are bars above");
  assert.match(xml, /<m:sty m:val="b"\/>/, "bold inside a formula stays bold");
  assert.doesNotMatch(xml, /m:argPr|<m:sub\/>/, "no repeated argument properties or empty scripts");
  for (const [run] of xml.matchAll(/<m:r>(?:(?!<\/m:r>)[\s\S])*<\/m:r>/g)) assert.doesNotMatch(run, /<w:rPr>[\s\S]*<m:rPr>/, "math run properties come first");
  assert.match(xml, /<m:f>/, "simple formulas still use the original converter");
});

test("simple formulas are set as text like printed papers; structured ones stay equations with upright numbers", async () => {
  const question = { ...base, id: "u", type: "单选题", stem: "单位长度是$1\\text{ cm}$，$v_{0}=60$，$\\angle A=30^{\\circ}$，$-\\frac{1}{3}$", options: ["$5.4$", "$-2.4$", "$a\\neq0$", "$\\sqrt{4}$"], answer: "" };
  const blob = await buildWordBlob({ title: "t", sections: [{ questions: [question] }], answers: "none" });
  const xml = await (await JSZip.loadAsync(await blob.arrayBuffer())).file("word/document.xml").async("string");
  const textRuns = [...xml.matchAll(/<w:r>((?:(?!<\/w:r>)[\s\S])*?)<w:t[^>]*>([^<]*)<\/w:t><\/w:r>/g)].map(([, props, text]) => ({ text, italic: /<w:i\/>/.test(props), sub: /subscript/.test(props) }));
  const find = (text) => textRuns.find((run) => run.text === text);
  // Letters italic, digits and units upright, full-width ＝ and ﹣, v₀ with a real subscript.
  for (const text of ["v", "a", "A"]) assert.equal(find(text)?.italic, true, `${text} italic`);
  // A sign stays tight to its number (−2.4); ＝ is spaced.
  for (const text of ["1 cm", "＝60", "＝30°", "5.4", "−2.4"]) assert.ok(find(text) && !find(text).italic, `${text} upright text`);
  assert.equal(find("0")?.sub, true, "v₀ subscript");
  // Fractions and roots remain Word equations; their numbers are upright there too.
  const equations = xml.match(/<m:oMath\b[\s\S]*?<\/m:oMath>/g) ?? [];
  assert.equal(equations.length, 2);
  assert.ok(equations.every((math) => [...math.matchAll(/<m:r>((?:(?!<\/m:r>)[\s\S])*?)<m:t[^>]*>([0-9]+)<\/m:t>/g)].every(([, props]) => /<m:sty m:val="p"\/>/.test(props))));
  assert.doesNotMatch(xml, /[\uE200\uE201\u303F]/);
});
