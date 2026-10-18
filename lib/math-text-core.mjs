import { scanMathSource, normalizeProseLineBreaks, restoreDecodedCommands } from "./math-source.mjs";
import { normalizeMathNotation } from "./math-notation.mjs";
export { normalizeMathNotation } from "./math-notation.mjs";

// Explicit delimiters are authoritative. Automatic detection is retained only
// for older, already-saved OCR/plain-text questions; it never rewrites storage.
const mathChunkPattern = /[A-Za-z0-9√∠△∑∫π∞∴∵±∓−＋－+\-×÷＝=<>＜＞≤≥≠≈≌^_²³⁴⁵⁶⁷⁸⁹⁰¹⁻⁺/()[\]（）°\s\\{}]+/g;
const formulaSignal = /[\\√∠△∑∫π∞∴∵±∓−＋－+\-×÷＝=<>＜＞≤≥≠≈≌^_²³⁴⁵⁶⁷⁸⁹⁰¹⁻⁺/]/;
const standaloneMathIdentifier = /^(?:[A-Z]{1,4}|[a-z])$/;
const superDigits = { "⁰":"0", "¹":"1", "²":"2", "³":"3", "⁴":"4", "⁵":"5", "⁶":"6", "⁷":"7", "⁸":"8", "⁹":"9", "⁺":"+", "⁻":"-" };
// Shared scanner also powers export diagnostics and paragraph boundaries.
function explicitRanges(text) { return scanMathSource(text).ranges; }

function appendAutomaticCore(segments, value) {
  if (value) segments.push({ kind: formulaSignal.test(value) || standaloneMathIdentifier.test(value) ? "math" : "text", value });
}
function unmatchedParentheses(value) {
  const open = [], unmatched = [];
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "(" || value[index] === "（") open.push(index);
    else if (value[index] === ")" || value[index] === "）") {
      if (open.length) open.pop(); else unmatched.push(index);
    }
  }
  return [...unmatched, ...open].sort((a, b) => a - b);
}
function appendAutomaticPiece(segments, piece) {
  const leading = piece.match(/^\s*/)?.[0] ?? "", trailing = piece.match(/\s*$/)?.[0] ?? "";
  const core = piece.trim();
  if (!core) { segments.push({ kind: "text", value: piece }); return; }
  if (leading) segments.push({ kind: "text", value: leading });
  const boundaries = unmatchedParentheses(core);
  if (!boundaries.length) appendAutomaticCore(segments, core);
  else {
    let cursor = 0;
    for (const index of boundaries) {
      appendAutomaticCore(segments, core.slice(cursor, index));
      segments.push({ kind: "text", value: core[index] }); cursor = index + 1;
    }
    appendAutomaticCore(segments, core.slice(cursor));
  }
  if (trailing) segments.push({ kind: "text", value: trailing });
}
function splitAutomatic(text) {
  if (/\r?\n/.test(text)) {
    return text.split(/(\r?\n)/).filter(Boolean).flatMap(line => /^(?:\r?\n)$/.test(line)
      ? [{ kind: "text", value: line }]
      : splitAutomatic(line));
  }
  // Preserve undelimited legacy LaTeX, including Chinese text inside braces.
  // Never merge separate lines into a single math expression.
  if (/\\[A-Za-z]+/.test(text)) {
    return text.split(/(\r?\n)/).filter(Boolean).flatMap(line => /\\[A-Za-z]+/.test(line)
      ? [{ kind: "math", value: line, explicit: true, display: false }]
      : splitAutomatic(line));
  }
  const segments = [];
  let cursor = 0;
  for (const match of text.matchAll(mathChunkPattern)) {
    const start = match.index ?? 0;
    if (start > cursor) segments.push({ kind: "text", value: text.slice(cursor, start) });
    for (const piece of match[0].split(/(_{2,})/).filter(Boolean)) {
      if (/^_{2,}$/.test(piece)) segments.push({ kind: "text", value: piece });
      else appendAutomaticPiece(segments, piece);
    }
    cursor = start + match[0].length;
  }
  if (cursor < text.length) segments.push({ kind: "text", value: text.slice(cursor) });
  return segments;
}

export function splitMathText(text, { autoDetect = true } = {}) {
  // Saved model output may predate the repair at parse time; it is fixed here, never in storage.
  text = restoreDecodedCommands(text);
  if (autoDetect) text = normalizeProseLineBreaks(text);
  const segments = [];
  const appendText = value => {
    if (!value) return;
    // Escaped currency must not be reinterpreted by the legacy detector.
    for (const piece of value.split(/(\\\$)/).filter(Boolean)) {
      if (piece === "\\$") segments.push({ kind: "text", value: "$" });
      else segments.push(...(autoDetect ? splitAutomatic(piece) : [{ kind: "text", value: piece }]));
    }
  };
  let cursor = 0;
  for (const range of explicitRanges(text)) {
    appendText(text.slice(cursor, range.start));
    segments.push({ kind: "math", value: range.value, explicit: true, display: range.display });
    cursor = range.end;
  }
  appendText(text.slice(cursor));
  return segments.filter(segment => segment.value.length > 0);
}

// Return original text lines, but never split *inside* an explicit formula.
// Browser paragraph layout uses this helper; export callers can opt in too.
export function splitMathLines(text) {
  text = normalizeProseLineBreaks(text);
  const lines = [];
  const ranges = explicitRanges(text);
  let start = 0, rangeIndex = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (ranges[rangeIndex]?.start === index) {
      index = ranges[rangeIndex++].end - 1;
      continue;
    }
    if (text[index] === "\n") {
      lines.push(text.slice(start, index).replace(/\r$/, "")); start = index + 1;
    }
  }
  lines.push(text.slice(start));
  return lines;
}

export function isStandaloneMathLine(text) {
  const segments = splitMathText(text).filter(segment => segment.value.trim().length > 0);
  const onlyMath = segments.some(segment => segment.kind === "math")
    && segments.every(segment => segment.kind === "math" || /^[\s,，.。;；:：!?！？]+$/.test(segment.value));
  if (!onlyMath) return false;
  // A formula the source wrote inline ($…$) stays in the running text, e.g. a list "$+6$, $0.75$, $\frac{24}{5}$".
  if (/\$/.test(text) && segments.some(segment => segment.kind === "math" && segment.explicit && !segment.display)) return false;
  const knownFunctions = new Set(["sin","cos","tan","cot","sec","csc","log","exp","lim","max","min","gcd","lcm"]);
  const words = segments.filter(segment => segment.kind === "math" && !segment.explicit).map(segment => segment.value).join(" ").match(/[A-Za-z]+/g) ?? [];
  return words.every(word => knownFunctions.has(word.toLowerCase()) || !/^[A-Z][a-z]+$/.test(word) && word.length <= 3);
}
export function plainTextWebLines(text, options = {}) {
  return splitMathLines(text).map((rawLine, index) => {
    const value = options.stripLeadingQuestionNumber && index === 0 ? rawLine.replace(/^\s*\d{1,3}[.．、]\s*/, "") : rawLine;
    return { value, align: isStandaloneMathLine(value) ? "center" : "left" };
  });
}

export function latexFractionDepth(source) {
  const latex = normalizeMathNotation(source).replace(/\*\*/g, "^");
  function skipWhitespace(index) { while (/\s/.test(latex[index] ?? "")) index += 1; return index; }
  function commandAt(index) {
    const name = latex.slice(index + 1).match(/^[A-Za-z]+/)?.[0] ?? latex[index + 1] ?? "";
    return { name, next: index + 1 + name.length };
  }
  function argumentAt(index) {
    const start = skipWhitespace(index);
    if (latex[start] === "{") return rangeAt(start + 1, "}");
    if (latex[start] === "\\") {
      const command = commandAt(start);
      if (["frac", "dfrac", "tfrac"].includes(command.name)) return fractionAt(command.next);
      return { depth: 0, next: command.next };
    }
    return { depth: 0, next: Math.min(latex.length, start + 1) };
  }
  function fractionAt(index) {
    const numerator = argumentAt(index), denominator = argumentAt(numerator.next);
    return { depth: 1 + Math.max(numerator.depth, denominator.depth), next: denominator.next };
  }
  function rangeAt(index, end) {
    let depth = 0;
    while (index < latex.length) {
      if (end && latex[index] === end) return { depth, next: index + 1 };
      if (latex[index] === "{") {
        const group = rangeAt(index + 1, "}"); depth = Math.max(depth, group.depth); index = group.next; continue;
      }
      if (latex[index] === "\\") {
        const command = commandAt(index);
        if (["frac", "dfrac", "tfrac"].includes(command.name)) {
          const fraction = fractionAt(command.next); depth = Math.max(depth, fraction.depth); index = fraction.next; continue;
        }
        index = command.next; continue;
      }
      index += 1;
    }
    return { depth, next: index };
  }
  return rangeAt(0).depth;
}

// Compatibility helpers retained for external imports. They do not change size.
export function fractionSizeClass(source) {
  const depth = latexFractionDepth(source);
  return depth >= 3 ? "math-fraction-deep" : depth >= 2 ? "math-fraction-nested" : "";
}
export function toLatexMath(source) {
  let latex = normalizeMathNotation(source).trim().replace(/\*\*/g, "^");
  latex = latex.replace(/(?<!\\)%/g, "\\%");
  latex = latex.replace(/([⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻]+)/g, value => `^{${[...value].map(char => superDigits[char] ?? char).join("")}}`);
  latex = latex.replace(/√\s*（([^（）]+)）/g, "\\sqrt{$1}").replace(/√\s*\(([^()]+)\)/g, "\\sqrt{$1}").replace(/√\s*([A-Za-z0-9.]+)/g, "\\sqrt{$1}");
  const replacements = [
    [/（/g,"("],[/）/g,")"],[/＝/g,"="],[/＋/g,"+"],[/[−－]/g,"-"],[/＜/g,"<"],[/＞/g,">"],[/×/g,"\\times "],[/÷/g,"\\div "],
    [/≤/g,"\\le "],[/≥/g,"\\ge "],[/≠/g,"\\ne "],[/≈/g,"\\approx "],[/±/g,"\\pm "],[/∓/g,"\\mp "],
    [/∠/g,"\\angle "],[/△/g,"\\triangle "],[/π/g,"\\pi "],[/∞/g,"\\infty "],[/∴/g,"\\therefore "],[/∵/g,"\\because "],[/°/g,"^{\\circ}"],
  ];
  for (const [pattern, value] of replacements) latex = latex.replace(pattern, value);
  return latex;
}
export function toReadableNestedFractionLatex(source) {
  // Let inline/display math style determine fraction sizing. Never upgrade
  // every fraction in a formula merely because one of them is nested.
  return toLatexMath(source);
}
