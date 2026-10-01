import { AlignmentType, BorderStyle, Document, ImageRun, LineRuleType, Math as WordMath, MathFraction, MathRadical, MathRoundBrackets, MathRun, MathSubScript, MathSuperScript, Packer, Paragraph, Table, TableCell, TableLayoutType, TableRow, TextRun, WidthType, type MathComponent, type ParagraphChild } from "docx";
import JSZip from "jszip";
import { splitMathText } from "./math-text";
import { needsWordMathEquation, normalizeMathNotation } from "./math-notation.mjs";
import { isCompactConclusionQuestion, resolveQuestionImageLayout } from "./question-layout";
import { resolveWordImageSource } from "./word-image-source.mjs";
import { standaloneWordQuestionImages } from "./word-question-images.mjs";
import { enlargeNestedWordMath, ensureWordMathSettings } from "./word-math-sizing.mjs";
import type { Question } from "./types";

const typeOrder = ["单选题", "多选题", "填空题", "判断题", "解答题"];
const typeNames: Record<string, string> = { 单选题: "单项选择题", 多选题: "多项选择题", 填空题: "填空题", 判断题: "判断题", 解答题: "解答题" };
const sectionNumbers = ["一", "二", "三", "四", "五"];
const optionLabels = ["A", "B", "C", "D", "E", "F"];
// Explicit automatic line rules let office renderers grow lines around native
// fractions and inline images instead of clipping them to an ambiguous fixed line.
const BODY_SIZE = 21;
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

type RunStyle = { bold?: boolean; color?: string; italicMath?: boolean };

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
  circ: "°", sim: "∽", backsim: "∽", cong: "≌", perp: "⊥", parallel: "∥", cdots: "⋯", ldots: "…", quad: "　", qquad: "　　",
};
const superscripts: Record<string, string> = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "⁺": "+", "⁻": "−" };

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
      if (["mathrm", "text", "operatorname", "mathbf", "mathit", "textrm"].includes(command)) return group();
      if (command === "sqrt") return [new MathRadical({ children: group() })];
      return [new MathRun(latexSymbols[command] ?? command)];
    }
    const char = text[cursor.index++] ?? "";
    return char ? [new MathRun(char)] : [];
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
        if (["mathrm", "text", "operatorname", "mathbf", "mathit", "textrm"].includes(command)) { result.push(...group()); continue; }
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
      result.push(new MathRun(char)); cursor.index += 1;
    }
    return result;
  }

  const components = sequence();
  return components.length ? components : [new MathRun(source)];
}

function equation(source: string) {
  return new WordMath({ children: mathComponents(source.trim()) });
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

export function richText(text: string, style: RunStyle = {}): ParagraphChild[] {
  return splitMathText(text).flatMap((segment) => segment.kind === "math" && needsWordEquation(segment.value, segment.explicit)
    ? [equation(segment.value)]
    : textRuns(segment.value, BODY_SIZE, { ...style, italicMath: true }));
}

function optionTable(options: string[], compact = false) {
  const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
  const columnCount = options.length <= 4 && options.every((option) => option.length <= 12) ? 4 : 2;
  const cellWidth = Math.floor(9746 / columnCount);
  const rows: TableRow[] = [];
  for (let start = 0; start < options.length; start += columnCount) {
    const cells: TableCell[] = [];
    for (let offset = 0; offset < columnCount; offset += 1) {
      const index = start + offset; const option = options[index];
      cells.push(new TableCell({
        width: { size: cellWidth, type: WidthType.DXA },
        margins: { top: compact ? 0 : 40, bottom: compact ? 40 : 80, left: 180, right: 120 },
        children: [new Paragraph({ spacing: { lineRule: LineRuleType.AUTO, line: compact ? 300 : 360 }, children: option == null ? [] : [...textRuns(`${optionLabels[index]}．`), ...richText(option)] })],
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

async function imageParagraphFromSource(source: string, resolveImage: (source: string) => Promise<ResolvedWordImage>, maxWidth = 300, maxHeight = 210, after = 140, alignment = AlignmentType.CENTER, before = 80): Promise<Paragraph> {
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

export async function buildQuestionsWordBlob(questions: Question[], title: string, includeAnswers: boolean, order: "type" | "basket" = "type") {
  const imageCache = new Map<string, Promise<ResolvedWordImage>>();
  const resolveImage = (source: string) => {
    let pending = imageCache.get(source);
    if (!pending) { pending = resolveWordImageSource(source); imageCache.set(source, pending); }
    return pending;
  };
  const imageParagraph = (source: string, maxWidth = 300, maxHeight = 210, after = 140, alignment = AlignmentType.CENTER, before = 80) =>
    imageParagraphFromSource(source, resolveImage, maxWidth, maxHeight, after, alignment, before);
  const rawParagraphs: Array<{ token: string; xml: string; assets?: Record<string, string>; questionNumber?: number }> = [];
  const children: Array<Paragraph | Table> = [
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { lineRule: LineRuleType.AUTO, after: 240 }, children: textRuns(title, 30, { bold: true }) }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { lineRule: LineRuleType.AUTO, after: 300 }, children: textRuns("姓名：____________　班级：____________　得分：____________") }),
  ];
  let number = 1;
  let sectionIndex = 0;
  const renderedQuestions: Question[] = [];
  const groups = order === "basket" ? [{ type: null, questions }] : typeOrder.map((type) => ({ type, questions: questions.filter((question) => question.type === type) }));
  for (const { type, questions: group } of groups) {
    if (!group.length) continue;
    children.push(new Paragraph({ spacing: { lineRule: LineRuleType.AUTO, before: 180, after: 120 }, children: textRuns(type ? `${sectionNumbers[sectionIndex]}、${typeNames[type]}（共${group.length}题）` : `试题（共${group.length}题）`, BODY_SIZE, { bold: true }) }));
    sectionIndex += 1;
    for (const question of group) {
      renderedQuestions.push(question);
      const source = question.source ? `（${question.source}）` : "";
      const stemParagraphs = (question.stemParagraphs?.length ? question.stemParagraphs : question.stem.split(/\r?\n/)).filter((line) => line.length > 0);
      const compactConclusion = isCompactConclusionQuestion(question);
      const images = standaloneWordQuestionImages(question);
      if (question.stemDocxXml?.length) {
        question.stemDocxXml.forEach((xml, rawIndex) => {
          const token = `__ZHITI_RAW_STEM_${rawParagraphs.length}__`;
          rawParagraphs.push({ token, xml, assets: question.stemDocxAssets, questionNumber: rawIndex === 0 ? number : undefined });
          children.push(new Paragraph({ children: textRuns(token) }));
        });
      } else {
        const stem = new Paragraph({ spacing: { lineRule: LineRuleType.AUTO, after: compactConclusion ? 0 : stemParagraphs.length > 1 ? 40 : 100, line: compactConclusion ? 300 : 360 }, children: [...textRuns(`${number}．`), ...textRuns(source, BODY_SIZE, { color: "2478A8" }), ...richText(stemParagraphs[0] ?? question.stem)] });
        children.push(stem);
        for (const continuation of stemParagraphs.slice(1)) children.push(new Paragraph({ indent: { left: 420 }, spacing: { lineRule: LineRuleType.AUTO, after: compactConclusion ? 0 : 40, line: compactConclusion ? 300 : 360 }, children: richText(continuation) }));
      }
      const imageLayout = resolveQuestionImageLayout(question);
      if (images.length && compactConclusion) {
        for (const image of images) children.push(await imageParagraph(image, 195, 155, 30, AlignmentType.LEFT, 20));
      } else if (images.length && imageLayout === "right") {
        children.push(await imageParagraph(images[0], 220, 165, 80, AlignmentType.RIGHT));
        for (const image of images.slice(1)) children.push(await imageParagraph(image, 280, 195));
      } else if (images.length && imageLayout === "below-right") {
        for (const image of images) children.push(await imageParagraph(image, 300, 210, 140, AlignmentType.RIGHT));
      } else {
        for (const image of images) children.push(await imageParagraph(image, 300, 210));
      }
      if (question.optionsDocxXml?.length) {
        question.optionsDocxXml.forEach((xml) => {
          const token = `__ZHITI_RAW_OPTIONS_${rawParagraphs.length}__`;
          rawParagraphs.push({ token, xml, assets: question.optionsDocxAssets });
          children.push(new Paragraph({ children: textRuns(token) }));
        });
      } else if (question.options.length) {
        children.push(optionTable(question.options, compactConclusion));
        children.push(new Paragraph({ spacing: { lineRule: LineRuleType.AUTO, after: 80 }, children: textRuns("　") }));
      } else {
        const answerLines = question.type === "解答题" ? 5 : 1;
        for (let i = 0; i < answerLines; i += 1) children.push(new Paragraph({ spacing: { lineRule: LineRuleType.AUTO, after: 180 }, children: textRuns("　") }));
      }
      number += 1;
    }
  }
  if (includeAnswers) {
    children.push(new Paragraph({ pageBreakBefore: true, alignment: AlignmentType.CENTER, spacing: { lineRule: LineRuleType.AUTO, after: 240 }, children: textRuns(title, 30, { bold: true }) }));
    children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { lineRule: LineRuleType.AUTO, after: 240 }, children: textRuns("参考答案与试题解析", BODY_SIZE, { bold: true }) }));
    renderedQuestions.forEach((question, index) => {
      children.push(new Paragraph({ spacing: { lineRule: LineRuleType.AUTO, after: 80, line: 360 }, children: [...textRuns(`${index + 1}．答案：`, BODY_SIZE, { bold: true }), ...richText(question.answer || "略", { bold: true })] }));
      if (question.analysis) {
        const originalParagraphs = question.analysis.split(/\r?\n/).filter((line) => line.length > 0);
        if (question.analysisDocxXml?.length) {
          question.analysisDocxXml.forEach((xml) => {
            const token = `__ZHITI_RAW_ANALYSIS_${rawParagraphs.length}__`;
            rawParagraphs.push({ token, xml, assets: question.analysisDocxAssets });
            children.push(new Paragraph({ children: textRuns(token) }));
          });
        } else if (originalParagraphs[0]?.startsWith("【")) {
          originalParagraphs.forEach((line, lineIndex) => children.push(new Paragraph({ spacing: { lineRule: LineRuleType.AUTO, after: lineIndex === originalParagraphs.length - 1 ? 180 : 40, line: 360 }, children: richText(line) })));
        } else {
          children.push(new Paragraph({ spacing: { lineRule: LineRuleType.AUTO, after: 180, line: 360 }, children: [...textRuns("解析："), ...richText(question.analysis)] }));
        }
      }
    });
  }
  const doc = new Document({
    styles: { default: { document: { run: { font: BODY_FONT, size: BODY_SIZE }, paragraph: { spacing: { lineRule: LineRuleType.AUTO, line: 360, after: 0 } } } } },
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
  documentXml = enlargeNestedWordMath(sanitizeXml10(documentXml));
  archive.file("word/document.xml", documentXml);
  const blob = await archive.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  return blob;
}

export async function exportQuestionsToWord(questions: Question[], title: string, includeAnswers: boolean, order: "type" | "basket" = "type") {
  const blob = await buildQuestionsWordBlob(questions, title, includeAnswers, order);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = `${title || "练习题"}.docx`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
