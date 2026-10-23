import { docxFigureLine, parseDocxWebContent, parseDocxWebOptions, type DocxWebBlock, type DocxWebInline, type DocxWebTable } from "./docx-web-content";
import { plainTextWebLines, splitMathLines, splitMathText, toLatexMath } from "./math-text";
import { isCompactConclusionQuestion, questionImages, resolveQuestionImageLayout, sourceFigureWidth } from "./question-layout";
import { parseHandoutNote, type NoteLine, type NoteSpan, type NoteTableCell } from "./handout-note.mjs";
import { HANDOUT_BANDS, HANDOUT_PARTS, bandLabel, moduleHeading, questionPoints, type HandoutExportModule } from "./handout-rules.mjs";
import type { WordAnswerPlacement } from "./export-word";
import type { HandoutBand, Question } from "./types";

// 讲义 → LaTeX. Only semantic \handout... commands are emitted; latex/mitty-handout.cls owns the design.
// A 讲义 prints its modules; a 小测 or 作业 prints one numbered list of questions under its name.
// A sheet may set the room left after each question (快速排版): for a 解答题 the number of answer lines, for any other
// question blank millimetres. Without it a 解答题 gets six lines and other questions none. linePitch is the distance
// between answer lines in millimetres (the class default is 8).
export const DEFAULT_ANSWER_LINES = 6;
// A sheet may come in groups (智能组卷 by day): the questions are listed in group order and each group takes the next `size`.
export type SheetGroup = { title: string; size: number };
export type HandoutLatexInput = { title: string; answers: WordAnswerPlacement; spacing?: number[]; linePitch?: number; showSource?: boolean } & ({ modules: HandoutExportModule[] } | { sheet: string; questions: Question[]; groups?: SheetGroup[]; groupMode?: "sections" | "days" });

const TEXT_ESCAPES: Record<string, string> = {
  "\\": "\\textbackslash{}", "{": "\\{", "}": "\\}", "#": "\\#", "$": "\\$", "%": "\\%", "&": "\\&", "_": "\\_", "~": "\\textasciitilde{}", "^": "\\textasciicircum{}",
};
const EDITIONS: Record<WordAnswerPlacement, string> = { none: "学生版", end: "附答案", each: "教师版" };
const TEXT_COMMANDS = new Set(["text", "textrm", "textbf", "textit", "mathrm", "mbox", "operatorname"]);

function cleanText(value: string) {
  return Array.from(value).filter((char) => { const code = char.charCodeAt(0); return code >= 32 || code === 9 || code === 10 || code === 13; }).join("");
}

// Math symbols typed as plain text (common in Word sources) come from the math font.
const TEXT_SYMBOLS: Record<string, string> = {
  "∴": "\\therefore", "∵": "\\because", "△": "\\triangle", "∠": "\\angle", "⊥": "\\perp", "∥": "\\parallel", "≌": "\\cong", "∽": "\\backsim",
  "≤": "\\leq", "≥": "\\geq", "≠": "\\neq", "≈": "\\approx", "□": "\\square", "⊙": "\\odot", "⌒": "\\frown", "√": "\\surd", "∶": ":",
  "☆": "\\bigwhitestar", "★": "\\bigstar",
  "∈": "\\in", "∉": "\\notin", "⊆": "\\subseteq", "⊂": "\\subset", "∪": "\\cup", "∩": "\\cap", "∞": "\\infty", "→": "\\rightarrow", "⇒": "\\Rightarrow", "⇔": "\\Leftrightarrow",
  "﹣": "-", "－": "-", "−": "-",
};
const TEXT_SYMBOL_PATTERN = new RegExp(`[${Object.keys(TEXT_SYMBOLS).join("")}]`, "g");

// Literal text: escaped, with 2+ underscores turned into a fill-in blank.
export function latexPlain(value: string) {
  return cleanText(value).split(/(_{2,}|＿{2,})/).map((piece) => /^(?:_{2,}|＿{2,})$/.test(piece)
    ? `\\handoutblank{${Math.min(12, Math.max(3, piece.length * 0.6)).toFixed(1)}em}`
    : piece.replace(/[\\{}#$%&_~^]/g, (char) => TEXT_ESCAPES[char])
      .replace(/[□▱](?=[A-Z]{4})/g, "$\\parallelogram$")
      .replace(TEXT_SYMBOL_PATTERN, (char) => `$${TEXT_SYMBOLS[char]}$`)).join("");
}

// Chinese inside formulas must leave math mode, except where it already sits in a text command.
export function wrapCjkInMath(latex: string) {
  let result = ""; let index = 0;
  while (index < latex.length) {
    const command = latex.slice(index).match(/^\\([A-Za-z]+)\s*\{/);
    if (command && TEXT_COMMANDS.has(command[1])) {
      let depth = 0; let end = index + command[0].length - 1;
      for (; end < latex.length; end += 1) {
        if (latex[end] === "{" && latex[end - 1] !== "\\") depth += 1;
        else if (latex[end] === "}" && latex[end - 1] !== "\\" && --depth === 0) break;
      }
      result += latex.slice(index, end + 1); index = end + 1; continue;
    }
    const cjk = latex.slice(index).match(/^[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]+/);
    if (cjk) { result += `\\text{${cjk[0]}}`; index += cjk[0].length; continue; }
    result += latex[index]; index += 1;
  }
  return result;
}

// Function names and units stay upright; every other letter in a formula is a variable or a point.
function mathSource(value: string) {
  return toLatexMath(cleanText(value))
    .replace(/(?<![\\A-Za-z])(sin|cos|tan|cot|log|ln)(?![A-Za-z])/g, "\\$1 ")
    .replace(/(?<![\\A-Za-z])(Rt|cm|mm|dm|km|kg|mg|mL)(?![A-Za-z])/g, "\\mathrm{$1}");
}

// As on the web page, an inline formula with a fraction is set in display style, so its numbers are as large as the text.
function inlineMath(latex: string) {
  if (!latex.trim()) return "";
  return /\\frac/.test(latex) ? `$\\displaystyle ${latex}$` : `$${latex}$`;
}

function latexMath(value: string, display = false) {
  const latex = wrapCjkInMath(mathSource(value));
  if (!latex.trim()) return "";
  return display ? `\\[${latex}\\]` : inlineMath(latex);
}

// Text with $…$ formulas and the same automatic math detection the web view uses.
// "□ABCD" is a parallelogram even when detection splits the box from the vertex names.
export function latexInline(value: string) {
  const segments = splitMathText(value);
  return segments.map((segment, index) => {
    if (segment.kind === "math") return latexMath(segment.value, segment.display);
    const next = segments[index + 1];
    if (next?.kind === "math" && /^[A-Z]{4}(?![A-Za-z])/.test(next.value) && /[□▱]\s*$/.test(segment.value)) {
      return `${latexPlain(segment.value.replace(/[□▱]\s*$/, ""))}$\\parallelogram$`;
    }
    return latexPlain(segment.value);
  }).join("");
}

// Word documents often type a formula as ordinary runs: italic letters, full-width （）＝﹣, superscript digits.
// Such a stretch, together with any Word equation it touches, is set as one formula, so every formula in the
// document has the same math font, size and spacing.
type Glyph = { char: string; italic: boolean; vertical?: "sup" | "sub" };
type FormulaPart = Glyph | { latex: string };
const FORMULA_CHAR = /[A-Za-z0-9.+\-−﹣－＋=＝×÷·•<>＜＞≤≥≠≈±∓/%％:：()（）|｜π√∠△⊥∥≌∽°′]/;
const FORMULA_SIGNAL = /[+\-−﹣－＋=＝×÷·•<>＜＞≤≥≠≈±∓/π√∠△⊥∥≌∽°]/;
const OPERATOR = /[+\-−﹣－＋=＝×÷<>＜＞≤≥≠≈±∓]/;
// What toLatexMath does not already turn into math.
const FORMULA_SYMBOLS: Record<string, string> = {
  "﹣": "-", "：": ":", "％": "%", "｜": "|", "·": "\\cdot ", "•": "\\cdot ", "′": "'", "⊥": "\\perp ", "∥": "\\parallel ", "≌": "\\cong ", "∽": "\\backsim ",
};
const isGlyph = (part: FormulaPart): part is Glyph => "char" in part;

function glyphsLatex(glyphs: Glyph[]) {
  let latex = "";
  for (let index = 0; index < glyphs.length;) {
    const { vertical } = glyphs[index];
    let end = index;
    while (end < glyphs.length && glyphs[end].vertical === vertical) end += 1;
    const source = mathSource(glyphs.slice(index, end).map((glyph) => FORMULA_SYMBOLS[glyph.char] ?? glyph.char).join(""));
    latex += vertical ? `${vertical === "sup" ? "^" : "_"}{${source}}` : source;
    index = end;
  }
  return latex;
}

// Word equations write a ratio's colon as Chinese text; in a formula it is the ratio sign.
const equationLatex = (latex: string) => latex.replace(/\\text\{：\}|：/g, ":");

function formulaLatex(parts: FormulaPart[]) {
  const pieces: string[] = [];
  for (let index = 0; index < parts.length;) {
    const part = parts[index];
    if (!isGlyph(part)) { pieces.push(equationLatex(part.latex)); index += 1; continue; }
    let end = index;
    while (end < parts.length && isGlyph(parts[end])) end += 1;
    pieces.push(glyphsLatex(parts.slice(index, end) as Glyph[]));
    index = end;
  }
  return inlineMath(wrapCjkInMath(pieces.join(" ").trim()));
}

function glyphText(glyphs: Glyph[]) {
  let latex = "";
  for (let index = 0; index < glyphs.length;) {
    const { italic, vertical } = glyphs[index];
    let end = index;
    while (end < glyphs.length && glyphs[end].italic === italic && glyphs[end].vertical === vertical) end += 1;
    let text = latexPlain(glyphs.slice(index, end).map((glyph) => glyph.char).join(""));
    if (vertical === "sup") text = `\\textsuperscript{${text}}`;
    if (vertical === "sub") text = `\\textsubscript{${text}}`;
    if (italic) text = `\\textit{${text}}`;
    latex += text;
    index = end;
  }
  return latex;
}

// A stretch is a formula when it has an operator, an exponent, an italic letter or a Word equation in it.
// A sub-question label （1）, a year range 2026-2027 and the punctuation around a formula stay text.
function stretchLatex(parts: FormulaPart[]): string {
  const char = (part: FormulaPart | undefined) => part && isGlyph(part) ? part.char : "";
  let start = 0; let end = parts.length;
  const lead: string[] = [];
  for (const part of parts.slice(0, 4)) { if (!isGlyph(part)) break; lead.push(part.char); }
  const label = lead.join("").match(/^[（(]\d{1,2}[）)]/);
  if (label) start = label[0].length;
  while (start < end && /^[ :：.·•]$/.test(char(parts[start]))) start += 1;
  while (end > start && /^[ :：.·•]$/.test(char(parts[end - 1]))) end -= 1;
  const before = parts.slice(0, start); const after = parts.slice(end); const core = parts.slice(start, end);
  // An unmatched bracket belongs to the text around the formula.
  const open: number[] = []; const unmatched: number[] = [];
  core.forEach((part, index) => {
    if (/^[(（]$/.test(char(part))) open.push(index);
    else if (/^[)）]$/.test(char(part))) { if (open.length) open.pop(); else unmatched.push(index); }
  });
  const breaks = [...unmatched, ...open].sort((a, b) => a - b);
  if (breaks.length) {
    let latex = glyphText(before as Glyph[]); let cursor = 0;
    for (const index of breaks) { latex += stretchLatex(core.slice(cursor, index)) + glyphText([core[index] as Glyph]); cursor = index + 1; }
    return latex + stretchLatex(core.slice(cursor)) + glyphText(after as Glyph[]);
  }
  const text = core.map(char).join("");
  const formula = core.some((part) => !isGlyph(part) || Boolean(part.vertical) || part.italic && /[A-Za-z]/.test(part.char)) || /[□▱]/.test(text) || FORMULA_SIGNAL.test(text);
  const range = core.every(isGlyph) && /^\d+(?:-\d+)+$/.test(text);
  return glyphText(before as Glyph[]) + (formula && !range ? formulaLatex(core) : glyphText(core as Glyph[])) + glyphText(after as Glyph[]);
}

function latexInlines(inlines: DocxWebInline[], picture: (image: Extract<DocxWebInline, { type: "image" }>) => string = () => "") {
  const out: string[] = []; let stretch: FormulaPart[] = []; let text: Glyph[] = [];
  const flush = () => {
    if (text.length) out.push(glyphText(text));
    if (stretch.length) out.push(stretchLatex(stretch));
    text = []; stretch = [];
  };
  // Plain runs are read glyph by glyph; bold, underlined and fill-in runs keep their own formatting.
  const parts = inlines.flatMap<FormulaPart | DocxWebInline>((inline) => inline.type === "text" && !inline.bold && !inline.underline
    ? [...cleanText(inline.value)].map((char) => ({ char, italic: Boolean(inline.italic), vertical: inline.vertical }))
    : inline.type === "math" ? [{ latex: inline.latex }] : [inline]);
  const charAt = (index: number) => { const part = parts[index]; return part && "char" in part ? part.char : ""; };
  parts.forEach((part, index) => {
    if (!("type" in part)) {
      // A space joins a formula only beside an operator, as in “x = 1”; between words it ends one. □ABCD is a parallelogram.
      const inFormula = !isGlyph(part) || (part.char === " " ? OPERATOR.test(charAt(index - 1)) || OPERATOR.test(charAt(index + 1))
        : FORMULA_CHAR.test(part.char) || /[□▱]/.test(part.char) && /^[A-Z]{4}/.test([1, 2, 3, 4].map((step) => charAt(index + step)).join("")));
      if (inFormula) { if (text.length) { out.push(glyphText(text)); text = []; } stretch.push(part); return; }
      if (stretch.length) { out.push(stretchLatex(stretch)); stretch = []; }
      text.push(part as Glyph); return;
    }
    flush();
    if (part.type === "tab") { out.push("\\quad "); return; }
    if (part.type === "break") { out.push("\\newline "); return; }
    if (part.type === "image") { out.push(picture(part)); return; }
    if (part.type !== "text") return;
    if (part.underline && !part.value.trim()) { out.push(`\\handoutblank{${Math.min(12, Math.max(3, part.value.length * 0.5)).toFixed(1)}em}`); return; }
    let value = latexPlain(part.value);
    if (part.underline) value = `\\uline{${value}}`;
    if (part.vertical === "sup") value = `\\textsuperscript{${value}}`;
    if (part.vertical === "sub") value = `\\textsubscript{${value}}`;
    if (part.bold) value = `\\textbf{${value}}`;
    if (part.italic) value = `\\textit{${value}}`;
    out.push(value);
  });
  flush();
  return out.join("");
}

function plainWeight(value: string) {
  return [...value.replace(/\\[A-Za-z]+/g, "").replace(/[{}$^_]/g, "")].reduce((sum, char) => sum + (/[\u3000-\u9fff\uff00-\uffef]/.test(char) ? 1 : 0.55), 0);
}

function inlinesWeight(inlines: DocxWebInline[]) {
  return inlines.reduce((sum, inline) => sum + (inline.type === "text" ? plainWeight(inline.value) : inline.type === "math" ? plainWeight(inline.latex) : inline.type === "image" ? inline.width / 4 : 1), 0);
}

function latexTable(table: DocxWebTable | Extract<NoteLine, { kind: "table" }>, figureName: (source: string) => string | null = () => null) {
  const columns = Math.max(1, ...table.rows.map((row) => row.reduce((count, cell) => count + cell.colSpan, 0)));
  const cellText = (cell: NoteTableCell | DocxWebTable["rows"][number][number]) => "content" in cell
    ? parseHandoutNote(cell.content).map((line) => noteLineLatex(line, figureName, true)).filter(Boolean)
    : cell.blocks.filter((block) => block.type === "paragraph").map((block) => latexInlines(block.inlines)).filter(Boolean);
  const wide = "kind" in table || table.rows.some((row) => row.some((cell) => {
    const paragraphs = cellText(cell);
    return paragraphs.length > 1 || paragraphs.some((paragraph) => plainWeight(paragraph) > 16);
  }));
  const spans: number[] = new Array(columns).fill(0);
  const mergedWidths: number[] = new Array(columns).fill(1);
  const rows: string[] = [];
  table.rows.forEach((row, rowIndex) => {
    const cells: string[] = []; let column = 0; let cellIndex = 0;
    while (column < columns) {
      if (spans[column] > 0) {
        const width = mergedWidths[column];
        cells.push(width > 1 ? `\\multicolumn{${width}}{|c|}{}` : "");
        for (let offset = 0; offset < width; offset += 1) spans[column + offset] -= 1;
        column += width; continue;
      }
      const cell = row[cellIndex++];
      if (!cell) { cells.push(""); column += 1; continue; }
      let content = cellText(cell).join(wide ? "\\par " : " ");
      if (cell.rowSpan > 1) {
        content = `\\multirow{${cell.rowSpan}}{${"kind" in table ? "=" : "*"}}{${content}}`;
        mergedWidths[column] = cell.colSpan;
        for (let offset = 0; offset < cell.colSpan; offset += 1) spans[column + offset] = cell.rowSpan - 1;
      }
      if (cell.colSpan > 1) content = `\\multicolumn{${cell.colSpan}}{|${wide ? `>{\\centering\\arraybackslash}p{${(cell.colSpan / columns * 0.92).toFixed(3)}\\linewidth}` : "c"}|}{${content}}`;
      cells.push(content); column += cell.colSpan;
    }
    const covered = spans.map((span) => span > 0);
    const ranges: string[] = []; let start = -1;
    covered.forEach((isCovered, index) => {
      if (!isCovered && start < 0) start = index;
      if ((isCovered || index === columns - 1) && start >= 0) { ranges.push(`\\cline{${start + 1}-${isCovered ? index : index + 1}}`); start = -1; }
    });
    const rule = covered.some(Boolean) ? ranges.join("") : "\\hline";
    rows.push(`${rowIndex === 0 && table.rows.length > 1 ? "\\handoutheadrow " : ""}${cells.join(" & ")} \\\\${rule}`);
  });
  const spec = wide
    ? `{|${Array.from({ length: columns }, () => ">{\\centering\\arraybackslash}X").join("|")}|}`
    : `{|${Array.from({ length: columns }, () => "c").join("|")}|}`;
  const environment = wide ? "tabularx" : "tabular";
  return `{\\centering\\handouttablerule\\begin{${environment}}${wide ? "{\\linewidth}" : ""}${spec}\\hline\n${rows.join("\n")}\n\\end{${environment}}\\par}`;
}

function docxBlocks(blocks: DocxWebBlock[]) {
  return blocks.map((block) => {
    if (block.type === "table") return latexTable(block);
    const text = latexInlines(block.inlines);
    return block.align === "center" ? `{\\centering ${text}\\par}` : text;
  }).filter(Boolean);
}

// A Word paragraph's pictures stay where the document put them, at the printed size and alignment.
function docxFigureLatex(fragment: string, assets: Record<string, string> | undefined, figureName: (source: string) => string | null) {
  const line = docxFigureLine(fragment);
  const figures = (line?.figures ?? []).flatMap((figure) => {
    const source = assets?.[figure.id]; const name = source ? figureName(source) : null;
    return source && name ? [{ ...figure, source, name }] : [];
  });
  if (!line || !figures.length) return null;
  const row = figures.map((figure) => `\\handoutfigure[.45\\textheight]{${figure.width.toFixed(1)}mm}{${figure.name}}`).join("\\hspace{4mm}");
  return { latex: `\\handoutfigureline{${line.align[0]}}{${row}}`, sources: figures.map((figure) => figure.source) };
}

// The stem's paragraphs, with a Word-imported picture between the paragraphs it sat between; placed lists those pictures.
function stemContent(question: Question, figureName: (source: string) => string | null) {
  const lines: string[] = []; const placed: string[] = [];
  if (question.stemDocxXml?.length) {
    let numbered = false;
    for (const fragment of question.stemDocxXml) {
      const { blocks } = parseDocxWebContent([fragment], { stripLeadingQuestionNumber: !numbered });
      numbered ||= blocks.some((block) => block.type === "paragraph");
      lines.push(...docxBlocks(blocks));
      const figures = docxFigureLatex(fragment, question.stemDocxAssets, figureName);
      if (figures) { lines.push(figures.latex); placed.push(...figures.sources); }
    }
    return { lines, placed };
  }
  const text = question.stemParagraphs?.length ? question.stemParagraphs.join("\n") : question.stem;
  lines.push(...plainTextWebLines(text, { stripLeadingQuestionNumber: true })
    .filter((line) => line.value.trim())
    .map((line) => line.align === "center" ? `{\\centering ${latexInline(line.value)}\\par}` : latexInline(line.value)));
  return { lines, placed };
}

type Choice = { label: string; latex: string; weight: number };

function questionChoices(question: Question, figureName: (source: string) => string | null = () => null): Choice[] {
  if (question.optionsDocxXml?.length) return parseDocxWebOptions(question.optionsDocxXml).map((option) => ({
    label: option.label,
    latex: latexInlines(option.inlines, (image) => {
      const source = question.optionsDocxAssets?.[image.id]; const name = source ? figureName(source) : null;
      return name ? `\\handoutfigure[.45\\textheight]{${Math.min(150, image.width).toFixed(1)}mm}{${name}}` : "";
    }),
    weight: inlinesWeight(option.inlines),
  }));
  return question.options.map((option, index) => ({ label: String.fromCharCode(65 + index), latex: latexInline(option), weight: plainWeight(option) }));
}

// A4 body width fits four short options per row, two medium ones, or one long one.
export function choiceColumns(weights: number[]) {
  const widest = Math.max(0, ...weights);
  if (weights.length <= 4 && widest <= 8.5) return 4;
  return widest <= 20 ? 2 : 1;
}

// A 解答题 without options leaves ruled answer lines under it; any other question leaves blank space.
export const leavesAnswerLines = (question: Question) => question.type === "解答题" && !questionChoices(question).length;

function choicesLatex(choices: Choice[]) {
  const columns = choiceColumns(choices.map((choice) => choice.weight));
  const rows: string[] = [];
  for (let start = 0; start < choices.length; start += columns) {
    const cells = choices.slice(start, start + columns).map((choice) => `\\handoutchoice{${choice.label}.}{${choice.latex}}`);
    while (cells.length < columns) cells.push("");
    rows.push(`${cells.join(" & ")} \\\\`);
  }
  return `\\begin{handoutchoices}{${columns}}\n${rows.join("\n")}\n\\end{handoutchoices}`;
}

function answerLatex(question: Question) {
  const answer = question.answer.trim();
  if (!answer) return "略";
  if ((question.type === "单选题" || question.type === "多选题") && /^[A-F]+$/.test(answer)) return answer;
  return latexInline(answer);
}

// 【分析】【解答】… lines become tagged paragraphs; untagged text and pictures join the previous tag.
function analysisGroups(question: Question, figureName: (source: string) => string | null) {
  const groups: { label: string; parts: string[] }[] = [];
  const append = (label: string | null, body: string) => {
    if (label || !groups.length) groups.push({ label: label ?? "解析", parts: [] });
    if (body) groups.at(-1)!.parts.push(body);
  };
  if (question.analysisDocxXml?.length) {
    for (const fragment of question.analysisDocxXml) {
      for (const block of parseDocxWebContent([fragment]).blocks) {
        if (block.type === "table") { append(null, latexTable(block)); continue; }
        const first = block.inlines.find((inline) => inline.type === "text");
        const tag = first?.type === "text" ? first.value.match(/^\s*【([^】]{1,6})】\s*/) : null;
        const inlines = tag ? block.inlines.map((inline) => inline === first ? { ...inline, value: inline.value.slice(tag[0].length) } : inline) : block.inlines;
        append(tag?.[1] ?? null, latexInlines(inlines));
      }
      const figures = docxFigureLatex(fragment, question.analysisDocxAssets, figureName);
      if (figures) append(null, figures.latex);
    }
  } else {
    for (const line of splitMathLines(question.analysis)) {
      if (!line.trim()) continue;
      const tag = line.match(/^\s*【([^】]{1,6})】\s*/);
      append(tag?.[1] ?? null, latexInline(tag ? line.slice(tag[0].length) : line));
    }
  }
  return groups.filter((group) => group.parts.length);
}

function answerBody(question: Question, figureName: (source: string) => string | null) {
  return [`\\handoutanswerline{${answerLatex(question)}}`, ...analysisGroups(question, figureName).map((group) => `\\handoutanalysis{${latexPlain(group.label)}}{${group.parts.join("\\par ")}}`)].join("\n");
}

// 小测 and 作业 print no 考点: naming the knowledge point would give the method away.
function questionLatex(question: Question, label: string, band: HandoutBand, answers: WordAnswerPlacement, figureName: (source: string) => string | null, showPoints = true, space?: number, code?: string, showSource = true) {
  const { lines: paragraphs, placed } = stemContent(question, figureName);
  const id = code?.trim() ? `\\handoutsource{ID ${latexPlain(code.trim())}}` : "";
  const source = showSource && question.source?.trim() ? `\\handoutsource{${latexPlain(question.source.trim())}}` : "";
  const stem = [`${id}${source}${paragraphs[0] ?? ""}`, ...paragraphs.slice(1)].join("\\par\n");
  // Pictures not already placed in the stem follow the question's layout; a screenshot figure keeps its share of the line.
  const figures = questionImages(question).filter((image) => !placed.includes(image)).map(figureName).filter((name): name is string => Boolean(name));
  const layout = resolveQuestionImageLayout(question);
  const compactConclusion = isCompactConclusionQuestion(question);
  const sourceWidth = sourceFigureWidth(question, true);
  const choices = questionChoices(question, figureName);
  const out = [`\\begin{handoutquestion}{${label}}`];
  if (figures.length === 1 && layout === "right" && !compactConclusion) {
    out.push(`\\begin{handoutsidefigure}${sourceWidth ? `[${Math.min(.45, sourceWidth).toFixed(2)}]` : ""}{${figures[0]}}`, stem, "\\end{handoutsidefigure}");
  } else {
    out.push(stem);
    if (figures.length === 1 && sourceWidth && layout === "below" && !compactConclusion) {
      out.push(`\\handoutfigureline{l}{\\handoutfigure[.45\\textheight]{${sourceWidth.toFixed(2)}\\linewidth}{${figures[0]}}}`);
    } else if (figures.length) {
      const width = figures.length === 1 ? "0.42\\linewidth" : `${(0.92 / figures.length).toFixed(2)}\\linewidth`;
      out.push(`\\handoutfigures${layout === "below-right" ? "right" : ""}{${figures.map((name) => `\\handoutfigure{${width}}{${name}}`).join("\\hspace{4mm}")}}`);
    }
  }
  if (choices.length) out.push(choicesLatex(choices));
  const points = showPoints ? questionPoints(question) : [];
  if (points.length) out.push(`\\handoutpoints{${points.map(latexPlain).join("、")}}`);
  // 学生版：例题留课堂笔记区，练习和变式的解答题留作答横线，其他题按给定的毫米留白；教师版不留白。
  const lines = leavesAnswerLines(question);
  const answerLines = Math.round(space ?? DEFAULT_ANSWER_LINES);
  if (answers !== "each" && band === "example" && answerLines > 0) out.push(`\\handoutnotesarea{${answerLines}}`);
  else if (answers !== "each" && lines && answerLines > 0) out.push(`\\handoutworkspace{${answerLines}}`);
  else if (answers !== "each" && !lines && space && space > 0) out.push(`\\handoutgap{${Number(space.toFixed(1))}}`);
  out.push("\\end{handoutquestion}");
  // The question is never split across pages; the 教师版 answer after it may run on to the next page.
  if (answers === "each") out.push("\\begin{handoutanswer}", answerBody(question, figureName), "\\end{handoutanswer}");
  return out.join("\n");
}

function spansLatex(spans: NoteSpan[]) {
  return spans.map((span) => span.bold ? `\\textbf{${latexInline(span.text)}}` : latexInline(span.text)).join("");
}

// A row of figures side by side, each with its caption; a note written beside the row takes a third of it.
function figureRowLatex(line: Extract<NoteLine, { kind: "figures" }>, figureName: (source: string) => string | null, inCell = false) {
  const figures = line.figures.flatMap((figure) => { const name = figureName(figure.src); return name ? [{ name, caption: spansLatex(figure.caption) }] : []; });
  // Display formulas beside the figures start at the left edge, like the lines of text around them.
  // Each step of the note is a line of its own.
  const side = line.side.map((spans) => spansLatex(spans).replace(/\\\[([\s\S]*?)\\\]/g, (_, formula: string) => `\\par\\noindent$\\displaystyle ${formula.trim()}$\\par `)).join("\\par\n");
  if (!figures.length) return side;
  // Every figure gets a cell of one size and rows start at the left edge, so figures line up from row to row;
  // the note beside them takes whatever is left.
  const gaps = figures.length - 1 + (side ? 1 : 0);
  const width = Math.min(inCell ? .98 : .3, (.98 - (side ? .3 : 0) - gaps * .03) / figures.length);
  const sideWidth = side ? .98 - width * figures.length - gaps * .03 : 0;
  const height = inCell ? 32 : 40;
  const cells = figures.map((figure) => `\\handoutrowfigure{${width.toFixed(3)}\\linewidth}{${height}mm}{${figure.name}}{${figure.caption}}`);
  if (side) cells.push(`\\handoutrowside{${sideWidth.toFixed(2)}\\linewidth}{${side}}`);
  return ["\\begin{handoutfigurerow}", cells.join("\\hspace{0.03\\linewidth}%\n"), "\\end{handoutfigurerow}"].join("\n");
}

function noteLineLatex(line: NoteLine, figureName: (source: string) => string | null, inCell = false): string {
  if (line.kind === "table") return latexTable(line, figureName);
  if (line.kind === "figures") return figureRowLatex(line, figureName, inCell);
  if (line.kind === "heading") return `\\handoutnoteheading[${line.level}]{${spansLatex(line.spans)}}`;
  if (line.kind === "item") return `\\handoutnoteitem{${latexPlain(line.marker)}}{${spansLatex(line.spans)}}`;
  return spansLatex(line.spans);
}

export function splitHandoutTitle(title: string) {
  const match = title.trim().match(/^(第\s*[一二三四五六七八九十百零〇两\d]+\s*(?:讲|课时|课|节|章|单元|周))\s*[-—–·:：、|｜\s]*(.+)$/);
  return match ? { series: match[1].replace(/\s+/g, ""), title: match[2].trim() } : { series: "", title: title.trim() };
}

const ANSWER_TITLES: Record<HandoutBand, string> = { example: "例题解析", practice: "练习答案", variant: "变式答案" };

export function buildHandoutLatex(input: HandoutLatexInput, figureName: (source: string) => string | null = () => null) {
  const { title, answers } = input;
  const heading = splitHandoutTitle(title || "讲义");
  const list = "questions" in input ? input : null;
  const groups = list ? sheetGroups(list.questions.length, list.groups) : null;
  // A sheet in days scores each day under its own heading, so the title keeps only name and class.
  const fields = groups && list?.groupMode !== "sections" ? "姓名,班级" : list || /(小测|测验|测试|作业|练习|周练|月考|考试|检测|试卷)/.test(title) ? "姓名,班级,得分" : "姓名,班级,日期";
  const series = [heading.series, list?.sheet ?? ""].filter(Boolean).map(latexPlain).join("\\enspace ");
  const body = "questions" in input ? sheetBody(input.questions, answers, figureName, input.spacing, groups, input.groupMode, input.showSource) : moduleBody(input.modules, answers, figureName, input.spacing, input.showSource);
  return [
    "\\documentclass{mitty-handout}",
    series ? `\\handoutseries{${series}}` : "",
    `\\handouttitle{${latexPlain(heading.title)}}`,
    `\\handoutedition{${EDITIONS[answers]}}`,
    `\\handoutfields{${fields}}`,
    input.linePitch ? `\\handoutlinepitch{${Number(input.linePitch.toFixed(1))}mm}` : "",
    "\\begin{document}",
    "\\makehandouttitle",
    ...body,
    "\\end{document}",
  ].filter(Boolean).join("\n") + "\n";
}

// Groups are used only when they account for every question; empty groups print nothing.
function sheetGroups(count: number, groups?: SheetGroup[]) {
  const used = (groups ?? []).filter((group) => group.size > 0);
  return used.length && used.reduce((sum, group) => sum + group.size, 0) === count ? used : null;
}

// 小测 and 作业: questions numbered 1, 2, 3…; the key at the end uses the same numbers. In groups (days) each group starts
// on a new page under its heading and numbers from 1 again; the key repeats the group headings.
function sheetBody(questions: Question[], answers: WordAnswerPlacement, figureName: (source: string) => string | null, spacing?: number[], groups?: SheetGroup[] | null, groupMode: "sections" | "days" = "days", showSource = true) {
  if (!questions.length) return [];
  const parts = groups ?? [{ title: "", size: questions.length }];
  const width = groupMode === "sections" ? questions.length : Math.max(...parts.map((part) => part.size));
  const body = [`\\handoutnumberwidth{${width}}`]; const keys: string[] = [];
  let index = 0;
  for (const part of parts) {
    if (groups) {
      body.push(groupMode === "sections" ? `\\handoutsection{}{${latexPlain(part.title)}}` : `\\handoutgroup{${latexPlain(part.title)}}{${part.size}}`);
      if (answers === "end") keys.push(`\\handoutkeygroup{${latexPlain(part.title)}}{${groupMode === "sections" ? width : part.size}}`);
    }
    for (let number = 1; number <= part.size; number += 1, index += 1) {
      const label = String(groupMode === "sections" ? index + 1 : number);
      body.push(questionLatex(questions[index], label, "practice", answers, figureName, false, spacing?.[index], questions[index].code, showSource));
      if (answers === "end") keys.push(`\\begin{handoutkey}{${label}}`, answerBody(questions[index], figureName), "\\end{handoutkey}");
    }
  }
  return keys.length ? [...body, "\\handoutanswerkey", ...keys] : body;
}

function moduleBody(modules: HandoutExportModule[], answers: WordAnswerPlacement, figureName: (source: string) => string | null, spacing?: number[], showSource = true) {
  const body: string[] = [];
  let questionIndex = 0;
  const counters: Record<HandoutBand, number> = { example: 0, practice: 0, variant: 0 };
  const keys: Record<HandoutBand, string[]> = { example: [], practice: [], variant: [] };
  modules.forEach((module, index) => {
    const moduleTitle = moduleHeading(module.heading, index);
    if (modules.length > 1 || moduleTitle.title) body.push(`\\handoutsection{${moduleTitle.numeral}}{${latexPlain(moduleTitle.title || `模块${moduleTitle.numeral}`)}}`);
    const note = parseHandoutNote(module.note).map((line) => noteLineLatex(line, figureName)).filter(Boolean);
    if (note.length) body.push(`\\handoutpart{${HANDOUT_PARTS.knowledge.label}}{${HANDOUT_PARTS.knowledge.tagline}}`, "\\begin{handoutnote}", note.join("\n\n"), "\\end{handoutnote}");
    for (const band of HANDOUT_BANDS) {
      const questions = module.bands[band];
      if (!questions.length) continue;
      const labels = questions.map(() => bandLabel(band, ++counters[band]));
      body.push(`\\handoutpart{${HANDOUT_PARTS[band].label}}{${HANDOUT_PARTS[band].tagline}}`, `\\handoutnumberwidth{${labels.at(-1)}}`);
      questions.forEach((question, position) => {
        body.push(questionLatex(question, labels[position], band, answers, figureName, true, spacing?.[questionIndex++], undefined, showSource));
        if (answers === "end") keys[band].push(`\\begin{handoutkey}{${labels[position]}}`, answerBody(question, figureName), "\\end{handoutkey}");
      });
    }
  });
  // The key is grouped by band and uses the same labels as the body.
  if (HANDOUT_BANDS.some((band) => keys[band].length)) {
    body.push("\\handoutanswerkey");
    for (const band of HANDOUT_BANDS) if (keys[band].length) body.push(`\\handoutkeygroup{${ANSWER_TITLES[band]}}{${bandLabel(band, counters[band])}}`, ...keys[band]);
  }
  return body;
}
