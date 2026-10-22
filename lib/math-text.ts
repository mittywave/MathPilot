// One implementation for the question bank, Answer Studio and Word exports.
export * from "./math-text-core.mjs";

export const latexSymbols: Record<string, string> = {
  times: "×", div: "÷", cdot: "·", pm: "±", mp: "∓", le: "≤", leq: "≤", ge: "≥", geq: "≥",
  ne: "≠", neq: "≠", approx: "≈", angle: "∠", triangle: "△", pi: "π", Delta: "Δ", delta: "δ", infty: "∞", therefore: "∴", because: "∵",
  circ: "°", sim: "∽", backsim: "∽", cong: "≌", perp: "⊥", parallel: "∥", cdots: "⋯", ldots: "…", quad: "\u3000", qquad: "\u3000\u3000",
  rightarrow: "→", to: "→", leftarrow: "←", leftrightarrow: "↔", Rightarrow: "⇒", Leftarrow: "⇐", Leftrightarrow: "⇔",
  in: "∈", notin: "∉", subset: "⊂", subseteq: "⊆", cup: "∪", cap: "∩", emptyset: "∅", odot: "⊙",
  alpha: "α", beta: "β", gamma: "γ", theta: "θ", star: "⋆", bigstar: "★", bigwhitestar: "☆",
};

export const UPRIGHT_COMMANDS = new Set(["text", "textrm", "mathrm", "operatorname"]);

// Simple formulas — a letter, v₀, x², a=6, ∠A=30°, 1 cm — are set as text, the way printed Chinese papers (菁优网's
// Word papers included) set them: Times italic letters, upright digits, full-width ＝＋﹣＜＞. A line of such text keeps
// the body's height, where an equation object (Cambria Math) pushes it onto a taller line and changes the letters'
// look. Fractions, roots and anything else with structure stay native, editable Word equations. Returns null then.
const PLAIN_OPERATORS: Record<string, string> = { "=": "＝", "+": "＋", "-": "﹣", "−": "﹣", "<": "＜", ">": "＞", "'": "′" };
const FUNCTION_NAME = /^(?:sin|cos|tan|cot|log|ln|lg|lim|max|min)$/;
export type PlainMathPiece = { text: string; italic?: boolean; script?: "sub" | "super"; underline?: boolean };
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
