import { randomClientId } from "./client-random-id.mjs";

/** Independent transcription model. Never use ordinary question cleanup on teacher answers. */
export type StudioBox = { x: number; y: number; width: number; height: number };
/** A printed paper is a document tree, not a collection of positioned text boxes.
 * Boxes locate evidence for transcription and figure crops; Word consumes the hierarchy only. */
export type StudioDocumentBlock = { id:string; role:'stem'|'body'|'subquestion'|'option'|'analysis'|'solution'|'comment'|'figure'|'table'; box:StudioBox; continuation:boolean; text?:string; rows?:string[][] };
export type StudioDocumentQuestion = { number:string; continuation:boolean; blocks:StudioDocumentBlock[] };
export type StudioDocumentSection = { title:string; continuation:boolean; questions:StudioDocumentQuestion[] };
export type StudioDocumentPart = { kind:'questions'|'answers'; title:string; heading:string; continuation:boolean; sections:StudioDocumentSection[] };
export type StudioDocumentPage = { printed:boolean; parts:StudioDocumentPart[]; warnings:string[] };
export type StudioPage = { id: string; role: "question" | "answer"; name: string; page: number; image: string; hash: string; selected: boolean; processed?: boolean; textHint?:string; document?:StudioDocumentPage };
export type StudioSource = { pageId: string; box: StudioBox };
export type StudioShape = {
  id: string; kind: "line" | "ellipse" | "path" | "label" | "point";
  x: number; y: number; width: number; height: number; color: string; weight: number;
  dash: boolean; text: string; points: Array<{ x: number; y: number }>;
};
export type StudioDiagram = { id: string; caption: string; baseImage: string; baseSource?: StudioSource; width: number; height: number; shapes: StudioShape[]; warnings: string[] };
export type StudioRecord = {
  answerPlacements?: StudioAnswerPlacement[];
  tables?: StudioTable[];
  id: string; lesson: string; section: string; number: string; stem: string; analysis: string;
  source: StudioSource; diagramBoxes: StudioBox[]; warnings: string[]; continuation: boolean;
};
export type StudioQuestion = {
  answerPlacements?: StudioAnswerPlacement[];
  tables?: StudioTable[];
  drawingsChecked?: boolean;
  drawingsRevision?: number;
  drawingsIncludeQuestionFigures?: boolean;
  drawingsOmittedQuestionFigures?: boolean;
  drawingDisposition?: 'solution' | 'question-only' | 'none' | 'uncertain';
  questionDiagramSources?: StudioSource[];
  answerOnly?: boolean;
  id: string; lesson: string; section: string; number: string; stem: string; analysis: string;
  questionSources: StudioSource[]; answerIds: string[]; diagrams: StudioDiagram[];
  warnings: string[]; resolutions: Record<string, string>; reviewed: boolean; bankId?: string;
};
export type StudioAnswerPlacement = { kind: "choice" | "blank"; placeholder: string; answer: string };
export type StudioTable = { rows: string[][]; warnings: string[]; red?: boolean };
export type StudioInputMode = "paired" | "answers" | "questions";
export type StudioDraft = { version: 1; inputMode?: StudioInputMode; title: string; pages: StudioPage[]; questions: StudioQuestion[]; answers: StudioRecord[]; updatedAt: number };
/** The uploaded materials decide the mode: originals only become an editable question paper,
 * answers only are transcribed alone, and both are paired. */
export function studioInputMode(roles: StudioPage["role"][]): StudioInputMode | null {
  const questions = roles.includes("question"), answers = roles.includes("answer");
  return questions && answers ? "paired" : questions ? "questions" : answers ? "answers" : null;
}
type StudioPixels = { width: number; height: number; data: ArrayLike<number> };
type StudioRect = { left: number; top: number; right: number; bottom: number };
/** Model figure boxes are often a little tight and cut a circle or label. Grow each side
 * while the three lines just outside it still hold ink, at most `max` pixels per side. */
export function growStudioRectToBlankEdges(image: StudioPixels, rect: StudioRect, max: number): StudioRect {
  const dark = (x: number, y: number) => { const i = (y * image.width + x) * 4; return image.data[i] + image.data[i + 1] + image.data[i + 2] < 510; };
  const column = (x: number, r: StudioRect) => { for (let y = r.top; y <= r.bottom; y++) if (dark(x, y)) return true; return false; };
  const row = (y: number, r: StudioRect) => { for (let x = r.left; x <= r.right; x++) if (dark(x, y)) return true; return false; };
  const near = (from: number, step: number, limit: number, test: (n: number) => boolean) => {
    for (let n = from, k = 0; k < 3 && n >= 0 && n < limit; n += step, k++) if (test(n)) return true;
    return false;
  };
  const r = { ...rect };
  for (let grew = true; grew;) {
    grew = false;
    if (rect.left - r.left < max && near(r.left - 1, -1, image.width, x => column(x, r))) { r.left--; grew = true; }
    if (r.right - rect.right < max && near(r.right + 1, 1, image.width, x => column(x, r))) { r.right++; grew = true; }
    if (rect.top - r.top < max && near(r.top - 1, -1, image.height, y => row(y, r))) { r.top--; grew = true; }
    if (r.bottom - rect.bottom < max && near(r.bottom + 1, 1, image.height, y => row(y, r))) { r.bottom++; grew = true; }
  }
  return r;
}
export const emptyStudioDraft = (): StudioDraft => ({ version: 1, title: "答案整理", pages: [], questions: [], answers: [], updatedAt: Date.now() });
export function hasStudioControlCharacters(s:string) {return Array.from(s).some(c=>{const n=c.charCodeAt(0);return n<32 && ![9,10,13].includes(n);});}
export const studioKey = (q: Pick<StudioRecord, "lesson" | "section" | "number">) => [q.lesson, q.section, q.number].map(v => v.replace(/\s/g, "")).join("|");
export const stemFingerprint = (s: string) => s.replace(/\\underline\{(?:\\quad|\s)*\}|_{2,}/g, "").replace(/\\(?:text|mathrm|mathit|textrm)\{([^{}]*)\}/g,"$1").replace(/[\s$\\{}，。．；：、,.·:;（）()＝=]/g, "");
export function sameStudioStem(a: string, b: string) {
  const x = stemFingerprint(a), y = stemFingerprint(b);
  return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 12 && (x.includes(y) || y.includes(x))));
}
export function parseStudioPages(input: string, count: number): number[] {
  if (!input.trim()) return Array.from({ length: count }, (_, i) => i + 1);
  const pages = new Set<number>();
  for (const part of input.replace(/，/g, ",").split(",")) {
    const match = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) throw new Error("页码格式应为 1-3,5");
    const start = Number(match[1]), end = Number(match[2] || start);
    if (start < 1 || end < start || end > count) throw new Error(`页码必须在 1—${count} 之间`);
    for (let p = start; p <= end; p++) pages.add(p);
  }
  return [...pages].sort((a,b) => a-b);
}
export function deduplicateStudioPages(pages: StudioPage[]) {
  const seen = new Set<string>();
  return pages.filter(p => { const key = `${p.role}:${p.hash}`; if (seen.has(key)) return false; seen.add(key); return true; });
}
export function mergeStudioRecords(records: StudioRecord[]): StudioRecord[] {
  const result: StudioRecord[] = [];
  for (const record of records) {
    const prior = result.filter(r => studioKey(r) === studioKey(record)).at(-1);
    if (record.continuation && prior) {
      // Keep each source record for evidence; explicitly attach continuation at matching time.
      result.push(record);
    } else if (!prior || !sameStudioStem(prior.stem, record.stem) || prior.analysis !== record.analysis) result.push(record);
  }
  return result;
}
export function matchStudioAnswers(question: StudioQuestion, answers: StudioRecord[]): StudioRecord[] {
  const candidates = answers.filter(a => studioKey(a) === studioKey(question));
  const starts = candidates.filter(a => !a.continuation && sameStudioStem(a.stem, question.stem));
  if (starts.length !== 1) return [];
  // A continuation without an unambiguous starting record cannot be silently attached.
  return [starts[0], ...candidates.filter(a => a.continuation)];
}
export function reviseStudioQuestion(q: StudioQuestion, patch: Partial<StudioQuestion>): StudioQuestion {
  return { ...q, ...patch, reviewed: false, bankId: undefined };
}
/** Create review items directly from evidence, without inventing missing questions. */
export function attachAnswerOnlyRecords(draft: StudioDraft): StudioQuestion[] {
  const questions = structuredClone(draft.questions);
  const used = new Set(questions.flatMap(q => q.answerIds));
  for (const a of draft.answers) {
    if (used.has(a.id)) continue;
    const candidates = questions.filter(q => studioKey(q) === studioKey(a));
    const stemConflict = candidates.length === 1 && !!a.stem.trim() && !!candidates[0].stem.trim() && !sameStudioStem(a.stem, candidates[0].stem);
    if (a.continuation && candidates.length === 1 && !stemConflict) {
      const q = candidates[0];
      q.answerIds.push(a.id); q.analysis += "\n" + a.analysis; q.tables = [...(q.tables||[]), ...(a.tables||[])];
      q.warnings = [...new Set([...q.warnings, ...a.warnings])]; q.reviewed = false;
    } else {
      const warning = a.continuation ? [stemConflict ? "续页题干与前题不一致，已分开保留，请人工确认是否为不同版本" : "续页起始题不明确，请人工确认归属"] : candidates.length ? ["同栏目题号重复，请人工确认边界"] : [];
      questions.push({id:randomClientId(),answerOnly:true,lesson:a.lesson,section:a.section,number:a.number,stem:a.stem,analysis:a.analysis,questionSources:[],answerIds:[a.id],diagrams:[],tables:a.tables||[],warnings:[...a.warnings,...warning,"尚未检查解答图与辅助线","仅答案材料：请确认未补写原件没有的步骤"],resolutions:{},reviewed:false});
    }
    used.add(a.id);
  }
  return questions;
}
export function studioQuestionIssues(q: StudioQuestion): string[] {
  const issues = [...q.warnings, ...q.diagrams.flatMap(d => d.warnings)].filter(w => !q.resolutions[w]?.trim());
  if (!q.answerOnly && !q.stem.trim()) issues.push("缺少题干");
  if (!q.analysis.trim()) issues.push("缺少完整解析");
  if (!q.answerIds.length) issues.push("尚未匹配答案原件");
  if (!q.answerOnly && !q.questionSources.length) issues.push("缺少原题证据");
  return [...new Set(issues)];
}
export function assertStudioExportable(draft: StudioDraft) {
  if (!draft.questions.length) throw new Error("没有可导出的题目");
  if (draft.pages.some(p => p.selected && !p.processed)) throw new Error("仍有选中页面未完成识别");
  const invalid = draft.questions.filter(q => !q.reviewed || studioQuestionIssues(q).length);
  if (invalid.length) throw new Error(`还有 ${invalid.length} 题未完成校对`);
  const used = draft.questions.flatMap(q => q.answerIds);
  if (new Set(used).size !== used.length) throw new Error("同一答案被重复分配，请检查匹配关系");
  if (draft.answers.some(a => !used.includes(a.id))) throw new Error("仍有未分配的答案，请匹配或明确移除非本次内容");
}
const number = (x: unknown) => typeof x === "number" && Number.isFinite(x);
export function validateStudioBox(value: unknown): StudioBox {
  const b = value as StudioBox;
  if (!b || ![b.x,b.y,b.width,b.height].every(number) || b.x < 0 || b.y < 0 || b.width <= 0 || b.height <= 0 || b.x+b.width > 1001 || b.y+b.height > 1001) throw new Error("页面区域坐标无效");
  return { x:b.x,y:b.y,width:b.width,height:b.height };
}
export function validateStudioShapes(value: unknown): StudioShape[] {
  if (!Array.isArray(value) || value.length > 300) throw new Error("图形列表无效");
  return value.map((raw, index) => {
    const s = raw as StudioShape;
    if (!s || !["line","ellipse","path","label","point"].includes(s.kind) || ![s.x,s.y,s.width,s.height,s.weight].every(number) || Math.max(...[s.x,s.y,s.width,s.height].map(Math.abs)) > 10000 || s.weight <= 0 || s.weight > 30 || !/^#[0-9a-f]{6}$/i.test(s.color) || typeof s.text !== "string" || s.text.length > 200 || !Array.isArray(s.points) || s.points.length > 300 || s.points.some(p => !number(p.x) || !number(p.y) || Math.abs(p.x)>10000 || Math.abs(p.y)>10000)) throw new Error(`第 ${index+1} 个图形无效`);
    if (["ellipse","label","point"].includes(s.kind) && (s.width <= 0 || s.height <= 0)) throw new Error("图形宽高必须为正数");
    if (s.kind === "path" && s.points.length < 2) throw new Error("路径至少需要两个点");
    return { ...s, id: `shape-${index}`, dash: !!s.dash };
  });
}
export function validateStudioTables(value: unknown): StudioTable[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 12) throw new Error("表格列表无效");
  return value.map((raw, tableIndex) => {
    const table = raw as StudioTable;
    if (!table || !Array.isArray(table.rows) || table.rows.length === 0 || table.rows.length > 80 || !Array.isArray(table.warnings) || table.warnings.some(w => typeof w !== "string") || (table.red !== undefined && typeof table.red !== "boolean")) throw new Error(`第 ${tableIndex + 1} 个表格无效`);
    const width = Math.max(...table.rows.map(row => Array.isArray(row) ? row.length : 0));
    if (width < 1 || width > 20) throw new Error(`第 ${tableIndex + 1} 个表格列数无效`);
    const rows = table.rows.map(row => {
      if (!Array.isArray(row) || row.length === 0 || row.length > 20) throw new Error(`第 ${tableIndex + 1} 个表格行无效`);
      return row.map(cell => {
        if (typeof cell !== "string" || cell.length > 10_000) throw new Error(`第 ${tableIndex + 1} 个表格单元格无效`);
        return cell;
      });
    });
    return { rows, warnings: [...new Set(table.warnings)], ...(table.red === undefined ? {} : { red: table.red }) };
  });
}
export function validateStudioDraft(value: unknown): StudioDraft {
  const d = value as StudioDraft;
  if (d?.inputMode !== undefined && !["paired","answers","questions"].includes(d.inputMode)) throw new Error("材料模式无效");
  if (!d || d.version !== 1 || typeof d.title !== "string" || !Array.isArray(d.pages) || d.pages.length > 160 || !Array.isArray(d.questions) || d.questions.length > 500 || !Array.isArray(d.answers)) throw new Error("不是有效的答案整理草稿");
  const ids = new Set<string>();
  for (const p of d.pages) {
    if (!p || typeof p.id !== "string" || ids.has(p.id) || !["question","answer"].includes(p.role) || !/^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=\s]+$/i.test(p.image) || p.image.length > 30_000_000) throw new Error("草稿原件无效");
    ids.add(p.id);
  }
  for (const q of d.questions) {
    if (!q || ![q.id,q.lesson,q.section,q.number,q.stem,q.analysis].every(v => typeof v === "string") || !Array.isArray(q.diagrams) || !Array.isArray(q.questionSources) || !Array.isArray(q.answerIds) || !Array.isArray(q.warnings) || !q.resolutions) throw new Error("草稿题目结构无效");
    q.tables = validateStudioTables(q.tables);
    for(const key of ['answerOnly','drawingsChecked','drawingsIncludeQuestionFigures','drawingsOmittedQuestionFigures'] as const)if(q[key]!==undefined&&typeof q[key]!=='boolean')throw new Error('题目材料或配图状态无效');
    if(q.questionDiagramSources!==undefined){
      if(!Array.isArray(q.questionDiagramSources))throw new Error('原题配图来源无效');
      for(const source of q.questionDiagramSources){if(!ids.has(source?.pageId))throw new Error('缺少原题配图来源页');validateStudioBox(source.box);}
    }
    for (const s of q.questionSources) { if (!ids.has(s.pageId)) throw new Error("缺少原题页"); validateStudioBox(s.box); }
    for (const g of q.diagrams) {
      if (!number(g.width) || !number(g.height) || g.width <= 0 || g.height <= 0 || g.width > 5000 || g.height > 5000 || (g.baseImage && !/^data:image\/(png|jpeg|webp);base64,/i.test(g.baseImage))) throw new Error("草稿配图无效");
      g.shapes = validateStudioShapes(g.shapes);
      if (!Array.isArray(g.warnings)) throw new Error("缺少配图校对信息");
    }
    // Backups are inputs, not authorization to bypass source review.
    q.reviewed = false; q.bankId = undefined;
  }
  for (const a of d.answers) { if (!a || ![a.id,a.lesson,a.section,a.number,a.stem,a.analysis].every(v => typeof v === "string") || !ids.has(a.source?.pageId) || !Array.isArray(a.warnings)) throw new Error("答案原件结构无效"); a.tables = validateStudioTables(a.tables); validateStudioBox(a.source.box); }
  if (new Set(d.questions.map(q=>q.id)).size !== d.questions.length || new Set(d.answers.map(a=>a.id)).size !== d.answers.length || d.questions.some(q=>q.answerIds.some(id=>!d.answers.some(a=>a.id===id)))) throw new Error("草稿标识或答案关系无效");
  return d;
}
