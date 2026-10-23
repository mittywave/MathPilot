// 知识点的轻量写法，网页、精排 PDF 和 Word 共用同一个解析结果：
//   # 大标题   ## 小标题   ### 更小的标题        **加粗**        （1）/①/1. 开头的行是要点
//   一行里的一张或几张图 ![图注](图片地址) 是一排并排的配图；图后面的文字和紧跟着的 > 开头的行是写在这排图旁边的说明
// 公式仍然写在 $…$ 里，由各自的渲染器处理。证明和推导一步一行：∵、∴（含又∵）开头的每一步都另起一行。

import { scanMathSource } from "./math-source.mjs";

const FIGURE = /^\s*!\[((?:[^\]\\]|\\.){0,300})\]\(([^)\s]+)\)/;
const HEADING_LINE = /^(#{1,3})\s+(.+)$/;
export const ITEM_MARKER = /^(?:（\d{1,2}）|\(\d{1,2}\)|[①-⑳]|\d{1,2}[.．、](?!\d)|[一二三四五六七八九十]{1,3}、|[•·●▪])/;
const ITEM_LINE = new RegExp(`^(${ITEM_MARKER.source.slice(1)})\\s*(.+)$`);
// Only images stored in this app: never an outside address, never a data URL that would bloat the note.
export const SAFE_IMAGE = /^\/api\/assets\/[0-9a-f-]{36}$/i;
// Notes written before captions existed label every figure “图”.
const UNLABELLED = new Set(["", "图"]);

const STEP_TEXT = /(?:又|而|且)?[∵∴]/g;
const STEP_MATH = /\\(?:because|therefore)(?![A-Za-z])|[∵∴]/g;
const LEAD_IN = /^(?:证明|证|解|分析|解析)[:：]?$/;

// A proof written as one run (∵…∴…又∵…∴…) becomes one step per line, so the chain of reasoning can be read.
// A formula holding a step marker part-way through is split there; bold text is never cut.
export function proofSteps(line) {
  let text = line;
  for (const range of scanMathSource(text).ranges.reverse()) {
    const delimiter = range.display ? "$$" : "$";
    const parts = []; let cursor = 0;
    for (const match of range.value.matchAll(STEP_MATH)) {
      if (!range.value.slice(cursor, match.index).trim()) continue;
      parts.push(range.value.slice(cursor, match.index).trim()); cursor = match.index;
    }
    if (!parts.length) continue;
    parts.push(range.value.slice(cursor).trim());
    text = text.slice(0, range.start) + parts.map((part) => `${delimiter}${part}${delimiter}`).join(" ") + text.slice(range.end);
  }
  const maths = scanMathSource(text).ranges;
  const bolds = [...text.matchAll(/\*\*(.+?)\*\*/g)].map((match) => [match.index, match.index + match[0].length]);
  const covered = (at) => maths.some((range) => at > range.start && at < range.end) || bolds.some(([start, end]) => at > start && at < end);
  const cuts = [];
  for (const match of text.matchAll(STEP_TEXT)) if (!covered(match.index)) cuts.push(match.index);
  for (const range of maths) {
    if (!/^\s*(?:\\(?:because|therefore)(?![A-Za-z])|[∵∴])/.test(range.value)) continue;
    const before = text.slice(0, range.start).match(/(?:又|而|且)\s*$/);
    cuts.push(before ? range.start - before[0].length : range.start);
  }
  const steps = []; let start = 0;
  for (const cut of [...new Set(cuts)].sort((a, b) => a - b)) {
    const piece = text.slice(start, cut).trim();
    if (!piece || LEAD_IN.test(piece)) continue;
    steps.push(piece); start = cut;
  }
  steps.push(text.slice(start).trim());
  return steps.filter(Boolean);
}

const CJK = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]+/g;
// A LaTeX command written outside $…$ (\underline{有理数}) is a formula: it is wrapped so every renderer reads it
// as one, with Chinese inside set as text.
function wrapBareCommands(text) {
  let out = ""; let cursor = 0;
  const maths = scanMathSource(text).ranges;
  for (let index = 0; index < text.length; index += 1) {
    const inMath = maths.find((range) => index >= range.start && index < range.end);
    if (inMath) { index = inMath.end - 1; continue; }
    const command = text.slice(index).match(/^\\[A-Za-z]+/);
    if (!command || (index > 0 && text[index - 1] === "\\")) continue;
    let end = index + command[0].length;
    while (text[end] === "{" || text[end] === "[") {
      const close = text[end] === "{" ? "}" : "]"; let depth = 0; let at = end;
      for (; at < text.length; at += 1) { if (text[at] === text[end]) depth += 1; else if (text[at] === close && --depth === 0) break; }
      if (at >= text.length) break;
      end = at + 1;
    }
    const formula = text.slice(index, end).replace(CJK, (run) => `\\text{${run}}`);
    out += `${text.slice(cursor, index)}$${formula}$`; cursor = end; index = end - 1;
  }
  return out + text.slice(cursor);
}

// Bold belongs to the text around formulas; ** written inside a formula becomes \textbf so it never splits it.
function boldInsideMath(text) {
  for (const range of scanMathSource(text).ranges.reverse()) {
    const formula = text.slice(range.start, range.end).replace(/\*\*(.+?)\*\*/g, "\\textbf{$1}");
    text = text.slice(0, range.start) + formula + text.slice(range.end);
  }
  return text;
}

export function noteSpans(raw) {
  const text = boldInsideMath(wrapBareCommands(raw));
  const spans = []; let cursor = 0;
  for (const match of text.matchAll(/\*\*(.+?)\*\*/g)) {
    if (match.index > cursor) spans.push({ text: text.slice(cursor, match.index), bold: false });
    spans.push({ text: match[1], bold: true }); cursor = match.index + match[0].length;
  }
  if (cursor < text.length) spans.push({ text: text.slice(cursor), bold: false });
  return spans.filter((span) => span.text.length > 0);
}

// Captions sit in the image's [ ]; a ] inside one is written \].
export const escapeCaption = (caption) => String(caption ?? "").replace(/\s*\r?\n\s*/g, " ").replace(/]/g, "\\]");

// Tables use a small, escaped HTML subset in the existing note string. Cell contents are ordinary
// note markup, so formulas and stored figures use the same editor and export paths as the rest of a note.
const escapeCell = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "&#10;").replace(/\r/g, "");
const unescapeCell = (value) => value.replace(/&#10;|&lt;|&gt;|&amp;/g, (entity) => ({ "&#10;": "\n", "&lt;": "<", "&gt;": ">", "&amp;": "&" })[entity]);
export function noteTableMarkup(rows) {
  return `<table>${rows.map((row) => `<tr>${row.map((cell) => `<td colspan="${cell.colSpan}" rowspan="${cell.rowSpan}">${escapeCell(cell.content)}</td>`).join("")}</tr>`).join("")}</table>`;
}

function tableLine(line) {
  if (!/^<table>[\s\S]*<\/table>$/.test(line)) return null;
  const rows = [...line.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].slice(0, 40).map((row) => [...row[1].matchAll(/<td colspan="(\d{1,2})" rowspan="(\d{1,2})">([^<]*)<\/td>/g)].slice(0, 12).map((cell) => ({
    colSpan: Math.max(1, Math.min(12, Number(cell[1]))), rowSpan: Math.max(1, Math.min(40, Number(cell[2]))), content: unescapeCell(cell[3]),
  })));
  return rows.length && rows.some((row) => row.length) ? { kind: "table", rows } : null;
}

function figureRow(line) {
  const figures = []; let rest = line;
  for (let match = rest.match(FIGURE); match; match = rest.match(FIGURE)) {
    figures.push({ caption: match[1].replace(/\\]/g, "]").trim(), src: match[2] });
    rest = rest.slice(match[0].length);
  }
  return figures.length ? { figures, side: rest.trim() } : null;
}

const sideLines = (text) => proofSteps(text).map(noteSpans);
// A row's note may go on in lines starting with “>” right after it.
function continueSide(lines, text) {
  const row = lines.at(-1);
  if (row?.kind !== "figures") return false;
  row.side.push(...sideLines(text));
  return true;
}

export function parseHandoutNote(note) {
  const lines = [];
  for (const raw of String(note ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const table = tableLine(line);
    if (table) { lines.push(table); continue; }
    const row = figureRow(line);
    if (row) {
      const figures = row.figures.filter((figure) => SAFE_IMAGE.test(figure.src))
        .map((figure) => ({ src: figure.src, caption: noteSpans(UNLABELLED.has(figure.caption) ? "" : figure.caption) }));
      if (figures.length) lines.push({ kind: "figures", figures, side: row.side ? sideLines(row.side) : [] });
      else if (row.side) for (const step of proofSteps(row.side)) lines.push({ kind: "text", spans: noteSpans(step) });
      continue;
    }
    const sideNote = line.match(/^>\s*(.*)$/);
    if (sideNote) {
      if (sideNote[1] && !continueSide(lines, sideNote[1])) for (const step of proofSteps(sideNote[1])) lines.push({ kind: "text", spans: noteSpans(step) });
      continue;
    }
    const heading = line.match(HEADING_LINE);
    if (heading) { lines.push({ kind: "heading", level: heading[1].length, spans: noteSpans(heading[2].trim()) }); continue; }
    const item = line.match(ITEM_LINE);
    if (item) { lines.push({ kind: "item", marker: item[1], spans: noteSpans(item[2].trim()) }); continue; }
    for (const step of proofSteps(line)) lines.push({ kind: "text", spans: noteSpans(step) });
  }
  return besideFigures(lines);
}

const PROOF_START = /^(?:证明|证|解)[:：]|^(?:又|而|且)?[∵∴]|^\$\\(?:because|therefore)/;
const PROOF_STEP = /^(?:又|而|且|故|所以)?[∵∴]|^\$\\(?:because|therefore)|^(?:证明|证|解)[:：]/;
const spanText = (spans) => spans.map((span) => span.text).join("");
// Room beside a row of one or two figures is used: a proof written right below such a row is set beside it.
function besideFigures(lines) {
  const out = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]; out.push(line);
    if (line.kind !== "figures" || line.side.length || line.figures.length > 2) continue;
    if (lines[index + 1]?.kind !== "text" || !PROOF_START.test(spanText(lines[index + 1].spans))) continue;
    while (lines[index + 1]?.kind === "text" && (line.side.length === 0 || PROOF_STEP.test(spanText(lines[index + 1].spans)))) line.side.push(lines[++index].spans);
  }
  return out;
}

export function noteImageSources(note) {
  return parseHandoutNote(note).flatMap((line) => line.kind === "figures" ? line.figures.map((figure) => figure.src)
    : line.kind === "table" ? line.rows.flatMap((row) => row.flatMap((cell) => noteImageSources(cell.content))) : []);
}

// Recognized blocks become note text in the same light syntax, so teachers can still edit it by hand.
export function noteFromBlocks(blocks, figureSource) {
  const lines = [];
  for (const block of blocks) {
    if (block.type === "table") {
      lines.push(noteTableMarkup(block.rows.map((row) => row.map((cell) => ({
        colSpan: cell.colSpan, rowSpan: cell.rowSpan,
        content: [cell.text, ...cell.figures.flatMap((figure) => {
          const source = figureSource(figure);
          return source ? [`![${escapeCaption(figure.caption)}](${source})`] : [];
        })].filter(Boolean).join("\n"),
      })))));
    } else if (block.type === "figures") {
      const figures = block.figures.flatMap((figure) => {
        const source = figureSource(figure);
        return source ? [`![${escapeCaption(figure.caption)}](${source})`] : [];
      });
      const line = [...figures, block.side].filter(Boolean).join(" ");
      if (line) lines.push(figures.length ? line : block.side);
    } else if (block.type === "heading") lines.push(`${"#".repeat(block.level ?? 2)} ${block.text}`);
    else if (block.type === "item") lines.push(`${block.marker}${block.text}`);
    else lines.push(block.text);
  }
  return lines.join("\n");
}
