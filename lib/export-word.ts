import { AlignmentType, BorderStyle, Document, ImageRun, LineRuleType, Math as WordMath, MathFraction, MathRadical, MathRoundBrackets, MathRun, MathSubScript, MathSuperScript, Packer, Paragraph, Table, TableCell, TableLayoutType, TableRow, TextRun, VerticalAlign, WidthType, type MathComponent, type ParagraphChild } from "docx";
import JSZip from "jszip";
import katex from "katex";
import { mml2omml } from "mathml2omml";
import { splitMathText, toLatexMath } from "./math-text";
import { needsWordMathEquation, normalizeMathNotation } from "./math-notation.mjs";
import { isCompactConclusionQuestion, resolveQuestionImageLayout, sourceFigureWidth } from "./question-layout";
import { optionColumnCount } from "./question-presentation-rules.mjs";
import { resolveWordImageSource } from "./word-image-source.mjs";
import { standaloneWordQuestionImages } from "./word-question-images.mjs";
import { ensureWordMathSettings, fullSizeInlineFractions } from "./word-math-sizing.mjs";
import { parseHandoutNote, type NoteLine, type NoteSpan } from "./handout-note.mjs";
import { HANDOUT_BANDS, HANDOUT_PARTS, moduleHeading, questionPoints, type HandoutExportModule } from "./handout-rules.mjs";
import type { Question } from "./types";

const typeOrder = ["单选题", "多选题", "填空题", "判断题", "解答题"];
const typeNames: Record<string, string> = { 单选题: "单项选择题", 多选题: "多项选择题", 填空题: "填空题", 判断题: "判断题", 解答题: "解答题" };
const sectionNumbers = ["一", "二", "三", "四", "五"];
const optionLabels = ["A", "B", "C", "D", "E", "F"];
// Explicit automatic line rules let office renderers grow lines around native
// fractions and inline images instead of clipping them to an ambiguous fixed line.
const BODY_SIZE = 21;
// Note headings by level: 大标题 13pt, 小标题 11.5pt, 更小的标题 10.5pt.
const HEADING_SIZES: Record<1 | 2 | 3, number> = { 1: 26, 2: 23, 3: BODY_SIZE };
// Use the local Mac's system Song typeface for Chinese and Times New Roman for Latin/math text.
const BODY_FONT = { ascii: "Times New Roman", hAnsi: "Times New Roman", eastAsia: "Songti SC", cs: "Times New Roman", hint: "eastAsia" } as const;
const FONT_TABLE_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:font w:name="Songti SC">
    <w:altName w:val="宋体"/>
    <w:charset w:val="86"/>
    <w:family w:val="roman"/>
    <w:pitch w:val="variable"/>
  </w:font>
  <w:font w:name="Times New Roman">
    <w:charset w:val="00"/>
    <w:family w:val="roman"/>
    <w:pitch w:val="variable"/>
  </w:font>
  <w:font w:name="Cambria Math">
    <w:charset w:val="00"/>
    <w:family w:val="roman"/>
    <w:pitch w:val="variable"/>
  </w:font>
</w:fonts>`;

// Body lines are at least 23.4 pt: 1.5 × the 15.6 pt grid of Chinese Word papers, which is what 菁优网's papers
// measure in Word. The height then no longer depends on the 宋体 installed on the reader's machine (Songti SC's
// tall line box doubled it on a Mac), and a line holding a fraction still grows to fit it.
const BODY_LINE = { lineRule: LineRuleType.AT_LEAST, line: 468 } as const;
const COMPACT_LINE = { lineRule: LineRuleType.AT_LEAST, line: 390 } as const;

type RunStyle = { bold?: boolean; color?: string; italicMath?: boolean; size?: number };

function textRuns(text: string, size = BODY_SIZE, style: RunStyle = {}) {
  const pieces = style.italicMath ? text.split(/([A-Za-z]+)/g).filter(Boolean) : [text];
  return pieces.map((piece) => new TextRun({
    text: piece,
    size,
    bold: style.bold,
    color: style.color,
    italics: style.italicMath && (/^[A-Z]{1,4}$/.test(piece) || /^[a-z]$/.test(piece)),
    font: BODY_FONT,
  }));
}

const latexSymbols: Record<string, string> = {
  times: "×", div: "÷", cdot: "·", pm: "±", mp: "∓", le: "≤", leq: "≤", ge: "≥", geq: "≥",
  ne: "≠", neq: "≠", approx: "≈", angle: "∠", triangle: "△", pi: "π", Delta: "Δ", delta: "δ", infty: "∞", therefore: "∴", because: "∵",
  circ: "°", sim: "∽", backsim: "∽", cong: "≌", perp: "⊥", parallel: "∥", cdots: "⋯", ldots: "…", quad: "\u3000", qquad: "\u3000\u3000",
  rightarrow: "→", to: "→", leftarrow: "←", leftrightarrow: "↔", Rightarrow: "⇒", Leftarrow: "⇐", Leftrightarrow: "⇔",
  in: "∈", notin: "∉", subset: "⊂", subseteq: "⊆", cup: "∪", cap: "∩", emptyset: "∅", odot: "⊙",
  alpha: "α", beta: "β", gamma: "γ", theta: "θ", star: "⋆", bigstar: "★", bigwhitestar: "☆",
};
const superscripts: Record<string, string> = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "⁺": "+", "⁻": "−" };

const UPRIGHT_COMMANDS = new Set(["text", "textrm", "mathrm", "operatorname"]);
const UPRIGHT_OPEN = "\uE200"; const UPRIGHT_CLOSE = "\uE201";

// Word sets a math run in italics unless told otherwise, and WPS italicizes digits too. Only letters stay
// italic, as on the web: numbers, operators, Chinese and \text{…} words are set upright (m:sty p).
export function uprightMathRuns(xml: string) {
  return xml.replace(/<m:r>((?:<m:rPr>(?:(?!<\/m:rPr>)[\s\S])*<\/m:rPr>)?)((?:<w:rPr>(?:(?!<\/w:rPr>)[\s\S])*<\/w:rPr>)?)<m:t([^>]*)>([^<]*)<\/m:t><\/m:r>/g,
    (whole, math: string, word: string, attributes: string, value: string) => {
      const marked = value.startsWith(UPRIGHT_OPEN) && value.endsWith(UPRIGHT_CLOSE);
      const content = marked ? value.slice(1, -1) : value;
      if (!marked && /[A-Za-z\u0370-\u03ff]/.test(content)) return whole;
      if (/<m:sty\b|<m:nor\/>/.test(math)) return marked ? whole.replace(value, content) : whole;
      const style = math ? math.replace("<m:rPr>", '<m:rPr><m:sty m:val="p"/>') : '<m:rPr><m:sty m:val="p"/></m:rPr>';
      return `<m:r>${style}${word}<m:t${marked || /^\s|\s$/.test(content) ? ' xml:space="preserve"' : attributes}>${content}</m:t></m:r>`;
    });
}

function mathComponents(source: string): MathComponent[] {
  const text = normalizeMathNotation(source).replace(/\*\*/g, "^").replace(/（/g, "(").replace(/）/g, ")").replace(/＝/g, "=").replace(/＋/g, "+").replace(/－/g, "−").replace(/＜/g, "<").replace(/＞/g, ">");
  const cursor = { index: 0 };

  function group(): MathComponent[] {
    while (/\s/.test(text[cursor.index] ?? "")) cursor.index += 1;
    if (text[cursor.index] === "{") { cursor.index += 1; return sequence("}"); }
    if (text[cursor.index] === "(") { cursor.index += 1; return [new MathRoundBrackets({ children: sequence(")") })]; }
    if (text[cursor.index] === "\\") {
      cursor.index += 1;
      const command = text.slice(cursor.index).match(/^[A-Za-z]+/)?.[0] ?? text[cursor.index] ?? "";
      cursor.index += command.length;
      if (UPRIGHT_COMMANDS.has(command)) return [uprightRun()];
      if (["mathbf", "mathit"].includes(command)) return group();
      if (command === "sqrt") return [new MathRadical({ children: group() })];
      return [new MathRun(latexSymbols[command] ?? command)];
    }
    const char = text[cursor.index++] ?? "";
    return char ? [new MathRun(char)] : [];
  }

  // \text{ cm} and the like: the words as one run, set upright.
  function uprightRun() {
    while (/\s/.test(text[cursor.index] ?? "")) cursor.index += 1;
    let words = "";
    if (text[cursor.index] === "{") {
      let depth = 0;
      for (cursor.index += 1; cursor.index < text.length; cursor.index += 1) {
        const char = text[cursor.index];
        if (char === "}" && depth === 0) { cursor.index += 1; break; }
        if (char === "{") depth += 1; else if (char === "}") depth -= 1;
        words += char;
      }
    } else words = text[cursor.index++] ?? "";
    return new MathRun(`${UPRIGHT_OPEN}${words.replace(/[{}]/g, "")}${UPRIGHT_CLOSE}`);
  }

  function sequence(end?: string): MathComponent[] {
    const result: MathComponent[] = [];
    while (cursor.index < text.length) {
      const char = text[cursor.index];
      if (end && char === end) { cursor.index += 1; break; }
      if (char === "{") { cursor.index += 1; result.push(...sequence("}")); continue; }
      if (char === "(") { cursor.index += 1; result.push(new MathRoundBrackets({ children: sequence(")") })); continue; }
      if (char === "\\") {
        cursor.index += 1;
        const command = text.slice(cursor.index).match(/^[A-Za-z]+/)?.[0] ?? text[cursor.index] ?? "";
        cursor.index += command.length;
        if (command === "left" || command === "right") continue;
        if (UPRIGHT_COMMANDS.has(command)) { result.push(uprightRun()); continue; }
        if (["mathbf", "mathit"].includes(command)) { result.push(...group()); continue; }
        if ([",", ";", "!", " "].includes(command)) { if (command !== "!") result.push(new MathRun(" ")); continue; }
        if (command === "frac") { result.push(new MathFraction({ numerator: group(), denominator: group() })); continue; }
        if (command === "sqrt") { result.push(new MathRadical({ children: group() })); continue; }
        result.push(new MathRun(latexSymbols[command] ?? command));
        continue;
      }
      if (char === "√") { cursor.index += 1; result.push(new MathRadical({ children: group() })); continue; }
      if ((char === "^" || char === "_") && result.length) {
        cursor.index += 1;
        const base = result.pop()!;
        const script = group();
        result.push(char === "^" ? new MathSuperScript({ children: [base], superScript: script }) : new MathSubScript({ children: [base], subScript: script }));
        continue;
      }
      if (superscripts[char] && result.length) {
        let exponent = "";
        while (superscripts[text[cursor.index]]) exponent += superscripts[text[cursor.index++]];
        result.push(new MathSuperScript({ children: [result.pop()!], superScript: [new MathRun(exponent)] }));
        continue;
      }
      // A number is one run (5.4, not 5 . 4).
      const number = /[0-9]/.test(char) ? text.slice(cursor.index).match(/^[0-9]+(?:\.[0-9]+)?/)![0] : char;
      result.push(new MathRun(number)); cursor.index += number.length;
    }
    return result;
  }

  const components = sequence();
  return components.length ? components : [new MathRun(source)];
}

// Commands the small converter above understands. A formula using anything else — cases, arrays, underlines,
// bold — goes through KaTeX's MathML and becomes a native Word equation instead (see richEquation).
const SIMPLE_COMMANDS = new Set([...Object.keys(latexSymbols), "frac", "sqrt", "left", "right", "mathrm", "text", "operatorname", "mathbf", "mathit", "textrm"]);
const needsRichEquation = (source: string) => /\\sqrt\s*\[/.test(source) || [...normalizeMathNotation(source).matchAll(/\\([A-Za-z]+)/g)].some((match) => !SIMPLE_COMMANDS.has(match[1]));

// OMML written for Word, which is stricter than other readers: no repeated argument properties, math run
// properties before Word run properties, and a brace written in front of a matrix becomes one that stretches.
export function tidyOmml(omml: string) {
  return omml
    // mathml2omml decodes entities in math text without escaping them again.
    // A comparison such as x<−2 must remain text, not break document.xml.
    .replace(/(<m:t(?:\s[^>]*)?>)([\s\S]*?)(<\/m:t>)/g, (_, open: string, text: string, close: string) => open + text
      .replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + close)
    .replace(/<m:sty m:val="undefined"\/>/g, "")
    // Text that mixes Chinese with digits or spaces is split by script, so each part is measured with its own font.
    .replace(/<m:r>(<m:rPr>(?:(?!<\/m:rPr>)[\s\S])*<\/m:rPr>)((?:<w:rPr>(?:(?!<\/w:rPr>)[\s\S])*<\/w:rPr>)?)<m:t xml:space="preserve">([^<]*)<\/m:t><\/m:r>/g,
      (whole, math: string, word: string, text: string) => {
        const parts = text.match(/[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]+|[^\u3000-\u303f\u3400-\u9fff\uff00-\uffef]+/g) ?? [];
        return parts.length < 2 ? whole : parts.map((part) => `<m:r>${math}${word}<m:t xml:space="preserve">${part}</m:t></m:r>`).join("");
      })
    // A script with nothing in it is no script: Word would show an empty box.
    .replace(/<m:sSub><m:sSubPr>(?:(?!<\/m:sSubPr>)[\s\S])*<\/m:sSubPr><m:e>((?:(?!<m:sSub>)[\s\S])*?)<\/m:e><m:sub\/><\/m:sSub>/g, "$1")
    // Lines under or over a formula are bars, not accents (an underline arrives tagged “_”, see richEquation).
    .replace(/<m:acc><m:accPr><m:chr m:val="([_‾])"\/><\/m:accPr><m:e>((?:(?!<m:acc>)[\s\S])*?)<\/m:e><\/m:acc>/g,
      (_, line: string, body: string) => `<m:bar><m:barPr><m:pos m:val="${line === "_" ? "bot" : "top"}"/></m:barPr><m:e>${body}</m:e></m:bar>`)
    .replace(/<m:argPr>(?:(?!<\/m:argPr>)[\s\S])*<\/m:argPr>/g, "")
    .replace(/<m:r>(<w:rPr>(?:(?!<\/w:rPr>)[\s\S])*<\/w:rPr>)(<m:rPr>(?:(?!<\/m:rPr>)[\s\S])*<\/m:rPr>)/g, "<m:r>$2$1")
    .replace(/<m:r>(?:<m:rPr>(?:(?!<\/m:rPr>)[\s\S])*<\/m:rPr>)?<m:t(?: [^>]*)?>([{[(|])<\/m:t><\/m:r>(<m:m>(?:(?!<\/m:m>)[\s\S])*<\/m:m>)/g,
      (_, open: string, matrix: string) => `<m:d><m:dPr><m:begChr m:val="${open}"/><m:endChr m:val=""/></m:dPr><m:e>${open === "{" ? matrix.replace(/<m:mcJc m:val="center"\/>/g, '<m:mcJc m:val="left"/>') : matrix}</m:e></m:d>`);
}

// Native equations placed by token: the run carrying the token is replaced by the OMML when the document is packed.
const richEquations = new Map<string, string>();
const EM_GAP = "\u303F";
function richEquation(source: string, display: boolean): ParagraphChild | null {
  try {
    // \quad is a 1em gap (a blank to fill in, a pause between parts). MathML makes it a plain space that Word squeezes
    // and the converter drops other spaces, so it travels as a placeholder and lands as the ideographic space (1em).
    const latex = toLatexMath(source).replace(/\\qquad(?![A-Za-z])/g, `\\text{${EM_GAP}${EM_GAP}}`).replace(/\\quad(?![A-Za-z])/g, `\\text{${EM_GAP}}`);
    const html = katex.renderToString(latex, { output: "mathml", displayMode: display, throwOnError: true, strict: "ignore", macros: { "\\parallelogram": "\\text{▱}" } });
    // MathML marks over- and underlines with the same character; underlines are tagged before conversion.
    const math = html.match(/<math[\s\S]*<\/math>/)?.[0]?.replace(/<annotation[\s\S]*?<\/annotation>/g, "")
      .replace(/(<munder accentunder="true">[\s\S]*?)<mo stretchy="true">‾<\/mo>(<\/munder>)/g, "$1<mo stretchy=\"true\">_</mo>$2");
    if (!math) return null;
    const token = `__ZHITI_OMML_${richEquations.size}_${Math.random().toString(36).slice(2, 8)}__`;
    richEquations.set(token, tidyOmml(mml2omml(math)).replaceAll(EM_GAP, "\u3000"));
    return new TextRun({ text: token });
  } catch {
    return null;
  }
}

function equation(source: string, display = false): ParagraphChild {
  return (needsRichEquation(source) && richEquation(source.trim(), display)) || new WordMath({ children: mathComponents(source.trim()) });
}

function sanitizeXml10(value: string) {
  const restored = value.replace(/&#(?:12|x0*c);/gi, "\\f");
  return Array.from(restored, (character) => {
    const code = character.charCodeAt(0);
    if (code === 12) return "\\f";
    return code <= 8 || code === 11 || (code >= 14 && code <= 31) ? "" : character;
  }).join("");
}

function needsWordEquation(value: string, explicit = false) {
  return needsWordMathEquation(value, explicit);
}

// Simple formulas — a letter, v₀, x², a=6, ∠A=30°, 1 cm — are set as text, the way printed Chinese papers (菁优网's
// Word papers included) set them: Times italic letters, upright digits, full-width ＝＋﹣＜＞. A line of such text keeps
// the body's height, where an equation object (Cambria Math) pushes it onto a taller line and changes the letters'
// look. Fractions, roots and anything else with structure stay native, editable Word equations. Returns null then.
const PLAIN_OPERATORS: Record<string, string> = { "=": "＝", "+": "＋", "-": "﹣", "−": "﹣", "<": "＜", ">": "＞", "'": "′" };
const FUNCTION_NAME = /^(?:sin|cos|tan|cot|log|ln|lg|lim|max|min)$/;
type PlainMathPiece = { text: string; italic?: boolean; script?: "sub" | "super"; underline?: boolean };
export function plainMathPieces(source: string): PlainMathPiece[] | null {
  const text = source.trim(); const pieces: PlainMathPiece[] = []; let index = 0;
  const letters = (value: string, script?: PlainMathPiece["script"]) => {
    for (const part of value.split(/([A-Za-z]+)/).filter(Boolean)) pieces.push({ text: part, italic: /^[A-Za-z]+$/.test(part) && !FUNCTION_NAME.test(part), script });
  };
  const command = () => { const name = text.slice(index + 1).match(/^[A-Za-z]+|^[\s\S]/)?.[0] ?? ""; index += 1 + name.length; return name; };
  const braced = () => {
    while (text[index] === " ") index += 1;
    // Unbraced, a script or argument is one token, and a command is one token: 90^\circ is 90°, not 90 with a raised backslash.
    if (text[index] !== "{") { const token = text.slice(index).match(/^\\(?:[A-Za-z]+|[\s\S])|^[\s\S]/)?.[0]; if (!token) return null; index += token.length; return token; }
    const end = text.indexOf("}", index); const inner = end < 0 ? null : text.slice(index + 1, end);
    if (inner == null || inner.includes("{")) return null;
    index = end + 1; return inner;
  };
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      const name = command();
      if (name === "left" || name === "right") { if (text[index] === ".") index += 1; continue; }
      if (UPRIGHT_COMMANDS.has(name)) { const words = braced(); if (words == null || /[\\^_]/.test(words)) return null; pieces.push({ text: words }); continue; }
      if ([",", ";", ":", " "].includes(name)) { pieces.push({ text: " " }); continue; }
      if (name === "!") continue;
      if (["%", "{", "}", "#", "&", "$"].includes(name)) { pieces.push({ text: name }); continue; }
      if (FUNCTION_NAME.test(name)) { pieces.push({ text: name }); continue; }
      // A blank to fill in, \underline{\quad\quad}: underlined ideographic spaces sit on the text's baseline, as printed.
      if (name === "underline") {
        const inner = braced(); if (inner == null) return null;
        const gaps = inner.replace(/\\qquad(?![A-Za-z])/g, "\u3000\u3000").replace(/\\quad(?![A-Za-z])/g, "\u3000").replace(/~|\\ /g, "\u3000");
        if (!/^[\s\u3000]*$/.test(gaps)) return null;
        pieces.push({ text: "\u3000".repeat(Math.max(2, [...gaps].filter((char) => char === "\u3000").length)), underline: true }); continue;
      }
      const symbol = latexSymbols[name]; if (!symbol) return null;
      pieces.push({ text: symbol, italic: /^[α-ωΔ]$/.test(symbol) && symbol !== "π" ? true : undefined }); continue;
    }
    if (char === "^" || char === "_") {
      index += 1; const script = char === "^" ? "super" : "sub";
      let content = braced(); if (content == null) return null;
      if (/[\^_]/.test(content.replace(/\\(?:circ|prime|ast)(?![A-Za-z])/g, ""))) return null;
      if (/^\\circ$/.test(content.trim())) { pieces.push({ text: "°" }); continue; }
      content = content.replace(/\\prime/g, "′").replace(/\\ast/g, "*").replace(/\\circ/g, "°");
      if (content.includes("\\")) return null;
      letters(content, script); continue;
    }
    // Grouping braces and spaces typed between symbols mean nothing in a formula (\angle A reads ∠A).
    if (char === "{" || char === "}" || char === " ") { index += 1; continue; }
    if (/[A-Za-z]/.test(char)) { const word = text.slice(index).match(/^[A-Za-z]+/)![0]; letters(word); index += word.length; continue; }
    // A sign (+6, −3, x=−1) stays tight to its number; between two terms + and − are spaced like ＝.
    if ((char === "+" || char === "-" || char === "−") && /^$|[(（=＝<＜>＞≤≥≠,，:：＋﹣×÷±]$/.test(pieces.map((piece) => piece.text).join("").trim())) {
      pieces.push({ text: char === "+" ? "+" : "−" }); index += 1; continue;
    }
    if (PLAIN_OPERATORS[char]) { pieces.push({ text: PLAIN_OPERATORS[char] }); index += 1; continue; }
    if (/[0-9.,，;；:：()（）[\]|%°!?·×÷±≤≥≠≈∠△⊥∥∽≌∈∉⊂⊆∪∩∅⋯…→←⇒⇔∞\s\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/.test(char)) { pieces.push({ text: char }); index += 1; continue; }
    return null;
  }
  return pieces.length ? pieces : null;
}

function plainMathRuns(source: string, size: number, style: RunStyle) {
  const merged = plainMathPieces(source)?.reduce<PlainMathPiece[]>((runs, piece) => {
    const last = runs.at(-1);
    if (last && last.italic === piece.italic && last.script === piece.script && last.underline === piece.underline) last.text += piece.text; else runs.push({ ...piece });
    return runs;
  }, []);
  return merged?.map((piece) => new TextRun({ text: piece.text, size, bold: style.bold, color: style.color, italics: piece.italic === true, font: BODY_FONT, subScript: piece.script === "sub", superScript: piece.script === "super", underline: piece.underline ? {} : undefined })) ?? null;
}

export function richText(text: string, style: RunStyle = {}): ParagraphChild[] {
  const size = style.size ?? BODY_SIZE;
  return splitMathText(text).flatMap((segment): ParagraphChild[] => {
    if (segment.kind !== "math" || !needsWordEquation(segment.value, segment.explicit)) return textRuns(segment.value, size, { ...style, italicMath: true });
    return (segment.display !== true && plainMathRuns(segment.value, size, style)) || [equation(segment.value, segment.display === true)];
  });
}

function optionTable(options: string[], compact = false) {
  const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
  const columnCount = optionColumnCount(options);
  const cellWidth = Math.floor(9746 / columnCount);
  const rows: TableRow[] = [];
  for (let start = 0; start < options.length; start += columnCount) {
    const cells: TableCell[] = [];
    for (let offset = 0; offset < columnCount; offset += 1) {
      const index = start + offset; const option = options[index];
      cells.push(new TableCell({
        width: { size: cellWidth, type: WidthType.DXA },
        margins: { top: compact ? 0 : 40, bottom: compact ? 40 : 80, left: 180, right: 120 },
        children: [new Paragraph({ spacing: { ...(compact ? COMPACT_LINE : BODY_LINE) }, children: option == null ? [] : [...textRuns(`${optionLabels[index]}．`), ...richText(option)] })],
      }));
    }
    rows.push(new TableRow({ children: cells }));
  }
  return new Table({
    width: { size: 9746, type: WidthType.DXA },
    columnWidths: Array.from({ length: columnCount }, () => cellWidth),
    layout: TableLayoutType.FIXED,
    borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none },
    rows,
  });
}

type ResolvedWordImage = Awaited<ReturnType<typeof resolveWordImageSource>>;

async function imageParagraphFromSource(source: string, resolveImage: (source: string) => Promise<ResolvedWordImage>, maxWidth = 300, maxHeight = 210, after = 140, alignment: (typeof AlignmentType)[keyof typeof AlignmentType] = AlignmentType.CENTER, before = 80): Promise<Paragraph> {
  const { data, mimeType, type } = await resolveImage(source);
  const dimensions = await new Promise<{ width: number; height: number }>((resolve) => {
    const objectUrl = URL.createObjectURL(new Blob([data], { type: mimeType }));
    const image = new Image();
    const finish = (value: { width: number; height: number }) => { URL.revokeObjectURL(objectUrl); resolve(value); };
    image.onload = () => finish({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => finish({ width: 600, height: 360 });
    image.src = objectUrl;
  });
  const scale = Math.min(1, maxWidth / dimensions.width, maxHeight / dimensions.height);
  const width = Math.round(dimensions.width * scale); const height = Math.round(dimensions.height * scale);
  return new Paragraph({ alignment, spacing: { lineRule: LineRuleType.AUTO, line: 240, before, after }, children: [new ImageRun({ data, type, transformation: { width, height } })] });
}

export type WordAnswerPlacement = "none" | "end" | "each";
// Handout parts (知识点/例题/练习/变式) add a labelled sub-heading, numbers counted per part, 考点 lines and,
// for 学生版 例题, a note area in place of working lines. Plain question lists set no part.
export type WordPart = { key: string; label: string; tagline: string; prefix?: string; answerTitle?: string; points?: boolean; noteLines?: number };
// Headings are printed as given; question numbers run on across sections.
export type WordSection = { heading?: string; note?: string; questions: Question[]; part?: WordPart };

export async function buildQuestionsWordBlob(questions: Question[], title: string, includeAnswers: boolean, order: "type" | "basket" = "type") {
  const sections: WordSection[] = order === "basket"
    ? questions.length ? [{ heading: `试题（共${questions.length}题）`, questions }] : []
    : typeOrder.map((type) => ({ type, questions: questions.filter((question) => question.type === type) }))
      .filter((group) => group.questions.length)
      .map((group, index) => ({ heading: `${sectionNumbers[index]}、${typeNames[group.type]}（共${group.questions.length}题）`, questions: group.questions }));
  return buildWordBlob({ title, sections, answers: includeAnswers ? "end" : "none" });
}

const ANSWER_TITLES: Record<string, string> = { example: "例题解析", practice: "练习答案", variant: "变式答案" };

// A 讲义: each module heading, then its 知识点 and question bands in the fixed order.
export function handoutWordSections(modules: HandoutExportModule[], answers: WordAnswerPlacement): WordSection[] {
  const sections: WordSection[] = [];
  modules.forEach((module, index) => {
    const heading = moduleHeading(module.heading, index);
    if (modules.length > 1 || heading.title) sections.push({ heading: `模块${heading.numeral}\u3000${heading.title}`.trim(), questions: [] });
    if (module.note.trim()) sections.push({ note: module.note, questions: [], part: { key: "knowledge", ...HANDOUT_PARTS.knowledge } });
    for (const band of HANDOUT_BANDS) {
      if (!module.bands[band].length) continue;
      const part = HANDOUT_PARTS[band];
      sections.push({ questions: module.bands[band], part: { key: band, label: part.label, tagline: part.tagline, prefix: part.prefix, answerTitle: ANSWER_TITLES[band], points: true, noteLines: band === "example" && answers !== "each" ? 4 : undefined } });
    }
  });
  return sections;
}

export async function buildWordBlob({ title, sections, answers }: { title: string; sections: WordSection[]; answers: WordAnswerPlacement }) {
  const imageCache = new Map<string, Promise<ResolvedWordImage>>();
  const resolveImage = (source: string) => {
    let pending = imageCache.get(source);
    if (!pending) { pending = resolveWordImageSource(source); imageCache.set(source, pending); }
    return pending;
  };
  const imageParagraph = (source: string, maxWidth = 300, maxHeight = 210, after = 140, alignment: (typeof AlignmentType)[keyof typeof AlignmentType] = AlignmentType.CENTER, before = 80) =>
    imageParagraphFromSource(source, resolveImage, maxWidth, maxHeight, after, alignment, before);
  const rawParagraphs: Array<{ token: string; xml: string; assets?: Record<string, string>; questionNumber?: string }> = [];
  // A row of figures side by side, captions under each and the row's note beside them, as a borderless table.
  const figureRow = async (line: Extract<NoteLine, { kind: "figures" }>): Promise<Array<Paragraph | Table>> => {
    const spansRuns = (spans: NoteSpan[], size = BODY_SIZE) => spans.flatMap((span) => richText(span.text, { bold: span.bold, size }));
    const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
    // Every figure gets a cell of one width and the table starts at the left margin, so figures line up row to row.
    const figureWidth = Math.min(2900, Math.floor((9746 - (line.side.length ? 2900 : 0)) / line.figures.length));
    const sideWidth = line.side.length ? 9746 - figureWidth * line.figures.length : 0;
    const maxWidth = Math.min(260, Math.floor(figureWidth / 15) - 12); const maxHeight = line.figures.length >= 3 ? 130 : 150;
    const cells = await Promise.all(line.figures.map(async (figure) => new TableCell({
      width: { size: figureWidth, type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER, margins: { top: 40, bottom: 40, left: 60, right: 60 },
      children: [await imageParagraph(figure.src, maxWidth, maxHeight, 20, AlignmentType.CENTER, 20),
        new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 20 }, children: spansRuns(figure.caption, 18) })],
    })));
    if (sideWidth) cells.push(new TableCell({ width: { size: sideWidth, type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER, margins: { top: 40, bottom: 40, left: 120, right: 60 },
      children: line.side.map((spans) => new Paragraph({ spacing: { ...BODY_LINE }, children: spansRuns(spans) })) }));
    return [new Table({
      width: { size: figureWidth * line.figures.length + sideWidth, type: WidthType.DXA }, layout: TableLayoutType.FIXED,
      columnWidths: [...line.figures.map(() => figureWidth), ...(sideWidth ? [sideWidth] : [])],
      borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none },
      rows: [new TableRow({ children: cells })],
    }), new Paragraph({ spacing: { after: 60 }, children: [] })];
  };
  const children: Array<Paragraph | Table> = [
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 240 }, children: textRuns(title, 30, { bold: true }) }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 300 }, children: textRuns("姓名：____________　班级：____________　得分：____________") }),
  ];
  let number = 1;
  const partCounters = new Map<string, number>();
  const rendered: Array<{ question: Question; label: string; part?: WordPart }> = [];
  const pushAnswer = (question: Question, label: string) => {
    children.push(new Paragraph({ spacing: { ...BODY_LINE, after: 80 }, children: [...textRuns(label, BODY_SIZE, { bold: true }), ...richText(question.answer || "略", { bold: true })] }));
    if (!question.analysis) return;
    const originalParagraphs = question.analysis.split(/\r?\n/).filter((line) => line.length > 0);
    if (question.analysisDocxXml?.length) {
      question.analysisDocxXml.forEach((xml) => {
        const token = `__ZHITI_RAW_ANALYSIS_${rawParagraphs.length}__`;
        rawParagraphs.push({ token, xml, assets: question.analysisDocxAssets });
        children.push(new Paragraph({ children: textRuns(token) }));
      });
    } else if (originalParagraphs[0]?.startsWith("【")) {
      originalParagraphs.forEach((line, lineIndex) => children.push(new Paragraph({ spacing: { ...BODY_LINE, after: lineIndex === originalParagraphs.length - 1 ? 180 : 40 }, children: richText(line) })));
    } else {
      children.push(new Paragraph({ spacing: { ...BODY_LINE, after: 180 }, children: [...textRuns("解析："), ...richText(question.analysis)] }));
    }
  };
  for (const section of sections) {
    const heading = section.heading?.trim();
    // A heading must never be stranded at the bottom of a page.
    if (heading) children.push(new Paragraph({ keepNext: true, spacing: { before: 180, after: 120 }, children: textRuns(heading, BODY_SIZE, { bold: true }) }));
    const part = section.part;
    if (part) children.push(new Paragraph({ keepNext: true, spacing: { before: 160, after: 100 }, children: [...textRuns(part.label, BODY_SIZE, { bold: true, color: "2F6B53" }), ...textRuns(`\u3000${part.tagline}`, 18, { color: "6F7D76" })] }));
    for (const line of parseHandoutNote(section.note)) {
      if (line.kind === "figures") { children.push(...await figureRow(line)); continue; }
      const size = line.kind === "heading" ? HEADING_SIZES[line.level] : BODY_SIZE;
      const runs = line.spans.flatMap((span) => richText(span.text, line.kind === "heading" || span.bold ? { bold: true, size } : {}));
      children.push(new Paragraph({
        spacing: { ...BODY_LINE, after: 80 },
        ...(line.kind === "item" ? { indent: { left: 420, hanging: 420 } } : {}),
        children: line.kind === "item" ? [...textRuns(line.marker, BODY_SIZE, { bold: true }), ...runs] : runs,
      }));
    }
    for (const question of section.questions) {
      let label = String(number);
      if (part) { const count = (partCounters.get(part.key) ?? 0) + 1; partCounters.set(part.key, count); label = `${part.prefix ?? ""}${count}`; }
      rendered.push({ question, label, part });
      const source = question.source ? `（${question.source}）` : "";
      const stemParagraphs = (question.stemParagraphs?.length ? question.stemParagraphs : question.stem.split(/\r?\n/)).filter((line) => line.length > 0);
      const compactConclusion = isCompactConclusionQuestion(question);
      const images = standaloneWordQuestionImages(question);
      if (question.stemDocxXml?.length) {
        question.stemDocxXml.forEach((xml, rawIndex) => {
          const token = `__ZHITI_RAW_STEM_${rawParagraphs.length}__`;
          rawParagraphs.push({ token, xml, assets: question.stemDocxAssets, questionNumber: rawIndex === 0 ? label : undefined });
          children.push(new Paragraph({ children: textRuns(token) }));
        });
      } else {
        // Hanging indent: wrapped lines of the first paragraph line up with the paragraphs after it, as on the web card.
        // Like the page, drop the number a homework stem was printed with; the paper numbers its questions itself.
        const stem = new Paragraph({ indent: { left: 420, hanging: 420 }, spacing: { ...(compactConclusion ? COMPACT_LINE : BODY_LINE), after: compactConclusion ? 0 : stemParagraphs.length > 1 ? 40 : 100 }, children: [...textRuns(`${label}．`), ...textRuns(source, BODY_SIZE, { color: "2478A8" }), ...richText((stemParagraphs[0] ?? question.stem).replace(/^\s*\d{1,3}[.．、]\s*/, ""))] });
        children.push(stem);
        for (const continuation of stemParagraphs.slice(1)) children.push(new Paragraph({ indent: { left: 420 }, spacing: { ...(compactConclusion ? COMPACT_LINE : BODY_LINE), after: compactConclusion ? 0 : 40 }, children: richText(continuation) }));
      }
      const imageLayout = resolveQuestionImageLayout(question);
      if (images.length && compactConclusion) {
        for (const image of images) children.push(await imageParagraph(image, 195, 155, 30, AlignmentType.LEFT, 20));
      } else if (images.length && imageLayout === "right") {
        const figureWidth = sourceFigureWidth(question);
        children.push(figureWidth ? await imageParagraph(images[0], Math.round(650 * figureWidth), 900, 80, AlignmentType.RIGHT) : await imageParagraph(images[0], 220, 165, 80, AlignmentType.RIGHT));
        for (const image of images.slice(1)) children.push(await imageParagraph(image, 280, 195));
      } else if (images.length && imageLayout === "below-right") {
        for (const image of images) children.push(await imageParagraph(image, 300, 210, 140, AlignmentType.RIGHT));
      } else {
        // A screenshot figure keeps its share of the line width (9746 twips ≈ 650 px); others use the standard size.
        const figureWidth = imageLayout === "below" ? sourceFigureWidth(question) : null;
        for (const image of images) children.push(figureWidth ? await imageParagraph(image, Math.round(650 * figureWidth), 900, 140, AlignmentType.LEFT) : await imageParagraph(image, 300, 210));
      }
      if (question.optionsImage) children.push(await imageParagraph(question.optionsImage, 650, 320, 120, AlignmentType.LEFT));
      if (question.optionsDocxXml?.length) {
        question.optionsDocxXml.forEach((xml) => {
          const token = `__ZHITI_RAW_OPTIONS_${rawParagraphs.length}__`;
          rawParagraphs.push({ token, xml, assets: question.optionsDocxAssets });
          children.push(new Paragraph({ children: textRuns(token) }));
        });
      } else if (question.options.length) {
        children.push(optionTable(question.options, compactConclusion));
        children.push(new Paragraph({ spacing: { after: 80 }, children: textRuns("　") }));
      } else if (answers !== "each" && !part?.noteLines) {
        const answerLines = question.type === "解答题" ? 5 : 1;
        for (let i = 0; i < answerLines; i += 1) children.push(new Paragraph({ spacing: { after: 180 }, children: textRuns("　") }));
      }
      const points = part?.points ? questionPoints(question) : [];
      if (points.length) children.push(new Paragraph({ indent: { left: 420 }, spacing: { after: 80 }, children: textRuns(`考点：${points.join("、")}`, 18, { color: "6F7D76" }) }));
      if (part?.noteLines && answers !== "each") {
        children.push(new Paragraph({ indent: { left: 420 }, spacing: { before: 60, after: 40 }, children: textRuns("课堂笔记", 18, { color: "6F7D76" }) }));
        // Consecutive paragraphs with the same border merge into one box in Word, so each ruled line is its own table row.
        const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
        const rule = { style: BorderStyle.SINGLE, size: 4, color: "CFDDD5" };
        children.push(new Table({
          width: { size: 9326, type: WidthType.DXA }, columnWidths: [9326], indent: { size: 420, type: WidthType.DXA }, layout: TableLayoutType.FIXED,
          borders: { top: none, left: none, right: none, bottom: none, insideHorizontal: none, insideVertical: none },
          rows: Array.from({ length: part.noteLines }, () => new TableRow({ height: { value: 520, rule: "atLeast" }, children: [new TableCell({ width: { size: 9326, type: WidthType.DXA }, borders: { top: none, left: none, right: none, bottom: rule }, children: [new Paragraph({ children: textRuns("\u3000") })] })] })),
        }));
        children.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
      }
      if (answers === "each") pushAnswer(question, "答案：");
      number += 1;
    }
  }
  if (answers === "end") {
    children.push(new Paragraph({ pageBreakBefore: true, alignment: AlignmentType.CENTER, spacing: { after: 240 }, children: textRuns(title, 30, { bold: true }) }));
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 240 }, children: textRuns("参考答案与试题解析", BODY_SIZE, { bold: true }) }));
    if (!rendered.some((entry) => entry.part)) rendered.forEach((entry) => pushAnswer(entry.question, `${entry.label}．答案：`));
    // A 讲义 key is grouped as 例题解析 / 练习答案 / 变式答案, with the labels used in the body.
    else for (const key of HANDOUT_BANDS) {
      const entries = rendered.filter((entry) => entry.part?.key === key);
      if (!entries.length) continue;
      children.push(new Paragraph({ keepNext: true, spacing: { before: 180, after: 100 }, children: textRuns(entries[0].part?.answerTitle ?? key, BODY_SIZE, { bold: true, color: "2F6B53" }) }));
      entries.forEach((entry) => pushAnswer(entry.question, `${entry.label}．答案：`));
    }
  }
  const doc = new Document({
    styles: { default: { document: { run: { font: BODY_FONT, size: BODY_SIZE }, paragraph: { spacing: { ...BODY_LINE, after: 0 } } } } },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 } } }, children }],
  });
  const packedBlob = await Packer.toBlob(doc);
  const archive = await JSZip.loadAsync(await packedBlob.arrayBuffer());
  archive.file("word/fontTable.xml", FONT_TABLE_XML);
  const settingsXml = await archive.file("word/settings.xml")!.async("text");
  archive.file("word/settings.xml", ensureWordMathSettings(settingsXml));
  let documentXml = await archive.file("word/document.xml")!.async("text");
  if (rawParagraphs.length) {
    let relationshipsXml = await archive.file("word/_rels/document.xml.rels")!.async("text");
    let embeddedImageIndex = 0;
    for (const replacement of rawParagraphs) {
      const placeholderParagraph = new RegExp(`<w:p\\b[^>]*>(?:(?!<w:p\\b)[\\s\\S])*?${replacement.token}(?:(?!<w:p\\b)[\\s\\S])*?<\\/w:p>`);
      // XMLSerializer can expose Word's linear-math `\\frac` escape as a form-feed
      // control character. XML 1.0 rejects that byte, so restore the original
      // backslash sequence before transplanting the otherwise untouched paragraph.
      let safeParagraphXml = sanitizeXml10(replacement.xml);
      if (replacement.questionNumber != null) safeParagraphXml = safeParagraphXml.replace(/(<w:t\b[^>]*>)\s*\d{1,3}[.．、]/, `$1${replacement.questionNumber}．`);
      for (const oldId of new Set(Array.from(safeParagraphXml.matchAll(/r:(?:embed|id)="([^"]+)"/g), (match) => match[1]))) {
        const source = replacement.assets?.[oldId]; if (!source) continue;
        embeddedImageIndex += 1;
        const { data, type } = await resolveImage(source);
        const fileName = `zhiti-embedded-${embeddedImageIndex}.${type}`;
        const newId = `rIdZhitiEmbedded${embeddedImageIndex}`;
        archive.file(`word/media/${fileName}`, data);
        relationshipsXml = relationshipsXml.replace("</Relationships>", `<Relationship Id="${newId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${fileName}"/></Relationships>`);
        safeParagraphXml = safeParagraphXml.replaceAll(`r:embed="${oldId}"`, `r:embed="${newId}"`);
        safeParagraphXml = safeParagraphXml.replaceAll(`r:id="${oldId}"`, `r:id="${newId}"`);
      }
      documentXml = documentXml.replace(placeholderParagraph, () => safeParagraphXml);
    }
    archive.file("word/_rels/document.xml.rels", relationshipsXml);
  }
  for (const [token, omml] of richEquations) {
    const run = new RegExp(`<w:r>(?:(?!<\\/w:r>)[\\s\\S])*?${token}(?:(?!<\\/w:r>)[\\s\\S])*?<\\/w:r>`);
    if (!run.test(documentXml)) continue;
    documentXml = documentXml.replace(run, () => omml);
    richEquations.delete(token);
  }
  documentXml = fullSizeInlineFractions(uprightMathRuns(sanitizeXml10(documentXml)));
  archive.file("word/document.xml", documentXml);
  const blob = await archive.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  return blob;
}

export function downloadWordBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = fileName; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function exportQuestionsToWord(questions: Question[], title: string, includeAnswers: boolean, order: "type" | "basket" = "type") {
  downloadWordBlob(await buildQuestionsWordBlob(questions, title, includeAnswers, order), `${title || "练习题"}.docx`);
}
