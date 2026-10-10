export const UNDERLINE_OPEN = "\uE100";
export const UNDERLINE_CLOSE = "\uE101";

export function markDocxUnderline(value) {
  const content = value.trim()
    ? value
    : "\u00a0".repeat(Math.min(16, Math.max(4, value.length)));
  return `${UNDERLINE_OPEN}${content}${UNDERLINE_CLOSE}`;
}

export function splitDisplayUnderlines(value) {
  const segments = [];
  let cursor = 0;
  while (cursor < value.length) {
    const start = value.indexOf(UNDERLINE_OPEN, cursor);
    if (start < 0) {
      if (cursor < value.length) segments.push({ underlined: false, value: value.slice(cursor) });
      break;
    }
    if (start > cursor) segments.push({ underlined: false, value: value.slice(cursor, start) });
    const end = value.indexOf(UNDERLINE_CLOSE, start + UNDERLINE_OPEN.length);
    if (end < 0) {
      segments.push({ underlined: false, value: value.slice(start) });
      break;
    }
    segments.push({ underlined: true, value: value.slice(start + UNDERLINE_OPEN.length, end) });
    cursor = end + UNDERLINE_CLOSE.length;
  }
  return segments.length ? segments : [{ underlined: false, value }];
}

export function isCompactConclusionChoice({ type, stem, imageCount, optionCount }) {
  if (!["单选题", "多选题"].includes(type) || imageCount !== 1 || optionCount < 2) return false;
  const lines = stem.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const conclusions = lines.filter((line) => /^[①②③④⑤⑥]/.test(line));
  if (conclusions.length < 3 || conclusions.length > 6) return false;
  return conclusions.every((line) => line.length <= 72) && stem.length <= 360;
}

export function automaticQuestionImageLayout({ imageCount, stemLength, paragraphCount, type = "", stem = "", optionCount = 0 }) {
  if (imageCount < 1) return null;
  if (isCompactConclusionChoice({ type, stem, imageCount, optionCount })) return "below";
  if (imageCount > 1 || paragraphCount >= 8 || stemLength >= 700) return "below";
  if (paragraphCount >= 3 || stemLength >= 260) return "below-right";
  return null;
}

export function shouldUseBelowLayout(input) {
  return automaticQuestionImageLayout(input) != null;
}

// Four options share a line only when each fits in a quarter of it; otherwise two per line, as printed papers do.
// Chinese characters count 1, Latin letters and digits ½, formula markup nothing.
export function optionColumnCount(options) {
  const width = (option) => [...option.replace(/\\[A-Za-z]+|[$^_{}\s]/g, "")].reduce((sum, char) => sum + (/[\u3000-\u9fff\uff00-\uffef]/.test(char) ? 1 : .5), 0);
  return options.length <= 4 && options.every((option) => width(option) <= 8) ? 4 : 2;
}
