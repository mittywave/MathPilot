export function normalizeMathNotation(source) {
  // In Chinese math texts the area of a triangle is often recognized as
  // "S△ABC". The whole triangle name is the semantic subscript of S.
  return source
    // OCR may draw the parallel sign with two kerned slashes. JSON can also
    // decode the leading \n of negmedspace as a newline; both spell the same sign.
    .replace(/\\math(?:bin|rel)\{\s*\/\s*(?:\\mkern\s*-\d+(?:\.\d+)?mu|\\neg(?:thin|med|thick)space|\n\s*egmedspace)\s*\/\s*\}/g, "\\parallel ")
    .replace(/S\s*[△Δ]\s*([A-Z]{3,8})/g, "S_{△$1}")
    // OCR occasionally wraps the radical glyph in text{} and leaves its
    // argument outside the group. Normalize this to a real sqrt command.
    .replace(/\\(?:text|textrm)\{\s*√\s*\}\s*(?=\{)/g, "\\sqrt")
    // In Chinese geometry worksheets, □ followed by four capital point
    // labels denotes a parallelogram (for example □ABCD). Restrict this to
    // that point-name shape so ordinary boxes remain unchanged.
    .replace(/(?:□|\\square)\s*([A-Z]{4})\b/g, "\\parallelogram $1");
}

export function needsWordMathEquation(value, explicit = false) {
  if (explicit) return true;
  const normalized = normalizeMathNotation(value);
  if (normalized !== value || /[\\√∑∫^_²³⁴⁵⁶⁷⁸⁹⁰¹⁻⁺/]/.test(normalized)) return true;
  if (/[=＝<>＜＞≤≥≠≈]/.test(normalized)) return true;
  return (normalized.match(/[+＋\-−－×÷=＝]/g)?.length ?? 0) >= 2;
}
