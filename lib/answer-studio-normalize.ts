import { normalizeProseLineBreaks, repairMathSource, restoreDecodedCommands, scanMathSource } from "./math-source.mjs";
import { studioMathIssues } from "./studio-math-layout";
import { hasStudioControlCharacters, type StudioAnswerPlacement, type StudioTable } from './answer-studio';

// A model may emit a valid JSON escape (e.g. \t) instead of the LaTeX
// backslash; restoreDecodedCommands puts those commands back. Never
// reinterpret ordinary prose whitespace or guess mathematical content.
// A doubly escaped newline (a literal \n in prose) becomes a real line break,
// so stored drafts, warnings and Word paragraphs all see the same lines.
export function normalizeStudioMathEscapes(text: string) {
  const source=restoreDecodedCommands(repairMathSource(normalizeProseLineBreaks(text)));
  let cursor=0,result='';
  for(const range of scanMathSource(source).ranges) {
    const markerLength=source[range.start]==='$'?(range.display?2:1):2;
    const start=range.start+markerLength,end=range.end-markerLength;
    let body=range.value.replace(/\\*nequiv\b/g, '\\parallel');
    // Only a redundant trailing row-break on a standalone expression. Never
    // strip an escaped dollar inside text or collapse aligned/cases row breaks.
    if(!/\\(?:begin|end|text|textrm|operatorname)\b/.test(body))body=body.replace(/\\{2,}\s*$/, '');
    result+=source.slice(cursor,start)+body+source.slice(end,range.end);
    cursor=range.end;
  }
  return repairMathSource(result+source.slice(cursor));
}

function validPlacement(value:unknown):value is StudioAnswerPlacement {
  if(!value||typeof value!=='object')return false;
  const p=value as Record<string,unknown>;
  return (p.kind==='choice'||p.kind==='blank')&&typeof p.placeholder==='string'&&!!p.placeholder.trim()&&typeof p.answer==='string'&&!!p.answer.trim();
}

/** Placement is optional layout metadata, never a reason to discard a page.
 * If one entry is unusable, decline the whole mapping to avoid shifting the
 * remaining answers into the wrong slots. Preserve recoverable literal answers
 * in the analysis instead, without guessing a placeholder or solving anything.
 */
function normalizeAnswerPlacements(value:unknown,analysis:string) {
  if(value==null)return {analysis,answerPlacements:[] as StudioAnswerPlacement[],warnings:[] as string[]};
  if(Array.isArray(value)&&value.every(validPlacement))return {analysis,answerPlacements:value,warnings:[] as string[]};
  const entries=Array.isArray(value)?value:[value];
  const answers=entries.flatMap(entry=>{
    const answer=entry&&typeof entry==='object'?(entry as Record<string,unknown>).answer:entry;
    if(typeof answer==='string'&&answer.trim())return [answer];
    if(typeof answer==='number'&&Number.isFinite(answer))return [String(answer)];
    return [];
  });
  // Compare whole lines, not substrings: answer "1" is not already recorded
  // merely because the proof contains a subpart number "(1)" or the value 10.
  const lines=new Set(analysis.split(/\r?\n/).map(line=>line.trim()));
  const extra=answers.filter(answer=>!lines.has(answer.trim()));
  return {
    analysis:[analysis,...extra].filter(text=>text.trim()).join('\n'),
    answerPlacements:[] as StudioAnswerPlacement[],
    warnings:[answers.length?'短答案填入位置不明确，已保留在解析中，未自动回填原题':'短答案信息不完整，原有解析已保留，请在 Word 中对照原件确认'],
  };
}

export function normalizeStudioTextFields<T extends {stem:string;analysis:string;warnings:string[];answerPlacements?:unknown}>(record:T) {
  const placement=normalizeAnswerPlacements(record.answerPlacements,record.analysis);
  const stem=normalizeStudioMathEscapes(record.stem),analysis=normalizeStudioMathEscapes(placement.analysis);
  const answerPlacements=placement.answerPlacements.map(p=>({...p,placeholder:normalizeStudioMathEscapes(p.placeholder),answer:normalizeStudioMathEscapes(p.answer)}));
  const tables:Array<StudioTable>=Array.isArray((record as T & {tables?:unknown}).tables)
    ? ((record as T & {tables?:unknown}).tables as StudioTable[]).map(table=>({...table,rows:table.rows.map(row=>row.map(cell=>normalizeStudioMathEscapes(cell))),warnings:[...table.warnings],red:table.red}))
    : [];
  const controlWarning='识别结果含异常控制字符，请对照原件修复公式';
  const warnings=[...new Set([...record.warnings,...placement.warnings])].filter(w=>w!==controlWarning&&!w.startsWith('公式格式检查：'));
  if([stem,analysis,...answerPlacements.flatMap(p=>[p.placeholder,p.answer]),...tables.flatMap(t=>t.rows.flat())].some(hasStudioControlCharacters))warnings.push(controlWarning);
  const mathFields:[string,string][]=[['题干',stem],['解析',analysis],
    ...answerPlacements.map(p=>['短答案',p.answer] as [string,string]),
    ...tables.flatMap(t=>t.rows.flat().map(cell=>['表格',cell] as [string,string]))];
  for(const [field,value] of mathFields)for(const issue of studioMathIssues(value))warnings.push(`公式格式检查：${field}：${issue}`);
  return {...record,stem,analysis,answerPlacements,tables,warnings:[...new Set(warnings)]};
}
