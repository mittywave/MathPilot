import katex from "katex";
import { toLatexMath } from "./math-text";
import { readMathGroup } from "./math-grid";

// A fraction in running text is printed full size, as on exam papers (½ as tall as the line's digits would
// read as a footnote). Display style does that; fractions nested inside still shrink one step on their own.
export function renderKatex(source: string, display = false): { html: string } | { error: string } {
  try {
    const latex = toLatexMath(source);
    // cases resets every cell to text style, even inside a display formula.
    // Use its native display-style counterpart only for formulas with ordinary
    // fractions. Tokenize commands so row breaks and literal text stay intact.
    let literalEnd = 0;
    const environments: string[] = [];
    const webLatex = /\\frac\b/.test(latex) ? latex.replace(/\\(?:begin\s*\{[A-Za-z*]+\}|end\s*\{[A-Za-z*]+\}|[A-Za-z]+|[\s\S])/g, (command, offset) => {
      if (offset < literalEnd) return command;
      if (/^\\(?:text[a-zA-Z]*|operatorname)$/.test(command)) {
        const groupStart = offset + command.length + (latex.slice(offset + command.length).match(/^\s*/)?.[0].length ?? 0);
        if (latex[groupStart] === "{") literalEnd = readMathGroup(latex, groupStart).end;
      } else if (command === "\\verb") {
        const start = offset + command.length + (latex[offset + command.length] === "*" ? 1 : 0);
        const end = latex.indexOf(latex[start], start + 1);
        if (end >= 0) literalEnd = end + 1;
      }
      const environment = /^\\(begin|end)\s*\{([A-Za-z*]+)\}$/.exec(command);
      if (!environment) return command;
      if (environment[1] === "begin") environments.push(environment[2]);
      else if (environments.pop() !== environment[2]) throw new Error("Mismatched math environment");
      return environment[2] === "cases" ? `\\${environment[1]}{dcases}` : command;
    }) : latex;
    return { html: katex.renderToString(!display && /\\frac/.test(webLatex) ? `\\displaystyle ${webLatex}` : webLatex, {
      displayMode: display, throwOnError: true, strict: "ignore", trust: false,
      output: "htmlAndMathml", macros: { "\\parallelogram": "\\text{▱}" },
    }) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "无法解析公式" };
  }
}
