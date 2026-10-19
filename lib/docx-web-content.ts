import { XMLParser } from "fast-xml-parser";

type XmlAttributes = Record<string, string>;
type XmlEntry = Record<string, unknown> & { ":@"?: XmlAttributes };

export type DocxWebInline =
  | { type: "text"; value: string; bold?: boolean; italic?: boolean; underline?: boolean; vertical?: "sup" | "sub" }
  | { type: "math"; latex: string }
  | { type: "image"; id: string; width: number; height: number }
  | { type: "tab" }
  | { type: "break" };

export type DocxWebParagraph = {
  type: "paragraph";
  inlines: DocxWebInline[];
  align: "left" | "center" | "right";
};

export type DocxWebTableCell = {
  blocks: DocxWebBlock[];
  colSpan: number;
  rowSpan: number;
};

export type DocxWebTable = {
  type: "table";
  rows: DocxWebTableCell[][];
};

export type DocxWebBlock = DocxWebParagraph | DocxWebTable;
export type DocxWebContent = { blocks: DocxWebBlock[] };
export type DocxWebOption = { label: string; inlines: DocxWebInline[] };

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  preserveOrder: true,
  trimValues: false,
  parseTagValue: false,
});

const propertyNodes = new Set([
  "accPr", "barPr", "borderBoxPr", "ctrlPr", "dPr", "fPr", "funcPr", "groupChrPr", "limLowPr", "limUppPr",
  "mPr", "naryPr", "phantPr", "radPr", "rPr", "sPrePr", "sSubPr", "sSubSupPr", "sSupPr",
]);

function entryName(entry: XmlEntry) {
  return Object.keys(entry).find((key) => key !== ":@" && key !== "#text" && key !== "#comment") ?? "";
}

function entryChildren(entry: XmlEntry) {
  const name = entryName(entry);
  const value = name ? entry[name] : undefined;
  return Array.isArray(value) ? value as XmlEntry[] : [];
}

function childEntry(entries: XmlEntry[], name: string) {
  return entries.find((entry) => entryName(entry) === name);
}

function childEntries(entries: XmlEntry[], name: string) {
  return entries.filter((entry) => entryName(entry) === name);
}

function childContent(entries: XmlEntry[], name: string) {
  const child = childEntry(entries, name);
  return child ? entryChildren(child) : [];
}

function attribute(entry: XmlEntry | undefined, name: string) {
  return entry?.[":@"]?.[name];
}

function nestedAttribute(entries: XmlEntry[], nodeName: string, name = "val") {
  return attribute(childEntry(entries, nodeName), name);
}

function textContent(entries: XmlEntry[]): string {
  return entries.map((entry) => {
    if (typeof entry["#text"] === "string") return entry["#text"] as string;
    return textContent(entryChildren(entry));
  }).join("");
}

function escapeMathText(value: string) {
  const replacements: Array<[RegExp, string]> = [
    [/\\/g, "\\backslash "], [/%/g, "\\%"], [/#/g, "\\#"], [/&/g, "\\&"], [/{/g, "\\{"], [/}/g, "\\}"],
    [/π/g, "\\pi "], [/×/g, "\\times "], [/÷/g, "\\div "], [/≤/g, "\\le "], [/≥/g, "\\ge "], [/≠/g, "\\ne "],
    [/±/g, "\\pm "], [/∓/g, "\\mp "], [/∠/g, "\\angle "], [/△/g, "\\triangle "], [/∞/g, "\\infty "], [/＝/g, "="],
    [/[−－﹣]/g, "-"], [/＋/g, "+"], [/＜/g, "<"], [/＞/g, ">"], [/（/g, "("], [/）/g, ")"], [/[•·]/g, "\\cdot "], [/°/g, "^{\\circ}"],
  ];
  let result = value;
  for (const [pattern, replacement] of replacements) result = result.replace(pattern, replacement);
  return result.replace(/(?<![A-Za-z])(sin|cos|tan|cot|log|ln)(?![A-Za-z])/gi, (name) => `\\${name.toLowerCase()} `);
}

function delimiterLatex(value: string, fallback: string) {
  const delimiter = value || fallback;
  if (delimiter === "{") return "\\{";
  if (delimiter === "}") return "\\}";
  if (delimiter === "‖") return "\\Vert";
  return escapeMathText(delimiter);
}

function mathLatex(entries: XmlEntry[]): string {
  return entries.map(mathEntryLatex).join("");
}

function mathEntryLatex(entry: XmlEntry): string {
  const name = entryName(entry);
  const children = entryChildren(entry);
  if (!name) return typeof entry["#text"] === "string" ? escapeMathText(entry["#text"] as string) : "";
  if (propertyNodes.has(name)) return "";
  if (name === "t") return escapeMathText(textContent(children));
  if (name === "r") return mathLatex(children.filter((child) => entryName(child) !== "rPr"));
  if (name === "f") return `\\frac{${mathLatex(childContent(children, "num"))}}{${mathLatex(childContent(children, "den"))}}`;
  if (name === "rad") {
    const degree = mathLatex(childContent(children, "deg"));
    const expression = mathLatex(childContent(children, "e"));
    return degree ? `\\sqrt[${degree}]{${expression}}` : `\\sqrt{${expression}}`;
  }
  if (name === "sSup") return `{${mathLatex(childContent(children, "e"))}}^{${mathLatex(childContent(children, "sup"))}}`;
  if (name === "sSub") return `{${mathLatex(childContent(children, "e"))}}_{${mathLatex(childContent(children, "sub"))}}`;
  if (name === "sSubSup") return `{${mathLatex(childContent(children, "e"))}}_{${mathLatex(childContent(children, "sub"))}}^{${mathLatex(childContent(children, "sup"))}}`;
  if (name === "sPre") return `{}_{${mathLatex(childContent(children, "sub"))}}^{${mathLatex(childContent(children, "sup"))}}${mathLatex(childContent(children, "e"))}`;
  if (name === "d") {
    const properties = childContent(children, "dPr");
    const begin = nestedAttribute(properties, "begChr") ?? "(";
    const end = nestedAttribute(properties, "endChr") ?? ")";
    const expressions = childEntries(children, "e").map((part) => mathLatex(entryChildren(part))).join(",");
    return `\\left${delimiterLatex(begin, "(")}${expressions}\\right${delimiterLatex(end, ")")}`;
  }
  if (name === "nary") {
    const properties = childContent(children, "naryPr");
    const operator = nestedAttribute(properties, "chr") ?? "∑";
    const operatorLatex: Record<string, string> = { "∑": "\\sum", "∏": "\\prod", "∐": "\\coprod", "∫": "\\int", "∬": "\\iint", "∭": "\\iiint", "∮": "\\oint" };
    const subscript = mathLatex(childContent(children, "sub"));
    const superscript = mathLatex(childContent(children, "sup"));
    return `${operatorLatex[operator] ?? escapeMathText(operator)}${subscript ? `_{${subscript}}` : ""}${superscript ? `^{${superscript}}` : ""}{${mathLatex(childContent(children, "e"))}}`;
  }
  if (name === "acc") {
    const mark = nestedAttribute(childContent(children, "accPr"), "chr") ?? "̂";
    const command = mark === "¯" || mark === "̅" ? "overline" : mark === "→" ? "vec" : mark === "~" || mark === "̃" ? "tilde" : "hat";
    return `\\${command}{${mathLatex(childContent(children, "e"))}}`;
  }
  if (name === "bar") {
    const position = nestedAttribute(childContent(children, "barPr"), "pos") ?? "top";
    return `\\${position === "bot" ? "underline" : "overline"}{${mathLatex(childContent(children, "e"))}}`;
  }
  if (name === "limLow") return `${mathLatex(childContent(children, "e"))}_{${mathLatex(childContent(children, "lim"))}}`;
  if (name === "limUpp") return `${mathLatex(childContent(children, "e"))}^{${mathLatex(childContent(children, "lim"))}}`;
  if (name === "func") return `${mathLatex(childContent(children, "fName"))}\\,${mathLatex(childContent(children, "e"))}`;
  if (name === "m") {
    const rows = childEntries(children, "mr").map((row) => childEntries(entryChildren(row), "e").map((cell) => mathLatex(entryChildren(cell))).join(" & "));
    return `\\begin{matrix}${rows.join(" \\\\ ")}\\end{matrix}`;
  }
  if (name === "eqArr") {
    const rows = childEntries(children, "e").map((row) => mathLatex(entryChildren(row)));
    return `\\begin{aligned}${rows.join(" \\\\ ")}\\end{aligned}`;
  }
  if (name === "groupChr") {
    const properties = childContent(children, "groupChrPr");
    const position = nestedAttribute(properties, "pos") ?? "bot";
    return `\\${position === "top" ? "overbrace" : "underbrace"}{${mathLatex(childContent(children, "e"))}}`;
  }
  if (["box", "borderBox", "phant", "e", "num", "den", "sub", "sup", "deg", "lim", "fName", "oMath", "oMathPara"].includes(name)) return mathLatex(children);
  return mathLatex(children);
}

function propertyEnabled(entry: XmlEntry | undefined) {
  const value = attribute(entry, "val");
  return value !== "0" && value !== "false" && value !== "off" && value !== "none";
}

function parseRun(entry: XmlEntry, pictures = false): DocxWebInline[] {
  const children = entryChildren(entry);
  const properties = childContent(children, "rPr");
  const verticalValue = nestedAttribute(properties, "vertAlign");
  const style = {
    bold: propertyEnabled(childEntry(properties, "b")) && Boolean(childEntry(properties, "b")),
    italic: propertyEnabled(childEntry(properties, "i")) && Boolean(childEntry(properties, "i")),
    underline: propertyEnabled(childEntry(properties, "u")) && Boolean(childEntry(properties, "u")),
    vertical: verticalValue === "superscript" ? "sup" as const : verticalValue === "subscript" ? "sub" as const : undefined,
  };
  const inlines: DocxWebInline[] = [];
  for (const child of children) {
    const name = entryName(child);
    if (name === "drawing" && pictures) inlines.push(...inlineFigures([child]).map((figure) => ({ type: "image" as const, ...figure })));
    if (name === "rPr" || name === "drawing" || name === "pict" || name === "object") continue;
    if (name === "t" || name === "instrText") {
      const value = textContent(entryChildren(child));
      if (value) inlines.push({ type: "text", value, ...style });
    } else if (name === "tab") inlines.push({ type: "tab" });
    else if (name === "br" || name === "cr") inlines.push({ type: "break" });
    else if (name === "oMath" || name === "oMathPara") {
      const latex = mathEntryLatex(child);
      if (latex) inlines.push({ type: "math", latex });
    } else if (name === "sym") {
      const code = Number.parseInt(attribute(child, "char") ?? "", 16);
      if (Number.isFinite(code)) inlines.push({ type: "text", value: String.fromCodePoint(code), ...style });
    } else {
      inlines.push(...parseInlineEntries(entryChildren(child), style, pictures));
    }
  }
  return inlines;
}

function parseInlineEntries(entries: XmlEntry[], inheritedStyle: Partial<Extract<DocxWebInline, { type: "text" }>> = {}, pictures = false): DocxWebInline[] {
  const inlines: DocxWebInline[] = [];
  for (const entry of entries) {
    const name = entryName(entry);
    if (name === "r") inlines.push(...parseRun(entry, pictures));
    else if (name === "oMath" || name === "oMathPara") {
      const latex = mathEntryLatex(entry);
      if (latex) inlines.push({ type: "math", latex });
    } else if (name === "t") {
      const value = textContent(entryChildren(entry));
      if (value) inlines.push({ type: "text", value, ...inheritedStyle });
    } else if (name === "tab") inlines.push({ type: "tab" });
    else if (name === "br" || name === "cr") inlines.push({ type: "break" });
    else if (name !== "pPr" && name !== "bookmarkStart" && name !== "bookmarkEnd" && name !== "proofErr") inlines.push(...parseInlineEntries(entryChildren(entry), inheritedStyle, pictures));
  }
  return inlines;
}

function parseParagraph(entry: XmlEntry, pictures = false): DocxWebParagraph {
  const children = entryChildren(entry);
  const properties = childContent(children, "pPr");
  const alignment = nestedAttribute(properties, "jc");
  return {
    type: "paragraph",
    inlines: parseInlineEntries(children, {}, pictures),
    align: alignment === "center" ? "center" : alignment === "right" || alignment === "end" ? "right" : "left",
  };
}

type RawCell = DocxWebTableCell & { verticalMerge?: "restart" | "continue" };

function parseTableCell(entry: XmlEntry): RawCell {
  const children = entryChildren(entry);
  const properties = childContent(children, "tcPr");
  const gridSpan = Math.max(1, Number(nestedAttribute(properties, "gridSpan") ?? 1) || 1);
  const mergeEntry = childEntry(properties, "vMerge");
  const mergeValue = attribute(mergeEntry, "val");
  const verticalMerge = mergeEntry ? mergeValue === "restart" ? "restart" : "continue" : undefined;
  return {
    blocks: children.flatMap(parseBlockEntry),
    colSpan: gridSpan,
    rowSpan: 1,
    verticalMerge,
  };
}

function parseTable(entry: XmlEntry): DocxWebTable {
  const rawRows = childEntries(entryChildren(entry), "tr").map((row) => childEntries(entryChildren(row), "tc").map(parseTableCell));
  const rows: DocxWebTableCell[][] = [];
  let activeMerges = new Map<number, DocxWebTableCell>();
  for (const rawRow of rawRows) {
    const cells: DocxWebTableCell[] = [];
    const nextMerges = new Map<number, DocxWebTableCell>();
    let column = 0;
    for (const rawCell of rawRow) {
      if (rawCell.verticalMerge === "continue") {
        const origin = activeMerges.get(column);
        if (origin) {
          origin.rowSpan += 1;
          for (let offset = 0; offset < origin.colSpan; offset += 1) nextMerges.set(column + offset, origin);
        } else cells.push(rawCell);
      } else {
        const cell: DocxWebTableCell = { blocks: rawCell.blocks, colSpan: rawCell.colSpan, rowSpan: rawCell.rowSpan };
        cells.push(cell);
        if (rawCell.verticalMerge === "restart") {
          for (let offset = 0; offset < cell.colSpan; offset += 1) nextMerges.set(column + offset, cell);
        }
      }
      column += rawCell.colSpan;
    }
    rows.push(cells);
    activeMerges = nextMerges;
  }
  return { type: "table", rows };
}

function parseBlockEntry(entry: XmlEntry): DocxWebBlock[] {
  const name = entryName(entry);
  if (name === "p") return [parseParagraph(entry)];
  if (name === "tbl") return [parseTable(entry)];
  return [];
}

function stripLeadingQuestionNumber(blocks: DocxWebBlock[]) {
  const firstParagraph = blocks.find((block): block is DocxWebParagraph => block.type === "paragraph");
  if (!firstParagraph) return;
  for (let index = 0; index < firstParagraph.inlines.length; index += 1) {
    const inline = firstParagraph.inlines[index];
    if (inline.type !== "text") continue;
    const value = inline.value.replace(/^\s*\d{1,3}[.．、]\s*/, "");
    firstParagraph.inlines[index] = { ...inline, value };
    if (!value) firstParagraph.inlines.splice(index, 1);
    break;
  }
}

function usefulBlock(block: DocxWebBlock): boolean {
  if (block.type === "table") return block.rows.some((row) => row.some((cell) => cell.blocks.some(usefulBlock)));
  return block.inlines.some((inline) => inline.type === "math" || inline.type === "text" && inline.value.trim().length > 0);
}

export function parseDocxWebContent(xml: string[], options: { stripLeadingQuestionNumber?: boolean } = {}): DocxWebContent {
  const blocks = xml.flatMap((fragment) => {
    try {
      const parsed = parser.parse(fragment) as XmlEntry[];
      return parsed.flatMap(parseBlockEntry);
    } catch {
      return [];
    }
  }).filter(usefulBlock);
  if (options.stripLeadingQuestionNumber) stripLeadingQuestionNumber(blocks);
  return { blocks };
}

function appendOptionInline(target: DocxWebInline[], inline: DocxWebInline) {
  if (inline.type === "tab") {
    if (target.length && target[target.length - 1]?.type !== "break") target.push({ type: "break" });
    return;
  }
  target.push(inline);
}

function trimOptionInlines(inlines: DocxWebInline[]) {
  const result = [...inlines];
  while (result[0]?.type === "break" || result[0]?.type === "tab" || result[0]?.type === "text" && !result[0].value.trim()) result.shift();
  while (result.at(-1)?.type === "break" || result.at(-1)?.type === "tab" || result.at(-1)?.type === "text" && !(result.at(-1) as Extract<DocxWebInline, { type: "text" }>).value.trim()) result.pop();
  return result;
}

function semanticOptionInlines(inlines: DocxWebInline[]): DocxWebInline[] {
  const cleaned = trimOptionInlines(inlines);
  const text = cleaned.filter((inline): inline is Extract<DocxWebInline, { type: "text" }> => inline.type === "text").map((inline) => inline.value).join("");
  const isFormula = !cleaned.some((inline) => inline.type === "image") && !/[\u3400-\u9fff]/.test(text) && cleaned.some((inline) => inline.type === "math" || inline.type === "text" && Boolean(inline.vertical));
  if (!isFormula) return cleaned;
  const latex = cleaned.map((inline) => {
    if (inline.type === "math") return inline.latex;
    if (inline.type === "break" || inline.type === "tab" || inline.type === "image") return " ";
    const value = escapeMathText(inline.value);
    return inline.vertical === "sup" ? `^{${value}}` : inline.vertical === "sub" ? `_{${value}}` : value;
  }).join("");
  return [{ type: "math", latex }];
}

export function parseDocxWebOptions(xml: string[]): DocxWebOption[] {
  // Options retain inline pictures, including a picture-only continuation paragraph.
  // Stem/analysis pictures still use their existing separate placement paths.
  const paragraphs = xml.flatMap((fragment) => {
    try { return (parser.parse(fragment) as XmlEntry[]).filter((entry) => entryName(entry) === "p").map((entry) => parseParagraph(entry, true)); }
    catch { return []; }
  });
  const found = new Map<string, DocxWebInline[]>();
  let currentLabel = "";
  for (const block of paragraphs) {
    for (const inline of block.inlines) {
      if (inline.type !== "text") {
        if (currentLabel) appendOptionInline(found.get(currentLabel)!, inline);
        continue;
      }
      const marker = /([A-F])[.．、]/g;
      let cursor = 0;
      for (const match of inline.value.matchAll(marker)) {
        const start = match.index ?? 0;
        if (currentLabel && start > cursor) appendOptionInline(found.get(currentLabel)!, { ...inline, value: inline.value.slice(cursor, start) });
        currentLabel = match[1];
        if (!found.has(currentLabel)) found.set(currentLabel, []);
        cursor = start + match[0].length;
      }
      if (currentLabel && cursor < inline.value.length) appendOptionInline(found.get(currentLabel)!, { ...inline, value: inline.value.slice(cursor) });
    }
    if (currentLabel) appendOptionInline(found.get(currentLabel)!, { type: "break" });
  }
  return [...found.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, inlines]) => ({ label, inlines: semanticOptionInlines(inlines) }))
    .filter((option) => option.inlines.length > 0);
}

export type DocxFigureLine = { align: DocxWebParagraph["align"]; figures: Array<{ id: string; width: number; height: number }> };

// The pictures a paragraph places in line with its text, at the size the document printed them (mm), with the
// paragraph's alignment. Floating pictures and pictures inside tables are not included.
function inlineFigures(entries: XmlEntry[]): DocxFigureLine["figures"] {
  const figures: DocxFigureLine["figures"] = [];
  const blipId = (list: XmlEntry[]): string | undefined => {
    for (const entry of list) {
      const id = entryName(entry) === "blip" ? attribute(entry, "embed") : blipId(entryChildren(entry));
      if (id) return id;
    }
  };
  const visit = (list: XmlEntry[]) => {
    for (const entry of list) {
      if (entryName(entry) !== "inline") { visit(entryChildren(entry)); continue; }
      const children = entryChildren(entry);
      const extent = childEntry(children, "extent");
      const id = blipId(children); const width = Number(attribute(extent, "cx")) / 36000; const height = Number(attribute(extent, "cy")) / 36000;
      if (id && width > 0 && height > 0) figures.push({ id, width, height });
    }
  };
  visit(entries);
  return figures;
}

export function docxFigureLine(xml: string): DocxFigureLine | null {
  let entries: XmlEntry[];
  try { entries = parser.parse(xml) as XmlEntry[]; } catch { return null; }
  const paragraph = entries.find((entry) => entryName(entry) === "p");
  if (!paragraph) return null;
  const figures = inlineFigures(entryChildren(paragraph));
  return figures.length ? { align: parseParagraph(paragraph).align, figures } : null;
}

// Every Word equation (m:oMath) of a document part, in document order, as LaTeX: the conversion the web cards use.
export function docxMathLatex(xml: string): string[] {
  let entries: XmlEntry[];
  try { entries = parser.parse(xml) as XmlEntry[]; } catch { return []; }
  const formulas: string[] = [];
  const visit = (list: XmlEntry[]) => {
    for (const entry of list) {
      if (entryName(entry) === "oMath") formulas.push(mathEntryLatex(entry));
      else visit(entryChildren(entry));
    }
  };
  visit(entries);
  return formulas;
}

export function docxWebInlineText(inlines: DocxWebInline[]) {
  return inlines.map((inline) => inline.type === "text" ? inline.value : inline.type === "math" ? `$${inline.latex}$` : inline.type === "image" ? "" : inline.type === "break" ? "\n" : "\t").join("");
}

export function docxWebContentText(content: DocxWebContent): string {
  return content.blocks.map((block) => {
    if (block.type === "paragraph") return docxWebInlineText(block.inlines);
    return block.rows.map((row) => row.map((cell) => docxWebContentText({ blocks: cell.blocks })).join("\t")).join("\n");
  }).join("\n");
}
