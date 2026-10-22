import type { StudioDraft, StudioQuestion } from './answer-studio';
import {studioDocumentReady} from './answer-studio-contract';

/** Input describes evidence; output describes which content to include. */
export type StudioOutputMode = 'full' | 'text' | 'steps';
type StudioOutput = { value: StudioOutputMode; label: string; description: string };
const questionOutputs: StudioOutput[] = [
  { value: 'full', label: '题目版', description: '题干、选项、表格和原题配图，可直接编辑。' },
  { value: 'text', label: '题目版（无图）', description: '题干、选项和表格，不含配图。' },
];
/** An originals-only paper has no solutions, so it offers only the question versions. */
export function studioOutputs(draft: Pick<StudioDraft, 'inputMode'> & Partial<Pick<StudioDraft,'pages'>>): StudioOutput[] {
  if(draft.pages&&studioDocumentReady({...draft,pages:draft.pages}))return [
    {value:'full',label:'标准试卷版',description:'按标准 Word 结构输出题目及原件中的完整答案解析，保留配图。'},
    {value:'text',label:'标准试卷版（无图）',description:'相同的题目和答案解析结构，省略配图。'},
  ];
  if (draft.inputMode === 'questions') return questionOutputs;
  return [
    { value: 'full', label: '完整解题版', description: studioIncludesQuestionFigures(draft) ? '原题、解析、原题图和解答图。' : '原题文字、解析和解答图（含必要底图）。' },
    { value: 'text', label: '题目解析版（无图）', description: '原题和步骤解析，不含原题配图或解答图。' },
    { value: 'steps', label: '仅解题步骤版', description: '只保留讲次、栏目、题号和解题步骤，不含题干或配图。' },
  ];
}

export function studioTextReady(draft: StudioDraft) {
  if(studioDocumentReady(draft))return true;
  const used = draft.questions.flatMap(q => q.answerIds);
  return draft.questions.length > 0 && !draft.pages.some(p => p.selected && !p.processed)
    && new Set(used).size === used.length && draft.answers.every(a => used.includes(a.id));
}

export function studioOutputBlocker(draft: StudioDraft, mode: StudioOutputMode) {
  void mode;
  if (!studioTextReady(draft)) return '文字转录尚未完成，请先继续转录。';
  return '';
}

/** Count evidence/format notices shown beside the output selector. */
export function studioIssueCount(draft: StudioDraft) {
  return draft.questions.reduce((total, q) => total + q.warnings.length + q.diagrams.reduce((n, d) => n + d.warnings.length, 0) + (q.tables||[]).reduce((n, t) => n + t.warnings.length, 0), 0);
}

/** Old answer-only drafts sometimes intentionally omitted printed choice figures. */
export function studioFullFiguresReady(q: StudioQuestion, draft: StudioDraft) {
  if (q.drawingsOmittedQuestionFigures) return false;
  return !!q.drawingsIncludeQuestionFigures || !q.answerOnly || q.diagrams.length > 0
    || !draft.answers.some(a => q.answerIds.includes(a.id) && a.diagramBoxes.length > 0);
}

export function studioIncludesQuestionFigures(draft: Pick<StudioDraft, 'inputMode'>) {
  return draft.inputMode !== 'answers';
}

export function studioFiguresReady(q: StudioQuestion, draft: StudioDraft) {
  if(!q.drawingsChecked)return false;
  if(studioIncludesQuestionFigures(draft))return studioFullFiguresReady(q,draft);
  // Reclassify a draft made by the old all-figures policy, rather than exporting
  // pure question figures as though they were teacher solution drawings.
  // Missing metadata is an old, unclassified cache, not evidence that pure
  // question figures were excluded. Only explicit scope/classification is safe.
  return q.drawingsIncludeQuestionFigures === false || !!q.drawingDisposition;
}
