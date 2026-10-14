import { completedExtractionSchema, completedExtractionPrompt, normalizeCompletedQuestions, type CompletedQuestion, type KnownSheetQuestion, type TeacherMark } from './completed-homework-contract';
import { homeworkFigureRules, mergeHomeworkFigures } from './homework-figures';
import type { HomeworkCurriculum } from './types';

export const HOMEWORK_PAGE_CONTRACT = 'completed-homework-pages-v2-primary-image';
export const HOMEWORK_AI_CONCURRENCY = 4;
export const HOMEWORK_QUESTION_BATCH = 6;
export type PageExtraction = { pageNumber:number; kind:'questions'|'continuation'|'blank'|'unreadable'; reason:string; questions:CompletedQuestion[] };
export const completedPageExtractionSchema = {
  ...completedExtractionSchema,
  properties:{ ...completedExtractionSchema.properties,
    page:{type:'object',additionalProperties:false,properties:{page_number:{type:'integer'},kind:{type:'string',enum:['questions','continuation','blank','unreadable']},question_numbers:{type:'array',items:{type:'string'}},reason:{type:'string'}},required:['page_number','kind','question_numbers','reason']},
  },required:['questions','page'],
};
function invalid(message:string):never{throw new Error(`页面识别完整性检查未通过：${message}`);}
/** The sheet number a reading names: D2-3 as listed, or the same question written 2-3, 第2天第3题, 3 or 3(1). */
export function knownSheetNumber(raw:string,known:Set<string>){
  const number=raw.replace(/[（(][^（()）]*[)）]/g,'').replace(/\s+/g,'').replace(/[－—–]/g,'-');
  if(known.has(number))return number;
  const day=number.match(/^(?:D|第)?(\d+)天?-?第?(\d+)题?$/i);
  if(day&&known.has(`D${day[1]}-${day[2]}`))return `D${day[1]}-${day[2]}`;
  const single=number.match(/^第?(\d+)题?$/);
  return single&&known.has(single[1])?single[1]:null;
}
// An assigned sheet's reading keeps only the sheet's own questions under their listed numbers; anything else on the page
// (another sheet, scrap work) is left out, and parts the model listed apart are one question again.
function knownPageReading(value:Record<string,unknown>,page:Record<string,unknown>,known:Set<string>){
  const merged=new Map<string,Record<string,unknown>>();
  for(const item of Array.isArray(value.questions)?value.questions:[]){
    const question=item&&typeof item==='object'?item as Record<string,unknown>:{};
    const number=knownSheetNumber(String(question.question_number??''),known);
    if(!number)continue;
    const previous=merged.get(number);
    merged.set(number,previous?{...previous,student_answer:[previous.student_answer,question.student_answer].filter(Boolean).join('；'),
      answer_state:[previous.answer_state,question.answer_state].includes('readable')?'readable':[previous.answer_state,question.answer_state].includes('unreadable')?'unreadable':'blank',
      teacher_mark:strictestMark(previous.teacher_mark as TeacherMark,question.teacher_mark as TeacherMark)}
      :{...question,question_number:number,stem:'',options:[],figures:[],figure_notes:'',question_complete:true,max_score:null});
  }
  const numbers=[...new Set((Array.isArray(page.question_numbers)?page.question_numbers:[]).map(n=>knownSheetNumber(String(n),known)).filter((n):n is string=>Boolean(n)))];
  const kind=!merged.size&&['questions','continuation'].includes(String(page.kind))?'blank':page.kind;
  const reason=kind!==page.kind?'本页没有这份作业的题目':page.reason;
  return {...value,questions:[...merged.values()],page:{...page,kind,reason,question_numbers:numbers}};
}
export function normalizePageExtraction(raw:unknown,pageNumber:number,contextPages:number[],totalPages:number,curriculum:HomeworkCurriculum='school',known?:Set<string>):PageExtraction {
  if(!raw || typeof raw!=='object' || Array.isArray(raw))invalid('缺少页面回执');
  if(known&&(raw as Record<string,unknown>).page&&typeof (raw as Record<string,unknown>).page==='object')raw=knownPageReading(raw as Record<string,unknown>,(raw as Record<string,unknown>).page as Record<string,unknown>,known);
  const value=raw as Record<string,unknown>,page=value.page as Record<string,unknown>|undefined;
  if(!page || Number(page.page_number)!==pageNumber)invalid(`应返回第 ${pageNumber} 页的回执`);
  if(!['questions','continuation','blank','unreadable'].includes(String(page.kind)))invalid('页面类型无效');
  if(!Array.isArray(page.question_numbers)||page.question_numbers.some(n=>typeof n!=='string'||!n.trim()))invalid('缺少可见题号清单');
  const numbers=page.question_numbers.map(n=>String(n).trim());
  if(new Set(numbers).size!==numbers.length)invalid('可见题号重复');
  const questions=normalizeCompletedQuestions(raw,totalPages,pageNumber);
  if(questions.some(q=>!q.page_numbers.includes(pageNumber)||q.page_numbers.some(n=>!contextPages.includes(n))))invalid('题目的页面归属超出本次输入');
  if(numbers.length!==questions.length || questions.some(q=>!numbers.includes(q.question_number)))invalid('可见题号与题目正文不一致，可能遗漏或截断');
  const reason=typeof page.reason==='string'?page.reason.trim():'';
  if(['questions','continuation'].includes(String(page.kind)) && !questions.length)invalid('有题页面返回空题目列表');
  if(['blank','unreadable'].includes(String(page.kind)) && (questions.length || !reason))invalid('无题或不可读页面必须明确说明原因，不能丢弃题目');
  // School worksheets restart their numbers, so identities include the first page; a sub-question keeps its part, as 5-3(2).
  // An IGCSE / A Level upload is one paper, which keeps its printed numbers and is always marked by the model.
  // An assigned sheet's numbers are already its identities.
  if(known)return {pageNumber,kind:page.kind as PageExtraction['kind'],reason,questions};
  const normalized=curriculum==='international'?questions.map(q=>({...q,teacher_mark:'none' as const})):questions.map(q=>{
    const number=q.question_number.replace(/（/g,'(').replace(/）/g,')').replace(/\s+/g,'');
    const prefix=number.match(/^(\d+)-/);
    if(prefix && Number(prefix[1])!==q.page_numbers[0])invalid(`题号 ${number} 的页码前缀与作答起始页不一致`);
    return {...q,question_number:/^(?:\d+)?(?:\([^()]+\))*$/.test(number)?`${q.page_numbers[0]}-${number}`:number};
  });
  return {pageNumber,kind:page.kind as PageExtraction['kind'],reason,questions:normalized};
}
const QUESTION_IDENTITY='每道题使用“起始页码-印刷题号”作为 question_number，如 5-1。不同练习重复的印刷题号不能合并。有小问的题，每个小问单独作为一题，question_number 写“起始页码-印刷题号(小问号)”，小问号统一写成 (1)(2) 的形式，如 5-3(1)、5-3(2)；stem 先写本大题的公共条件，再写这一小问的原文；student_answer、bbox、teacher_mark 只对应这一小问。没有小问的题照旧作为一题。';
const INTERNATIONAL_IDENTITY='本作业是一份 IGCSE / A Level 英文试卷。按印刷分值的粒度拆分：单独印了分值的小问各作为一题，question_number 写印刷题号加小问，如 3(b)(ii)；分值只印在整题末尾、小问没有各自分值时，整题作为一题，只写印刷题号，如 5，题干和作答包含全部小问。stem 先写本大题的公共条件，再写这一题的原文，保持英文原文、不翻译；本大题配图的解题条件写进每一个小问的 figure_notes。max_score 是这一题印刷的分值，如 [3] 或 (3 marks)。student_answer 只写这一题的作答。只有印刷了选项的题用单选题，其余用解答题。';
// An assigned sheet is read one page at a time against its own list of questions.
function knownSheetPagePrompt(pageNumber:number,contextPages:number[],totalPages:number,curriculum:HomeworkCurriculum,known:KnownSheetQuestion[]){
  const days=known.some(q=>q.question_number.startsWith('D'));
  return completedExtractionPrompt(contextPages.length,curriculum,known)+`\n整份 PDF 共 ${totalPages} 页。本次仅处理 PDF 第 ${pageNumber} 页，即输入的第 ${contextPages.indexOf(pageNumber)+1} 张图片。学生交上来的页面可能乱序、缺页，也可能夹着草稿或别的练习。
必须完整列出第 ${pageNumber} 页上能看到的、题目清单里的每一道题，包括接着上一页写的作答。返回 page 回执：page_number=${pageNumber}，question_numbers 与 questions 中的题号一一对应。kind 只能是 questions、continuation、blank、unreadable；本页没有清单里的题（空白页、草稿、别的练习）时写 blank 并说明，unreadable 用于整页无法可靠辨认，并具体说明原因。
question_number 照抄清单里的编号${days?'（纸上每天另起一页，每天题号从 1 开始；每天第一页的标题和每一页的页眉都印着“第 N 天”。第 2 天的第 3 题编号是 D2-3）':''}，不能自造编号，也不能按书本页脚推算。${days?'先看页眉或当天标题确定是第几天，再按题号对应；':''}看不清题号或天数时，按印刷的题干内容在清单里找到对应的题。含小问的题整题作为一项，不拆小问，student_answer 依次写各小问的最终答案。清单里没有的题（老师另加的题、别的练习）不要列出。本次只有当前页图片，page_numbers 只能包含当前 PDF 页码。figures 返回空数组，figure_notes 写空字符串。不能因输出较长省略后半页或题目。
题目清单（编号｜印在纸上的位置｜题型｜题干开头）：
${known.map(q=>`${q.question_number}｜${q.label}｜${q.type}｜${q.stem}`).join('\n')}`;
}
export function completedPageExtractionPrompt(pageNumber:number,contextPages:number[],totalPages:number,curriculum:HomeworkCurriculum='school',known?:KnownSheetQuestion[]){
  if(known)return knownSheetPagePrompt(pageNumber,contextPages,totalPages,curriculum,known);
  return completedExtractionPrompt(contextPages.length,curriculum)+`\n整份 PDF 共 ${totalPages} 页。本次仅处理 PDF 第 ${pageNumber} 页，即输入的第 ${contextPages.indexOf(pageNumber)+1} 张图片。输入图片按顺序对应实际页码 ${contextPages.join('、')}；其余图片仅用于确认跨页题，禁止把相邻页的新题当作本页题。
必须完整列出第 ${pageNumber} 页上所有可见题目，包括续题。返回 page 回执：page_number=${pageNumber}，question_numbers 与 questions 中的题号一一对应。kind 只能是 questions、continuation、blank、unreadable；blank 仅用于确实没有题目或作答的空白页，unreadable 用于整页无法可靠辨认，并具体说明原因。
${curriculum==='international'?INTERNATIONAL_IDENTITY:QUESTION_IDENTITY}${contextPages.length===1?'本次只有当前页图片，page_numbers 只能包含当前 PDF 页码。严格照录本页印刷题号，不能按上一页推算、不能用书本页脚数字代替 PDF 页码。仅见小问号而看不到大题号时保留可见小问号，如 (3)，不要猜大题号；缺少公共条件写 question_complete=false，后续单独补全。':'续题沿用起始页题号；利用相邻页补全题干，并列出 page_numbers。'}学生作答按上述转录要求处理。只列本页可见分问，不能补出相邻页的新题或其他分问。表格按印刷内容转录进题干。不能因输出较长省略后半页或题目。
figures：第 ${pageNumber} 页（输入的第 ${contextPages.indexOf(pageNumber)+1} 张图片）上属于本题的每一幅印刷配图，坐标都按这一张图计算；相邻页上的配图不要写，没有配图返回空数组。${homeworkFigureRules.join('')}选项本身是图形时，options 只写图外另有的印刷文字，没有则返回空数组。
figure_notes：用文字写出配图中解题必需的条件，如图象经过的象限、点和线的位置关系、标注的长度与角度、各选项图形的区别；只用于解题核对，不展示给学生。没有配图写空字符串。`;
}
// A question split across pages carries the strictest mark any of its parts received.
const MARK_RANK:Record<TeacherMark,number>={none:0,correct:1,partial:2,incorrect:3};
const strictestMark=(a:TeacherMark='none',b:TeacherMark='none')=>MARK_RANK[a]>=MARK_RANK[b]?a:b;
/** Pages that disagree about where a question starts: at least one of them was misread and must be read again. */
export function conflictingPages(pages:PageExtraction[]):number[]{
  const starts=new Map<string,Set<number>>();
  for(const page of pages)for(const q of page.questions)starts.set(q.question_number,(starts.get(q.question_number)??new Set()).add(q.page_numbers[0]));
  const numbers=new Set([...starts].filter(([,first])=>first.size>1).map(([number])=>number));
  return pages.filter(page=>page.questions.some(q=>numbers.has(q.question_number))).map(page=>page.pageNumber);
}
// An assigned sheet's numbers are unique on paper, so the same number on two pages is one answer that ran on (known=true).
export function mergePageExtractions(pages:PageExtraction[],known=false):CompletedQuestion[]{
  const byKey=new Map<string,CompletedQuestion>();
  for(const page of [...pages].sort((a,b)=>a.pageNumber-b.pageNumber)) {
    // An unreadable page has an explicit pending-page receipt, not an invented question.
    for(const q of page.questions){
      const existing=byKey.get(q.question_number);
      if(!existing){byKey.set(q.question_number,{...q});continue;}
      if(!known&&existing.page_numbers[0]!==q.page_numbers[0])invalid(`题号 ${q.question_number} 的起始页不一致`);
      // A continuation may extend the answer, but may never delete a previously seen part.
      const combine=(a:string,b:string)=>a.includes(b)?a:b.includes(a)?b:[a,b].filter(Boolean).join('\n');
      byKey.set(q.question_number,{...existing,stem:combine(existing.stem,q.stem),student_answer:combine(existing.student_answer,q.student_answer),figures:mergeHomeworkFigures(existing.figures,q.figures),figure_notes:combine(existing.figure_notes??'',q.figure_notes??''),page_numbers:[...new Set([...existing.page_numbers,...q.page_numbers])].sort((a,b)=>a-b),question_complete:existing.question_complete||q.question_complete,max_score:Math.max(existing.max_score??0,q.max_score??0)||null,answer_state:existing.answer_state==='readable'||q.answer_state==='readable'?'readable':existing.answer_state==='unreadable'||q.answer_state==='unreadable'?'unreadable':'blank',teacher_mark:strictestMark(existing.teacher_mark,q.teacher_mark)});
    }
  }
  return [...byKey.values()].sort((a,b)=>a.page_numbers[0]-b.page_numbers[0] || a.question_number.localeCompare(b.question_number,undefined,{numeric:true}));
}
export function requireExactQuestionNumbers(expected:string[],returned:string[],stage:string){
  const missing=expected.filter(n=>!returned.includes(n));
  if(new Set(returned).size!==returned.length || returned.some(n=>!expected.includes(n)) || missing.length)throw new Error(`${stage}未完整返回本批次题目${missing.length?`，缺少：${missing.join('、')}`:''}`);
}
// Balance a short tail across the available slots; queue retries shrink only unfinished batches.
export function homeworkQuestionBatches<T>(items:T[],attempt=1,concurrency=HOMEWORK_AI_CONCURRENCY):T[][] {
  const maxSize=Math.max(1,Math.floor(HOMEWORK_QUESTION_BATCH/2**Math.min(3,Math.max(0,attempt-1))));
  const count=Math.max(Math.ceil(items.length/maxSize),Math.min(concurrency,items.length));
  const batches:T[][]=[];let cursor=0;
  for(let i=0;i<count;i++){const size=Math.floor(items.length/count)+(i<items.length%count?1:0);batches.push(items.slice(cursor,cursor+size));cursor+=size;}
  return batches;
}
export async function boundedMap<T,R>(items:T[],limit:number,fn:(item:T,index:number)=>Promise<R>,continueOnError=false):Promise<R[]>{
  const results:R[]=new Array(items.length);let cursor=0;let stopped=false;
  let failure:unknown;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
    while(!stopped){const index=cursor++;if(index>=items.length)return;try{results[index]=await fn(items[index],index);}catch(error){if(!continueOnError)stopped=true;failure??=error;}}
  }));
  if(failure)throw failure;
  return results;
}
