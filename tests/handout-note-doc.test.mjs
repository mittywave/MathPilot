import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { loadSource } from "./load-source.mjs";
import { noteTableMarkup } from "../lib/handout-note.mjs";

// The editor module is loaded through require, so EditorState must come from the same ProseMirror copy.
const require = createRequire(import.meta.url);
const { EditorState, TextSelection } = require("prosemirror-state");
const { convertTypedMarkup, docFromNote, itemMarker, itemMarkerWidth, noteFromContent, noteFromDoc, noteSchema, sliceFromNote } = await loadSource("lib/handout-note-doc.ts");

const asset = "/api/assets/fb8325ca-36b9-4fc3-8665-954d96a84eb2";
const second = "/api/assets/0b8325ca-36b9-4fc3-8665-954d96a84eb2";

test("native table cells stay editable without losing spans, formulas, images or empty cells", () => {
  const cell = (content, colSpan = 1, rowSpan = 1) => ({ content, colSpan, rowSpan });
  const note = noteTableMarkup([
    [cell("反比例函数"), cell("$y=\\frac{k}{x}$，$k\\ne0$", 2)],
    [cell("图象", 1, 2), cell("$k>0$"), cell("$k<0$")],
    [cell(`![](${asset})`), cell(`![](${second})`)],
    [cell("性质"), cell("**增大而减小**"), cell("")],
  ]);
  const doc = docFromNote(note); doc.check();
  const table = doc.firstChild;
  assert.equal(table.type.name, "table");
  assert.equal(table.child(0).child(1).attrs.colSpan, 2);
  assert.equal(table.child(1).child(0).attrs.rowSpan, 2);
  assert.equal(table.child(2).child(0).firstChild.type.name, "figure_row");
  assert.equal(table.child(0).child(1).firstChild.firstChild.type.name, "math");
  assert.equal(noteFromDoc(doc), note);
  const tr = EditorState.create({ doc }).tr.insertText("可编辑", 4);
  tr.doc.check();
  assert.match(noteFromDoc(tr.doc), /可编辑反比例函数/);
  assert.equal(noteFromDoc(docFromNote(noteFromDoc(tr.doc))), noteFromDoc(tr.doc));
});
const recognized = [
  "# 正方形的概念与性质",
  "## 正方形的概念",
  "既是矩形又是菱形的四边形叫做正方形.",
  "## 正方形的判定",
  "判定一个四边形是正方形时，只需要分别判定这个四边形既是矩形，又是菱形，具体地途径是：",
  "（1）**先证它是矩形，再证它有一组邻边相等或对角线垂直；**",
  "（2）**先证它是菱形，再证它有一个角为直角或对角线相等.**",
  "如图，正方形 $ABCD$ 对角线交于点 $P$.",
  `![](${asset})`,
  "容易证明，$\\triangle APB$、$\\triangle BPC$ 均为等腰直角三角形，请同学们尝试证明.",
  "### 拉窗帘",
  `![$O$ 可在 $y$ 轴上移动](${asset}) ![](${second})`,
  "> $S_{\\triangle ABO}=\\frac{1}{2}|k|$，**同底等高**",
  "> $\\therefore S_{\\triangle AMB}=|k|$",
  "∵ 双曲线中心对称",
  "∴ $MO$ 为中线",
].join("\n");

const inline = block => [...Array(block.childCount).keys()].map(i => { const child = block.child(i); return child.isText ? `${child.marks.length ? "B" : ""}"${child.text}"` : `${child.marks.length ? "B" : ""}math(${child.attrs.latex})`; }).join(" ");
const shape = doc => { const out = []; doc.forEach(block => out.push(block.type.name === "figure_row"
  ? `row:${[...Array(block.childCount).keys()].map(i => { const child = block.child(i); return child.type.name === "figure" ? `fig(${child.attrs.src.slice(-4)}|${inline(child)})` : `side(${[...Array(child.childCount).keys()].map(j => inline(child.child(j))).join(" / ")})`; }).join(" ")}`
  : `${block.type.name}${block.type.name === "heading" ? block.attrs.level : ""}:${inline(block)}`)); return out; };
const typed = (text, type = "paragraph") => {
  const doc = noteSchema.node("doc", null, [noteSchema.nodes[type].create(null, text ? noteSchema.text(text) : null)]);
  const state = EditorState.create({ doc, selection: TextSelection.atEnd(doc) });
  const tr = state.tr;
  return { changed: convertTypedMarkup(tr, 0), doc: tr.doc, tr };
};

test("a recognized note opens as headings, bold points, formulas and rows of figures, and saves back unchanged", () => {
  const doc = docFromNote(recognized);
  assert.deepEqual(shape(doc).slice(0, 3), ["heading1:\"正方形的概念与性质\"", "heading2:\"正方形的概念\"", "paragraph:\"既是矩形又是菱形的四边形叫做正方形.\""]);
  assert.equal(shape(doc)[5], "paragraph:\"（1）\" B\"先证它是矩形，再证它有一组邻边相等或对角线垂直；\"");
  assert.equal(shape(doc)[7], "paragraph:\"如图，正方形 \" math(ABCD) \" 对角线交于点 \" math(P) \".\"");
  assert.equal(shape(doc)[8], "row:fig(4eb2|)");
  assert.equal(shape(doc)[9], "paragraph:\"容易证明，\" math(\\triangle APB) \"、\" math(\\triangle BPC) \" 均为等腰直角三角形，请同学们尝试证明.\"");
  assert.equal(shape(doc)[10], "heading3:\"拉窗帘\"");
  assert.equal(shape(doc)[11], "row:fig(4eb2|math(O) \" 可在 \" math(y) \" 轴上移动\") fig(4eb2|) side(math(S_{\\triangle ABO}=\\frac{1}{2}|k|) \"，\" B\"同底等高\" / math(\\therefore S_{\\triangle AMB}=|k|))");
  assert.equal(noteFromDoc(doc), recognized);
  assert.equal(noteFromDoc(docFromNote(`![图](${asset})`)), `![](${asset})`, "a figure saved before captions existed keeps no caption");
});

test("markup is normalized, never misread", () => {
  assert.equal(noteFromDoc(docFromNote("  ###   小结  \n\n**甲 $x$ 乙**\n![外链](https://example.com/a.png)\n\\(y\\) 与 $$z$$\n**粗**中")), "### 小结\n**甲 $x$ 乙**\n$y$ 与 $$z$$\n**粗**中");
  assert.equal(noteFromDoc(docFromNote("## **标题里不加粗**")), "## 标题里不加粗");
  assert.equal(noteFromDoc(docFromNote("")), "");
  assert.equal(noteFromDoc(docFromNote("$$a=b$$ $$=c$$ 同底等高")), "$$a=b$$$$=c$$ 同底等高", "no empty line between display formulas");
  assert.equal(docFromNote("").childCount, 1, "an empty note is one empty paragraph");
  assert.equal(noteFromDoc(noteSchema.node("doc", null, [noteSchema.nodes.paragraph.create(null, [noteSchema.text("设 "), noteSchema.nodes.math.create({ latex: "" })])])), "设", "an unfinished formula is not saved");
});

test("shorthand typed into the editor turns into what it means", () => {
  assert.deepEqual(shape(typed("面积 $\\frac{1}{2}ah$ 公式").doc), ["paragraph:\"面积 \" math(\\frac{1}{2}ah) \" 公式\""]);
  assert.deepEqual(shape(typed("先**证矩形**再").doc), ["paragraph:\"先\" B\"证矩形\" \"再\""]);
  const closed = typed("**重点**");
  assert.deepEqual(shape(closed.doc), ["paragraph:B\"重点\""]);
  assert.deepEqual(closed.tr.storedMarks, [], "typing after the closing ** is plain again");
  assert.deepEqual(shape(typed("**对角线 $AC=BD$ 相等**").doc), ["paragraph:B\"对角线 \" Bmath(AC=BD) B\" 相等\""]);
  assert.deepEqual(shape(typed("## 正方形的判定").doc), ["heading2:\"正方形的判定\""]);
  assert.deepEqual(shape(typed("# 大标题").doc), ["heading1:\"大标题\""]);
  assert.deepEqual(shape(typed("### **x** 与 $y$").doc), ["heading3:\"x 与 \" math(y)"]);
  assert.deepEqual(shape(typed("#标签 $5 和 6").doc), ["paragraph:\"#标签 $5 和 6\""], "unfinished shorthand stays as typed");
  assert.equal(typed("普通文字").changed, false);
});

test("pasted text arrives formatted and copied content keeps its meaning", () => {
  const doc = docFromNote("甲乙");
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, 2) });
  const pasted = state.tr.replaceSelection(sliceFromNote("A**B**\n## 小标题\n$x$ 在中间")).doc;
  assert.equal(noteFromDoc(pasted), "甲A**B**\n## 小标题\n$x$ 在中间乙");
  const atEnd = EditorState.create({ doc, selection: TextSelection.create(doc, 3) });
  assert.equal(noteFromDoc(atEnd.tr.replaceSelection(sliceFromNote("\n## 粘贴的小标题\n（1）**要点** 与 $x^2$")).doc), "甲乙\n## 粘贴的小标题\n（1）**要点** 与 $x^2$", "a pasted heading stays a heading");
  const empty = docFromNote("");
  assert.equal(noteFromDoc(EditorState.create({ doc: empty }).tr.replaceSelection(sliceFromNote("## 标题\n正文")).doc), "## 标题\n正文");
  assert.equal(noteFromDoc(atEnd.tr.replaceSelection(sliceFromNote("一句话")).doc), "甲乙一句话", "a single line is pasted inline");
  const source = docFromNote("（1）**先证 $AB=CD$**，再证明");
  assert.equal(noteFromContent(source.slice(5, source.content.size - 1).content), "**证 $AB=CD$**，再证明");
  assert.equal(noteFromContent(source.slice(5, source.content.size - 1, true).content), "**证 $AB=CD$**，再证明", "as the clipboard copies it");
  const twoLines = docFromNote("## 判定\n先证 $x$");
  assert.equal(noteFromContent(twoLines.slice(2, twoLines.content.size - 1, true).content), "## 定\n先证 $x$");
});

test("items keep their marker as text and get a matching indent", () => {
  const [first, second, plain] = ["（1）先证矩形", "① 甲", "（1）"].map(note => docFromNote(note).firstChild);
  assert.equal(itemMarker(first), "（1）");
  assert.equal(itemMarker(second), "①");
  assert.equal(itemMarker(plain), null, "a marker alone is not an item yet");
  assert.equal(itemMarkerWidth("（1）"), 3);
  assert.equal(itemMarkerWidth("①"), 1.4);
  assert.equal(Math.round(itemMarkerWidth("1.") * 10) / 10, 1.6);
});

test("rows of figures paste and copy as rows, and their captions take typed shorthand", () => {
  const doc = docFromNote("甲乙");
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, 3) });
  const row = `![$S_①$](${asset}) ![](${second})\n> 旁注`;
  assert.equal(noteFromDoc(state.tr.replaceSelection(sliceFromNote(`${row}\n丙`)).doc), `甲乙\n${row}\n丙`, "a pasted row stays a row of its own");
  const rows = docFromNote(row);
  assert.equal(noteFromContent(rows.slice(0, rows.content.size, true).content), row);
  const caption = rows.firstChild.firstChild;
  const withCaret = EditorState.create({ doc: rows, selection: TextSelection.create(rows, 2 + caption.content.size) });
  const tr = withCaret.tr.insertText(" 与 $T_②$");
  assert.ok(convertTypedMarkup(tr, 1), "the caption is a line like any other");
  assert.equal(noteFromDoc(tr.doc), `![$S_①$ 与 $T_②$](${asset}) ![](${second})\n> 旁注`);
  assert.equal(noteFromDoc(docFromNote(`![](${asset}) ∵甲 ∴乙`)), `![](${asset})\n> ∵甲\n> ∴乙`, "a note written on the row's line is saved one step per line");
});
