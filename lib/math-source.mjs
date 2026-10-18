import { SUPPORTED_MATH_COMMANDS } from './math-capabilities.mjs';
// Syntax-only recovery. Never solve equations, change signs, infer subscripts,
// or delete ambiguous source. Code examples and LaTeX text arguments are literal.
const knownCommands = new Set([...SUPPORTED_MATH_COMMANDS, 'mathcal', 'mathscr', 'mathfrak']);
const escaped = (text, index) => {
  let n = 0;
  while (index > 0 && text[--index] === '\\') n++;
  return n % 2 === 1;
};
function groupEnd(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (escaped(text, i)) continue;
    if (text[i] === '{') depth++;
    if (text[i] === '}' && --depth === 0) return i + 1;
  }
  return text.length;
}
function literalEnd(text, index) {
  if (text[index] === '`') {
    const marker = text.slice(index).match(/^`+/)[0];
    const end = text.indexOf(marker, index + marker.length);
    return end < 0 ? text.length : end + marker.length;
  }
  const command = text.slice(index).match(/^\\(?:text|textrm|texttt|textnormal|operatorname)\s*(?=\{)/);
  if (command) return groupEnd(text, index + command[0].length);
  const verb = text.slice(index).match(/^\\verb\*?([^A-Za-z\s])/);
  if (verb) {
    const end = text.indexOf(verb[1], index + verb[0].length);
    return end < 0 ? text.length : end + 1;
  }
  return index;
}
function repairCommandEscapes(text) {
  let result = '', depth = 0;
  const explicitRanges = scanMathSource(text).ranges;
  for (let i = 0; i < text.length;) {
    const protectedEnd = literalEnd(text, i);
    if (protectedEnd > i) { result += text.slice(i, protectedEnd); i = protectedEnd; continue; }
    if (text[i] !== '\\') { result += text[i++]; continue; }
    const slashes = text.slice(i).match(/^\\+/)[0];
    const name = text.slice(i + slashes.length).match(/^[A-Za-z]+/)?.[0] || '';
    const environment = text.slice(i + slashes.length + name.length).match(/^\s*\{[A-Za-z*]+\}/);
    // A row break in any environment is meaningful, even when followed by a
    // command-looking identifier (e.g. \\beta). Do not collapse it. Outside
    // explicit math, repeated slashes may be prose/code/path text and must stay literal.
    // The one safe undelimited exception is a duplicated implication arrow
    // immediately following a complete cases/aligned environment.
    const linePrefix = text.slice(text.lastIndexOf('\n', i - 1) + 1, i);
    const isPath = /(?:[A-Za-z]:|https?:|file:)\\[^\n]*$/.test(linePrefix + slashes);
    const followsMathEnvironment = /\\end\{(?:cases|aligned)\}\s*$/.test(result);
    const repair = depth === 0 && slashes.length > 1 && knownCommands.has(name) && !isPath
      && (explicitRanges.some(range => i >= range.start && i < range.end) || (followsMathEnvironment && /^(?:Rightarrow|Leftarrow|Leftrightarrow|Longrightarrow|Longleftarrow|Longleftrightarrow)$/.test(name)));
    result += repair ? '\\' : slashes;
    i += slashes.length;
    if ((slashes.length === 1 || repair) && environment) {
      if (name === 'begin') depth++;
      else if (name === 'end') depth = Math.max(0, depth - 1);
    }
    // Leave the name to the ordinary scanner; this also protects text groups.
  }
  return result;
}
function dollarRuns(text) {
  const result = [];
  for (let i = 0; i < text.length;) {
    const end = literalEnd(text, i);
    if (end > i) { i = end; continue; }
    if (text[i] === '$' && !escaped(text, i)) {
      let j = i + 1; while (text[j] === '$') j++;
      result.push({ start: i, end: j, length: j - i }); i = j;
    } else i++;
  }
  return result;
}
function clearlyMath(body) {
  let visible = '', depth = 0;
  for (let i = 0; i < body.length;) {
    const end = literalEnd(body, i);
    if (end > i) { i = end; continue; }
    if (!escaped(body, i)) {
      if (body[i] === '{') depth++;
      if (body[i] === '}' && --depth < 0) return false;
    }
    visible += body[i++];
  }
  return depth === 0 && /[=^_]|\\(?:frac|dfrac|tfrac|sqrt|mathbb|begin|angle|Rightarrow)\b/.test(visible)
    && !/[\u3400-\u9fff]/.test(visible);
}
function repairDollarPair(text) {
  const runs = dollarRuns(text);
  if (runs.length === 2) {
    const [a, b] = runs, body = text.slice(a.end, b.start);
    if ((a.length !== b.length || a.length > 2) && clearlyMath(body)) {
      const delimiter = a.length === 1 ? '$' : '$$';
      return text.slice(0, a.start) + delimiter + body + delimiter + text.slice(b.end);
    }
  }
  if (runs.length === 1) {
    const a = runs[0];
    if (a.length <= 2 && !text.slice(0, a.start).trim() && clearlyMath(text.slice(a.end))) {
      return text + '$'.repeat(a.length);
    }
  }
  return text;
}
// Some OCR responses start an inline proof with $$, then continue with $A$,
// prose and $B$. Only demote the boundary markers of a self-contained line
// when every resulting inline span is balanced and contains no bare prose.
function repairMixedDollarLine(line) {
  const runs = dollarRuns(line);
  if (runs.length < 4 || runs.length % 2 || runs[0].length !== 2
    || line.slice(0, runs[0].start).trim()
    || runs.slice(1, -1).some(run => run.length !== 1)
    || ![1, 2].includes(runs.at(-1).length)) return line;
  const first = runs[0], last = runs.at(-1);
  const candidate = line.slice(0, first.start) + '$' + line.slice(first.end, last.start) + '$' + line.slice(last.end);
  const { ranges, issues } = scanMathSource(candidate);
  if (issues.length || ranges.length !== runs.length / 2
    || !/\\[A-Za-z]+|[=^_]/.test(ranges[0].value)) return line;
  for (const range of ranges) {
    let depth = 0;
    for (let i = 0; i < range.value.length;) {
      const end = literalEnd(range.value, i);
      if (end > i) { i = end; continue; }
      const ch = range.value[i];
      if (/[\u3400-\u9fff]/.test(ch)) return line;
      if (!escaped(range.value, i)) {
        if (ch === '{') depth++;
        if (ch === '}' && --depth < 0) return line;
      }
      i++;
    }
    if (depth) return line;
  }
  return candidate;
}
export function repairMathSource(source) {
  const escapedText = repairCommandEscapes(source), literals = [];
  for (let i = 0; i < escapedText.length;) {
    const end = literalEnd(escapedText, i);
    if (end > i) { literals.push({start:i,end}); i = end; } else i++;
  }
  let offset = 0;
  const text = escapedText.split(/(\r?\n)/).map(line => {
    const protectedLine = literals.some(range => offset > range.start && offset < range.end);
    offset += line.length;
    return protectedLine ? line : repairMixedDollarLine(line);
  }).join('');
  // Repair a mismatched pair spanning an entire field first. If there are
  // several expressions, only repair isolated, self-contained physical lines.
  const runs = dollarRuns(text);
  if (runs.length <= 2) return repairDollarPair(text);
  return text.split(/(\r?\n)/).map(line => /\r?\n/.test(line) ? line : (
    dollarRuns(line).length === 2 ? repairDollarPair(line) : line
  )).join('');
}

// OCR may leave JSON newline escapes in prose. Reuse the source scanner's
// literal/formula boundaries so recovery cannot alter LaTeX, code or paths.
// A lowercase letter after \n may begin a command (\neq, \newcommand), so it stays.
// An uppercase one starts the next line (\nA. 选项), unless the escape is a
// negated command such as \nRightarrow.
const proseNewline = /^\\(?:r\\n|n)(?![a-z])([A-Z][A-Za-z]*)?/;
export function normalizeProseLineBreaks(text) {
  if (!/\\(?:r\\n|n)(?![a-z])/.test(text)) return text;
  const ranges = scanMathSource(text).ranges;
  let result = '', rangeIndex = 0;
  for (let i = 0; i < text.length;) {
    if (ranges[rangeIndex]?.start === i) {
      const range = ranges[rangeIndex++];
      result += text.slice(i, range.end); i = range.end; continue;
    }
    const protectedEnd = literalEnd(text, i);
    if (protectedEnd > i) { result += text.slice(i, protectedEnd); i = protectedEnd; continue; }
    const newline = text.slice(i).match(proseNewline);
    if (newline && !escaped(text, i) && !knownCommands.has(newline[1] ?? '')) {
      const linePrefix = text.slice(text.lastIndexOf('\n', i - 1) + 1, i);
      if (!/(?:[A-Za-z]:|https?:|file:)\\[^\s]*$/.test(linePrefix + '\\')) {
        result += '\n'; i += newline[0].length - (newline[1]?.length ?? 0); continue;
      }
    }
    result += text[i++];
  }
  return result;
}

// \b \f \t \r \n are JSON escapes, so a LaTeX command a model wrote with one
// backslash decodes to a control character plus the rest of its name:
// \therefore becomes a tab and "herefore", shown in place of ∴. Put known
// commands back; leave anything else visible. Backspace and form feed are
// never text, so anywhere; a tab or carriage return only inside a formula. A
// line feed may be a real line break even there: only after content on its
// line, and \ne (not e^x) only in an inline formula.
const jsonEscapeLetters = { '\b': 'b', '\f': 'f', '\t': 't', '\r': 'r', '\n': 'n' };
function restoreEscapes(text, pattern, keep = () => false) {
  return text.replace(pattern, (match, slashes, control, letters, offset) => {
    const name = jsonEscapeLetters[control] + letters;
    if (!knownCommands.has(name) || keep(control, name, offset + slashes.length)) return match;
    // An odd backslash before the character was half of an escaped backslash.
    return `${slashes.slice(slashes.length % 2)}\\${name}`;
  });
}
export function restoreDecodedCommands(text) {
  text = restoreEscapes(text, /(\\*)([\b\f])([A-Za-z]+)/g);
  if (!/[\t\r\n][A-Za-z]/.test(text)) return text;
  let result = '', cursor = 0;
  for (const { start, end, value, display } of scanMathSource(text).ranges) {
    const marker = text[start] === '$' ? (display ? 2 : 1) : 2;
    const body = restoreEscapes(value, /(\\*)([\t\r\n])([A-Za-z]+)/g, (control, name, at) => control === '\n'
      && (!/[^\s\\]\s*$/.test(value.slice(0, at).split('\n').pop()) || name === 'ne' && (display || /^[\^_]/.test(value.slice(at + 2)))));
    result += text.slice(cursor, start + marker) + body + text.slice(end - marker, end);
    cursor = end;
  }
  return result + text.slice(cursor);
}

/** Shared delimiter scanner for rendering, export layout and diagnostics. */
export function scanMathSource(text) {
  const ranges = [], issues = [];
  for (let i = 0; i < text.length;) {
    const protectedEnd = literalEnd(text, i);
    if (protectedEnd > i) { i = protectedEnd; continue; }
    if (escaped(text, i)) { i++; continue; }
    let open = '', close = '', display = false;
    if (text.startsWith('$$', i)) { open = close = '$$'; display = true; }
    else if (text[i] === '$') { open = close = '$'; }
    else if (text.startsWith('\\[', i)) { open = '\\['; close = '\\]'; display = true; }
    else if (text.startsWith('\\(', i)) { open = '\\('; close = '\\)'; }
    if (!open) { i++; continue; }
    const start = i, contentStart = i + open.length;
    let end = contentStart;
    while (end < text.length) {
      const literal = literalEnd(text, end);
      if (literal > end) { end = literal; continue; }
      if (!escaped(text, end) && text.startsWith(close, end)) break;
      end++;
    }
    if (end === text.length) {
      // Ordinary currency is not an unterminated mathematical expression.
      const tail = text.slice(contentStart).split(/\r?\n/)[0];
      if (open !== '$' || !/^\d+(?:\.\d+)?(?:\s|$)/.test(tail) || clearlyMath(tail)) {
        issues.push({ offset: start, message: 'Math delimiter is not closed' });
      }
      i = contentStart; continue;
    }
    const value = text.slice(contentStart, end);
    ranges.push({ start, end: end + close.length, value, display });
    if (!value.trim() || dollarRuns(value).length) issues.push({ offset: start, message: 'Ambiguous math dollar markers' });
    i = end + close.length;
  }
  return { ranges, issues };
}

/** Physical newlines inside a formula are never paragraph boundaries. */
export function splitMathParagraphs(text) {
  const ranges = scanMathSource(text).ranges, lines = [];
  let cursor = 0, buffer = '';
  const appendText = value => {
    const parts = value.split(/\r?\n/);
    parts.forEach((part, index) => { if (index) { lines.push(buffer); buffer = ''; } buffer += part; });
  };
  for (const range of ranges) {
    appendText(text.slice(cursor, range.start));
    const raw = text.slice(range.start, range.end);
    if (range.display) {
      if (buffer.trim()) lines.push(buffer);
      buffer = ''; lines.push(raw);
    } else buffer += raw;
    cursor = range.end;
  }
  appendText(text.slice(cursor));
  if (buffer || !lines.length) lines.push(buffer);
  return lines;
}
