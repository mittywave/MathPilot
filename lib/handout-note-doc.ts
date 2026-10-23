import { Schema, Slice, type Fragment, type Node as ProseNode } from "prosemirror-model";
import type { Transaction } from "prosemirror-state";
import { ITEM_MARKER, SAFE_IMAGE, escapeCaption, noteTableMarkup, parseHandoutNote, type NoteSpan } from "./handout-note.mjs";
import { scanMathSource } from "./math-source.mjs";
import { splitMathText } from "./math-text";

// The 知识点 note is still stored in its light markup, which the PDF and Word exports read.
// The editor only changes how it is edited: headings, bold text, formulas and rows of figures with
// their captions appear as themselves, never as #, **, $ or ![图注](…).
const mathMarkup = (node: ProseNode) => node.attrs.display ? `$$${node.attrs.latex}$$` : `$${node.attrs.latex}$`;

export const noteSchema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*", parseDOM: [{ tag: "p" }], toDOM: () => ["p", 0] },
    // 大标题 / 小标题 / 更小的标题 are levels 1–3, shown as h3–h5.
    heading: {
      group: "block", content: "inline*", marks: "", attrs: { level: { default: 2 } },
      parseDOM: [1, 2, 3].map((level) => ({ tag: `h${level + 2}`, attrs: { level } })),
      toDOM: (node) => [`h${Number(node.attrs.level) + 2}`, 0],
    },
    table: {
      group: "block", content: "table_row+", isolating: true,
      parseDOM: [{ tag: "table.note-table" }], toDOM: () => ["table", { class: "note-table" }, ["tbody", 0]],
    },
    table_row: { content: "table_cell*", parseDOM: [{ tag: "tr" }], toDOM: () => ["tr", 0] },
    table_cell: {
      content: "(paragraph | heading | figure_row)+", isolating: true,
      attrs: { colSpan: { default: 1 }, rowSpan: { default: 1 } },
      parseDOM: [{ tag: "td", getAttrs: (dom) => ({ colSpan: (dom as HTMLTableCellElement).colSpan, rowSpan: (dom as HTMLTableCellElement).rowSpan }) }],
      toDOM: (node) => ["td", { colspan: node.attrs.colSpan, rowspan: node.attrs.rowSpan }, 0],
    },
    // A row of figures side by side, each with a caption typed under it, and an optional note beside the row.
    figure_row: { group: "block", content: "figure+ figure_side?", isolating: true, parseDOM: [{ tag: "div.note-figure-row" }], toDOM: () => ["div", { class: "note-figure-row" }, 0] },
    figure: {
      // src defaults to "" only so ProseMirror can repair a row; a figure without a picture is never saved.
      content: "inline*", attrs: { src: { default: "" } }, isolating: true, draggable: false,
      parseDOM: [{ tag: "figure", contentElement: "figcaption", getAttrs: (dom) => {
        const src = (dom as HTMLElement).querySelector("img")?.getAttribute("src") ?? "";
        return SAFE_IMAGE.test(src) ? { src } : false;
      } }],
      toDOM: (node) => ["figure", { class: "note-figure" }, ["img", { src: node.attrs.src, alt: "知识点配图" }], ["figcaption", 0]],
    },
    // The note beside a row: one line per step, so a proof reads one step per line.
    figure_side: { content: "side_line+", isolating: true, parseDOM: [{ tag: "div.note-figure-side" }], toDOM: () => ["div", { class: "note-figure-side" }, 0] },
    side_line: { content: "inline*", parseDOM: [{ tag: "div.note-figure-side > p" }], toDOM: () => ["p", 0] },
    text: { group: "inline" },
    math: {
      group: "inline", inline: true, atom: true, attrs: { latex: { default: "" }, display: { default: false } },
      parseDOM: [{ tag: "span[data-latex]", getAttrs: (dom) => ({ latex: (dom as HTMLElement).getAttribute("data-latex") ?? "" }) }],
      toDOM: (node) => ["span", { "data-latex": node.attrs.latex }, mathMarkup(node)],
      leafText: mathMarkup,
    },
  },
  marks: { bold: { parseDOM: [{ tag: "strong" }, { tag: "b" }], toDOM: () => ["strong", 0] } },
});

const { paragraph, heading, figure_row: figureRow, figure, figure_side: figureSide, side_line: sideLine, math } = noteSchema.nodes;
const bold = noteSchema.marks.bold;

function inlineNodes(spans: NoteSpan[], allowBold: boolean) {
  const nodes: ProseNode[] = [];
  for (const span of spans) {
    const marks = allowBold && span.bold ? [bold.create()] : [];
    for (const segment of splitMathText(span.text, { autoDetect: false })) {
      if (segment.kind === "math") {
        if (segment.value.trim()) nodes.push(math.create({ latex: segment.value, display: segment.display === true }, null, marks));
      } else if (segment.value) nodes.push(noteSchema.text(segment.value, marks));
    }
  }
  // A space next to a display formula would only add an empty line.
  const display = (node?: ProseNode) => node?.type === math && node.attrs.display === true;
  return nodes.filter((node, index) => !(node.isText && !node.text?.trim() && (display(nodes[index - 1]) || display(nodes[index + 1]))));
}

export function docFromNote(note: string | null | undefined): ProseNode {
  const blocks = parseHandoutNote(note).map((line) => {
    if (line.kind === "table") return noteSchema.nodes.table.create(null, line.rows.map((row) => noteSchema.nodes.table_row.create(null,
      row.map((cell) => noteSchema.nodes.table_cell.create({ colSpan: cell.colSpan, rowSpan: cell.rowSpan }, docFromNote(cell.content).content)),
    )));
    if (line.kind === "figures") return figureRow.create(null, [
      ...line.figures.map((item) => figure.create({ src: item.src }, inlineNodes(item.caption, true))),
      ...(line.side.length ? [figureSide.create(null, line.side.map((spans) => sideLine.create(null, inlineNodes(spans, true))))] : []),
    ]);
    if (line.kind === "heading") return heading.create({ level: line.level }, inlineNodes(line.spans, false));
    // An item keeps its marker as text: what the teacher types at the start of a line is what is saved.
    if (line.kind === "item") return paragraph.create(null, [noteSchema.text(line.marker), ...inlineNodes(line.spans, true)]);
    return paragraph.create(null, inlineNodes(line.spans, true));
  });
  return noteSchema.node("doc", null, blocks.length ? blocks : [paragraph.create()]);
}

function inlineMarkup(content: Fragment) {
  let out = ""; let boldRun = "";
  content.forEach((child) => {
    const piece = child.isText ? child.text ?? "" : child.type === math && child.attrs.latex.trim() ? mathMarkup(child) : "";
    if (child.marks.some((mark) => mark.type === bold)) { boldRun += piece; return; }
    if (boldRun) out += `**${boldRun}**`;
    boldRun = ""; out += piece;
  });
  return boldRun ? `${out}**${boldRun}**` : out;
}

export function noteFromContent(content: Fragment) {
  // Part of a single line arrives without its paragraph.
  if (content.firstChild?.isInline) return inlineMarkup(content).trim();
  const lines: string[] = [];
  content.forEach((block) => {
    if (block.type === noteSchema.nodes.table) {
      const rows: Array<Array<{ colSpan: number; rowSpan: number; content: string }>> = [];
      block.forEach((row) => {
        const cells: typeof rows[number] = [];
        row.forEach((cell) => cells.push({ colSpan: cell.attrs.colSpan, rowSpan: cell.attrs.rowSpan, content: noteFromContent(cell.content) }));
        rows.push(cells);
      });
      lines.push(noteTableMarkup(rows)); return;
    }
    if (block.type === figureRow) {
      // The images make the row's line; each line of the note beside it follows as “> …”.
      const figures: string[] = []; const notes: string[] = [];
      block.forEach((child) => {
        if (child.type === figure) { if (child.attrs.src) figures.push(`![${escapeCaption(inlineMarkup(child.content).trim())}](${child.attrs.src})`); return; }
        child.forEach((line) => { const text = inlineMarkup(line.content).trim(); if (text) notes.push(text); });
      });
      if (figures.length) lines.push(figures.join(" "), ...notes.map((note) => `> ${note}`));
      else lines.push(...notes);
      return;
    }
    const text = inlineMarkup(block.content).trim();
    if (text) lines.push(block.type === heading ? `${"#".repeat(Number(block.attrs.level))} ${text}` : text);
  });
  return lines.join("\n");
}

export const noteFromDoc = (doc: ProseNode) => noteFromContent(doc.content);

// Pasted text is read as note markup, so formulas, headings and figures arrive formatted. Plain lines at
// either end join the line at the caret; a heading or a row of figures stays a line of its own.
export function sliceFromNote(text: string) {
  const { content } = docFromNote(text);
  const open = (node: ProseNode | null) => node?.type === paragraph ? 1 : 0;
  return new Slice(content, open(content.firstChild), open(content.lastChild));
}

export function itemMarker(block: ProseNode) {
  const first = block.type === paragraph ? block.firstChild : null;
  const marker = first?.isText ? first.text?.match(ITEM_MARKER)?.[0] : undefined;
  return marker && block.content.size > marker.length ? marker : null;
}

// Width of the marker column: full-width characters take 1em, others about 0.6em.
export function itemMarkerWidth(marker: string) {
  return [...marker].reduce((width, char) => width + (/[\u2460-\u2473\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/.test(char) ? 1 : 0.6), 0) + 0.4;
}

const ATOM = "\uFFFC";
function flatText(block: ProseNode) {
  let flat = "";
  block.forEach((child) => { flat += child.isText ? child.text ?? "" : ATOM; });
  return flat;
}

// Shorthand typed into the block at `blockPos` ($…$, **…**, a leading # / ## / ###) becomes what it means at
// once, so the editor never shows markup that would later be saved with a different meaning.
// In question text only $…$ means something; ** and # are kept as typed.
export function convertTypedMarkup(tr: Transaction, blockPos: number, formulasOnly = false) {
  const start = blockPos + 1;
  const blockAt = () => tr.doc.nodeAt(blockPos);
  let block = blockAt();
  if (!block?.isTextblock) return false;
  let changed = false;
  const formulas = scanMathSource(flatText(block)).ranges.filter((range) => range.value.trim() && !range.value.includes(ATOM));
  for (const range of formulas.reverse()) {
    const marks = block.type.allowsMarkType(bold) ? tr.doc.resolve(start + range.start + 1).marks() : [];
    tr.replaceWith(start + range.start, start + range.end, math.create({ latex: range.value, display: range.display }, null, marks));
    changed = true;
  }
  if (formulasOnly) return changed;
  block = blockAt()!;
  const bolds = [...flatText(block).matchAll(/\*\*(.+?)\*\*/g)];
  for (const match of bolds.reverse()) {
    const from = start + (match.index ?? 0); const to = from + match[0].length;
    tr.delete(to - 2, to);
    if (block.type.allowsMarkType(bold)) tr.addMark(from + 2, to - 2, bold.create());
    tr.delete(from, from + 2);
    changed = true;
  }
  // Text typed after a closing ** is no longer bold.
  if (bolds.length) tr.setStoredMarks([]);
  block = blockAt()!;
  const prefix = block.type === paragraph ? flatText(block).match(/^(#{1,3})[ \u00a0\u3000]/) : null;
  if (prefix) {
    tr.delete(start, start + prefix[0].length);
    tr.setBlockType(start, start, heading, { level: prefix[1].length });
    changed = true;
  }
  return changed;
}

// Question text (stem, options, answer, analysis) is plain lines with $…$ formulas: one paragraph per line,
// formulas as chips, and nothing else read into it, so a field that is opened and left is saved unchanged.
export function docFromText(text: string | null | undefined) {
  const lines = (text ?? "").split("\n");
  return noteSchema.node("doc", null, lines.map((line) => paragraph.create(null, inlineNodes([{ text: line, bold: false }], false))));
}

export const textFromContent = (content: Fragment) => {
  if (content.firstChild?.isInline) return inlineMarkup(content);
  const lines: string[] = [];
  content.forEach((block) => { lines.push(inlineMarkup(block.content)); });
  return lines.join("\n");
};

export const textFromDoc = (doc: ProseNode) => textFromContent(doc.content);

export function sliceFromText(text: string) {
  const { content } = docFromText(text);
  return new Slice(content, 1, 1);
}
