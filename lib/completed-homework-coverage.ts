import { completedExtractionSchema, completedExtractionPrompt, normalizeCompletedQuestions, type CompletedQuestion } from './completed-homework-contract';

export const HOMEWORK_PAGE_CONTRACT = 'completed-homework-pages-v1';
export const HOMEWORK_AI_CONCURRENCY = 2;
export const HOMEWORK_QUESTION_BATCH = 6;
export type PageExtraction = { pageNumber:number; kind:'questions'|'continuation'|'blank'|'unreadable'; reason:string; questions:CompletedQuestion[] };
export const completedPageExtractionSchema = {
  ...completedExtractionSchema,
  properties:{ ...completedExtractionSchema.properties,
    page:{type:'object',additionalProperties:false,properties:{page_number:{type:'integer'},kind:{type:'string',enum:['questions','continuation','blank','unreadable']},question_numbers:{type:'array',items:{type:'string'}},reason:{type:'string'}},required:['page_number','kind','question_numbers','reason']},
  },required:['questions','page'],
};
function invalid(message:string):never{throw new Error(`页面识别完整性检查未通过：${message}`);}
export function normalizePageExtraction(raw:unknown,pageNumber:number,contextPages:number[],totalPages:number):PageExtraction {
  if(!raw || typeof raw!=='object' || Array.isArray(raw))invalid('缺少页面回执');
  const value=raw as Record<string,unknown>,page=value.page as Record<string,unknown>|undefined;
  if(!page || Number(page.page_number)!==pageNumber)invalid(`应返回第 ${pageNumber} 页的回执`);
  if(!['questions','continuation','blank','unreadable'].includes(String(page.kind)))invalid('页面类型无效');
  if(!Array.isArray(page.question_numbers)||page.question_numbers.some(n=>typeof n!=='string'||!n.trim()))invalid('缺少可见题号清单');
  const numbers=page.question_numbers.map(n=>String(n).trim());
  if(new Set(numbers).size!==numbers.length)invalid('可见题号重复');
  const questions=normalizeCompletedQuestions(raw,totalPages);
  if(questions.some(q=>!q.page_numbers.includes(pageNumber)||q.page_numbers.some(n=>!contextPages.includes(n))))invalid('题目的页面归属超出本次输入');
  if(numbers.length!==questions.length || questions.some(q=>!numbers.includes(q.question_number)))invalid('可见题号与题目正文不一致，可能遗漏或截断');
  const reason=typeof page.reason==='string'?page.reason.trim():'';
  if(['questions','continuation'].includes(String(page.kind)) && !questions.length)invalid('有题页面返回空题目列表');
  if(['blank','unreadable'].includes(String(page.kind)) && (questions.length || !reason))invalid('无题或不可读页面必须明确说明原因，不能丢弃题目');
  // Canonical identities include the first page, because printed numbers restart between worksheets.
  const normalized=questions.map(q=>({...q,question_number:/^\d+$/.test(q.question_number)?`${q.page_numbers[0]}-${q.question_number}`:q.question_number}));
  return {pageNumber,kind:page.kind as PageExtraction['kind'],reason,questions:normalized};
}
export function completedPageExtractionPrompt(pageNumber:number,contextPages:number[],totalPages:number){
  return completedExtractionPrompt(totalPages)+`\n本次仅处理 PDF 第 ${pageNumber} 页。输入图片按顺序对应实际页码 ${contextPages.join('、')}；其余图片仅用于确认跨页题，禁止把相邻页的新题当作本页题。
必须完整列出第 ${pageNumber} 页上所有可见题目，包括续题。返回 page 回执：page_number=${pageNumber}，question_numbers 与 questions 中的题号一一对应。kind 只能是 questions、continuation、blank、unreadable；blank 仅用于确实没有题目或作答的空白页，unreadable 用于整页无法可靠辨认，并具体说明原因。
每道题使用“起始页码-印刷题号”作为 question_number，如 5-1。不同练习重复的印刷题号不能合并。续题沿用起始页题号；利用相邻页补全题干、所有分问、学生原答，并列出 page_numbers。图形、表格的题目条件必须完整写入题干，不能只写“如图”。不能因输出较长省略后半页或题目。`;
}
export function mergePageExtractions(pages:PageExtraction[]):CompletedQuestion[]{
  const byKey=new Map<string,CompletedQuestion>();
  for(const page of [...pages].sort((a,b)=>a.pageNumber-b.pageNumber)) {
    // An unreadable page has an explicit pending-page receipt, not an invented question.
    for(const q of page.questions){
      const existing=byKey.get(q.question_number);
      if(!existing){byKey.set(q.question_number,{...q});continue;}
      if(existing.page_numbers[0]!==q.page_numbers[0])invalid(`题号 ${q.question_number} 的起始页不一致`);
      // A continuation may extend the answer, but may never delete a previously seen part.
      const combine=(a:string,b:string)=>a.includes(b)?a:b.includes(a)?b:[a,b].filter(Boolean).join('\n');
      byKey.set(q.question_number,{...existing,stem:combine(existing.stem,q.stem),student_answer:combine(existing.student_answer,q.student_answer),page_numbers:[...new Set([...existing.page_numbers,...q.page_numbers])].sort((a,b)=>a-b),question_complete:existing.question_complete||q.question_complete,answer_state:existing.answer_state==='readable'||q.answer_state==='readable'?'readable':existing.answer_state==='unreadable'||q.answer_state==='unreadable'?'unreadable':'blank'});
    }
  }
  return [...byKey.values()].sort((a,b)=>a.page_numbers[0]-b.page_numbers[0] || a.question_number.localeCompare(b.question_number,undefined,{numeric:true}));
}
export function requireExactQuestionNumbers(expected:string[],returned:string[],stage:string){
  const missing=expected.filter(n=>!returned.includes(n));
  if(new Set(returned).size!==returned.length || returned.some(n=>!expected.includes(n)) || missing.length)throw new Error(`${stage}未完整返回本批次题目${missing.length?`，缺少：${missing.join('、')}`:''}`);
}
export async function boundedMap<T,R>(items:T[],limit:number,fn:(item:T,index:number)=>Promise<R>):Promise<R[]>{
  const results:R[]=new Array(items.length);let cursor=0;let stopped=false;
  let failure:unknown;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
    while(!stopped){const index=cursor++;if(index>=items.length)return;try{results[index]=await fn(items[index],index);}catch(error){stopped=true;failure??=error;}}
  }));
  if(failure)throw failure;
  return results;
}
