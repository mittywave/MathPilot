const OPTION_LABEL = /([A-F])[.．、]\s*/g;

export function isDocxOptionBlock(value) {
  if (typeof value !== "string") return false;
  const match = OPTION_LABEL.exec(value);
  OPTION_LABEL.lastIndex = 0;
  return Boolean(match && value.slice(0, match.index).trim() === "");
}

export function splitDocxOptionBlocks(values) {
  const found = new Map();
  for (const value of values) {
    if (!isDocxOptionBlock(value)) continue;
    const matches = Array.from(value.matchAll(OPTION_LABEL));
    for (let index = 0; index < matches.length; index += 1) {
      const label = matches[index][1];
      const start = (matches[index].index ?? 0) + matches[index][0].length;
      const end = matches[index + 1]?.index ?? value.length;
      const option = value.slice(start, end).trim();
      // An image-only option still occupies its letter; later text must not slide into its slot.
      if (!found.has(label)) found.set(label, option);
    }
  }
  return ["A", "B", "C", "D", "E", "F"].flatMap((label) => found.has(label) ? [found.get(label)] : []);
}

// Numeric lists inside a solution (0、4、8、…) continue that solution, not a new question.
export function docxNumberedQuestion(text) {
  if (/^\s*\d+(?:\s*、\s*\d+){2}/.test(text)) return null;
  const match = text.match(/^\s*(?:[（(【]\s*((?:单|多)(?:项)?选(?:择)?(?:题)?)\s*[）)】]\s*)?(\d{1,3})(?:[．、]|\.(?!\d))\s*([\s\S]*)$/);
  return match ? { number: match[2], stem: match[3].trim(), ...(match[1] ? { type: match[1].startsWith("多") ? "多选题" : "单选题" } : {}) } : null;
}

export function normalizedDocxPageLookup(value) {
  return String(value ?? "")
    .replace(/\$[^$]*\$/g, "")
    .replace(/[\s\u3000，。；：,.!?！？（）()【】“”‘’．、]/g, "");
}

const BOLD_RUN = /<w:b(?:\s+w:val="(?:1|true|on)")?\s*\/>/;
const NOT_A_LINE = /<m:oMath|<w:drawing|<w:pict|<w:tbl/;

// Every run that carries text is bold.
function boldOnly(xml) {
  const runs = Array.from(xml.matchAll(/<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g), (match) => match[1]).filter((body) => /<w:t\b/.test(body));
  return runs.length > 0 && runs.every((body) => BOLD_RUN.test(body.match(/<w:rPr\b[^>]*>[\s\S]*?<\/w:rPr>/)?.[0] ?? ""));
}

// 讲义 put each question under a short bold line naming its section and number, the stem in the paragraphs
// after it: “例题精练 1”“知识拼接2 1”“例题 6-1” (文件转录 exports Word this way).
export function docxQuestionHeading(text, xml) {
  const value = String(text ?? "").trim();
  if (!value || value.length > 24 || NOT_A_LINE.test(xml) || !boldOnly(xml)) return null;
  const match = value.match(/^(.{2,20}?)\s*(\d{1,3}(?:[-－–]\d{1,3})?)$/u);
  if (!match) return null;
  const label = match[1].trim();
  if ((label.match(/[㐀-鿿]/gu) ?? []).length < 2 || /[，。；：:,.!?！？、]$/u.test(label)) return null;
  return { label, number: match[2] };
}

// A short bold line without a number, such as a lesson title (“五心综合”), ends the question above it.
export function docxTitleLine(text, xml) {
  const value = String(text ?? "").trim();
  return Boolean(value) && value.length <= 24 && !/[，。；：:,.!?！？]$/u.test(value) && !NOT_A_LINE.test(xml) && boldOnly(xml) && !docxQuestionHeading(value, xml);
}

// Without a 题型 section heading the type comes from the content: options make a choice question,
// blanks (underscores or underlined spaces) a fill-in, anything else a worked problem.
export function docxInferredQuestionType(blocks, optionCount) {
  if (optionCount >= 2) return "单选题";
  const blank = blocks.some(({ text, xml }) => /_{3,}|＿{2,}/.test(text)
    || /<w:u w:val="(?!none)[^"]*"\/>(?:(?!<\/w:r>)[\s\S])*?<w:t[^>]*>[\s\u3000]+<\/w:t>/.test(xml));
  return blank ? "填空题" : "解答题";
}

// 文件转录 writes the teacher's solution in its StudioAnswer styles, and red “转录提示”“格式问题” notes.
export function docxStudioRole(text, xml) {
  if (/^(?:转录提示|格式问题)[：:]/u.test(String(text ?? "").trim())) return "warning";
  return /<w:pStyle w:val="Studio(?:Math)?Answer"\/>/.test(xml) ? "analysis" : null;
}

const EMU = { pt: 12700, in: 914400, cm: 360000, mm: 36000, px: 9525 };
function vmlLength(style, name) {
  const match = style.match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([\\d.]+)\\s*(pt|in|cm|mm|px)?`, "i"));
  return match ? Math.round(Number(match[1]) * EMU[(match[2] ?? "px").toLowerCase()]) : 0;
}

// Old-style VML pictures (<w:pict> with v:imagedata) become ordinary inline DrawingML pictures, the form the
// web cards, Word export, handout PDF and the Word page renderer all read. Shapes or labels drawn over the
// picture cannot come along; overlays counts the pictures that had them.
export function docxVmlPicturesToDrawing(xml, firstId = 1) {
  let pictures = 0, overlays = 0;
  const converted = xml.replace(/<w:pict\b[^>]*>([\s\S]*?)<\/w:pict>/g, (whole, body) => {
    const id = body.match(/<v:imagedata\b[^>]*\br:id="([^"]+)"/)?.[1];
    if (!id) return whole;
    const style = body.match(/<v:(?:group|shape|rect|roundrect)\b[^>]*\bstyle="([^"]*)"/)?.[1] ?? "";
    const cx = vmlLength(style, "width") || 2540000, cy = vmlLength(style, "height") || 1905000;
    if ((body.match(/<v:(?:line|oval|polyline|arc|curve|rect|roundrect|shape|textbox)\b/g) ?? []).length > 1) overlays += 1;
    const docId = firstId + pictures; pictures += 1;
    return `<w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${docId}" name="Picture ${docId}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${docId}" name="Picture ${docId}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
  });
  return { xml: converted, pictures, overlays };
}

// MathPilot prints a question's ID beside its number (“3．ID 1322 如图…”). Read back, the ID names the question and is
// not part of its stem: returns the ID, and the paragraph's text and XML without it, or null when there is none.
// The ID is cut from the paragraph's text runs however Word split them; a run it leaves empty goes too.
export function docxPrintedQuestionId(text, xml) {
  const pattern = /^(\s*\d{1,3}(?:[．、]|\.(?!\d))\s*)(ID\s?(\d{4,7})\s*)/;
  const match = String(text ?? "").match(pattern);
  if (!match) return null;
  const runs = Array.from(String(xml).matchAll(/<w:t\b[^>]*>([^<]*)<\/w:t>/g));
  const inRuns = runs.map((run) => run[1]).join("").match(pattern);
  let cleaned = String(xml);
  if (inRuns) {
    let from = inRuns[1].length, to = from + inRuns[2].length, offset = 0;
    cleaned = cleaned.replace(/(<w:t\b[^>]*>)([^<]*)(<\/w:t>)/g, (whole, open, value, close) => {
      const start = offset; offset += value.length;
      if (offset <= from || start >= to) return whole;
      return `${open}${value.slice(0, Math.max(0, from - start))}${value.slice(Math.max(0, to - start))}${close}`;
    }).replace(/<w:r\b[^>]*>(?:\s*<w:rPr\b[^>]*(?:\/>|>(?:(?!<\/?w:r\b)[\s\S])*?<\/w:rPr>))?\s*<w:t\b[^>]*><\/w:t>\s*<\/w:r>/g, "");
  }
  return { id: String(Number(match[3])), text: String(text).replace(pattern, "$1"), xml: cleaned };
}
