import katex from "katex";
import { toLatexMath } from "./math-text";

// A fraction in running text is printed full size, as on exam papers (½ as tall as the line's digits would
// read as a footnote). Display style does that; fractions nested inside still shrink one step on their own.
export function renderKatex(source: string, display = false): { html: string } | { error: string } {
  try {
    const latex = toLatexMath(source);
    return { html: katex.renderToString(!display && /\\frac/.test(latex) ? `\\displaystyle ${latex}` : latex, {
      displayMode: display, throwOnError: true, strict: "ignore", trust: false,
      output: "htmlAndMathml", macros: { "\\parallelogram": "\\text{▱}" },
    }) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "无法解析公式" };
  }
}
