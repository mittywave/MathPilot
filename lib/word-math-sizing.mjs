const WORD_MATH_PROPERTIES = `<m:mathPr><m:mathFont m:val="Cambria Math"/><m:brkBin m:val="before"/><m:brkBinSub m:val="--"/><m:smallFrac m:val="off"/><m:dispDef/><m:lMargin m:val="0"/><m:rMargin m:val="0"/><m:defJc m:val="centerGroup"/><m:wrapIndent m:val="1440"/><m:intLim m:val="subSup"/><m:naryLim m:val="undOvr"/></m:mathPr>`;

export function ensureWordMathSettings(settingsXml) {
  if (/<m:mathPr\b/.test(settingsXml)) {
    if (/<m:smallFrac\b/.test(settingsXml)) return settingsXml.replace(/<m:smallFrac\b[^>]*\/?\s*>/, '<m:smallFrac m:val="off"/>');
    return settingsXml.replace(/<\/m:mathPr>/, '<m:smallFrac m:val="off"/></m:mathPr>');
  }
  return settingsXml.replace(/<\/w:settings>/, `${WORD_MATH_PROPERTIES}</w:settings>`);
}

export function wordMathFractionDepth(equationXml) {
  let depth = 0; let maximum = 0;
  for (const match of equationXml.matchAll(/<\/?m:f(?:\s[^>]*)?>/g)) {
    if (match[0].startsWith("</")) depth = Math.max(0, depth - 1);
    else { depth += 1; maximum = Math.max(maximum, depth); }
  }
  return maximum;
}

// Word sets a fraction inside an inline equation at reduced size, so ½ next to body digits reads like a footnote.
// The numerator and denominator of a fraction at the top of an inline equation are therefore set one size up
// (14 pt against the 10.5 pt body), as 菁优网's own Word papers do; Word's reduction brings them back to body size.
// Nested fractions keep Word's own step down, display equations are left alone, and a size an imported Word file
// already set is kept.
const FRACTION_PART_SIZE = 28;

export function fullSizeInlineFractions(documentXml) {
  return documentXml.replace(/<m:oMathPara\b[\s\S]*?<\/m:oMathPara>|<m:oMath\b[^>]*>[\s\S]*?<\/m:oMath>/g, (math) => {
    if (math.startsWith("<m:oMathPara")) return math;
    let depth = 0;
    return math.replace(/<\/?m:f(?:\s[^>]*)?>|<m:r>((?:(?!<\/m:r>)[\s\S])*?)<\/m:r>/g, (tag, inner) => {
      if (inner === undefined) { depth += tag.startsWith("</") ? -1 : 1; return tag; }
      if (depth !== 1 || /<w:sz\b/.test(inner)) return tag;
      const size = `<w:sz w:val="${FRACTION_PART_SIZE}"/><w:szCs w:val="${FRACTION_PART_SIZE}"/>`;
      if (/<w:rPr>/.test(inner)) return `<m:r>${inner.replace("</w:rPr>", `${size}</w:rPr>`)}</m:r>`;
      const mathProperties = inner.match(/^<m:rPr>(?:(?!<\/m:rPr>)[\s\S])*<\/m:rPr>/)?.[0] ?? "";
      return `<m:r>${mathProperties}<w:rPr>${size}</w:rPr>${inner.slice(mathProperties.length)}</m:r>`;
    });
  });
}
