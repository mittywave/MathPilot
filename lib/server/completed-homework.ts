import { completedReferencePrompt, completedReferenceSchema, completedVerificationPrompt, completedVerificationSchema, normalizeCompletedReferences, normalizeCompletedVerification, type CompletedQuestion, type KnownSheetQuestion } from '../completed-homework-contract';
import { boundedMap, completedPageExtractionPrompt, conflictingPages, completedPageExtractionSchema, HOMEWORK_AI_CONCURRENCY, homeworkQuestionBatches, mergePageExtractions, normalizePageExtraction, requireExactQuestionNumbers, type PageExtraction } from '../completed-homework-coverage';
import { homeworkQuestionLabel } from '../homework-grading-rules.mjs';
import type { QuestionType } from '../types';
import { AiQueueFailure } from './ai/queue-policy';
import { homeworkCurriculum, homeworkDb } from './homework';
import { homeworkAssetDataUrl } from './homework-assets';
import { callHomeworkModel, parseHomeworkModelText } from './homework-model';
import { assertCompletePageCoverage, coverageFingerprint, type ExtractionPage } from './homework-page-coverage';

async function model(input: Parameters<typeof callHomeworkModel>[0]) {
  const result=await callHomeworkModel(input);
  if(!result.text)throw new AiQueueFailure(result);
  try{return parseHomeworkModelText(result.text);}catch{throw new AiQueueFailure({code:'OUTPUT_INVALID',status:422,error:'作业处理结果不是有效 JSON'});}
}
function invalid(error:unknown):never{throw error instanceof AiQueueFailure?error:new AiQueueFailure({code:'OUTPUT_INVALID',status:422,error:error instanceof Error?error.message:'作业处理结果不完整'});}
async function hash(value:unknown){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))].map(b=>b.toString(16).padStart(2,'0')).join('');}

export async function prepareCompletedHomework(submissionId:string,assignmentId:string,upperAttempt:number,onReady:(questionIds:string[])=>Promise<void>) {
  const db=homeworkDb();
  const submission=await db.prepare('SELECT student_id,reprocess_question_ids_json,published_at FROM homework_submissions WHERE id=?').bind(submissionId).first<{student_id:string;reprocess_question_ids_json:string;published_at:number|null}>();
  const pendingIds=JSON.parse(submission?.reprocess_question_ids_json??'[]') as string[];
  const pageResult=await db.prepare('SELECT id,page_order,processed_asset_id,quality_json FROM submission_pages WHERE submission_id=? ORDER BY page_order').bind(submissionId).all<ExtractionPage>();
  const pages=pageResult.results as ExtractionPage[];
  if(!pages.length)throw new Error('没有已上传的作业页面');
  const assignment=await db.prepare('SELECT template_confirmed,owner_user_id,curriculum,sheet_json FROM homework_assignments WHERE id=?').bind(assignmentId).first<{template_confirmed:number;owner_user_id:string;curriculum:string;sheet_json:string}>();
  const curriculum=homeworkCurriculum(assignment?.curriculum);
  // An old template flag is never proof that every uploaded page was examined.
  if(assignment?.template_confirmed){try{await assertCompletePageCoverage(submissionId);return;}catch{ /* Backfill missing coverage rather than accepting an old partial extraction. */ }}
  type StoredRow={id:string;question_number:string;type:QuestionType;stem:string;options_json:string;input_evidence_json:string;answer:string;analysis:string;reference_fingerprint:string;reference_evidence:string;reference_source:string;reference_verified:number;source_json:string};
  const storedResult=await db.prepare('SELECT id,question_number,type,stem,options_json,input_evidence_json,answer,analysis,reference_fingerprint,reference_evidence,reference_source,reference_verified,source_json FROM assignment_questions WHERE assignment_id=? ORDER BY sort_order').bind(assignmentId).all<StoredRow>();
  const stored=storedResult.results as StoredRow[];
  const oldByNumber=new Map(stored.map(q=>[q.question_number,q]));
  // An assigned homework already holds its questions: the pages are only searched for the answers to them.
  const sheet=assignment?.sheet_json?stored.filter(q=>q.source_json):null;
  // A new correction upload only reads its selected mistakes. A published upload's pending-item recovery still reads
  // its full inventory so the other results in that same upload stay visible.
  const scopedSheet=sheet&&pendingIds.length&&submission?.published_at==null?sheet.filter(q=>pendingIds.includes(q.id)):sheet;
  const knownNumbers=scopedSheet?new Set(scopedSheet.map(q=>q.question_number)):undefined;
  const inventory:KnownSheetQuestion[]|undefined=scopedSheet?.map(q=>({question_number:q.question_number,label:homeworkQuestionLabel(q.question_number),type:q.type,stem:q.stem.replace(/\s+/g,' ').slice(0,80)}));
  const originals=await db.prepare("SELECT asset_id FROM assignment_assets WHERE assignment_id=? AND role='question' ORDER BY page_order").bind(assignmentId).all<{asset_id:string}>();
  if(originals.results.length>30)throw new Error('学校作业原件最多30页');
  const originalImages=await Promise.all((originals.results as Array<{asset_id:string}>).map(row=>homeworkAssetDataUrl(row.asset_id)));
  const extracted=await boundedMap(pages,HOMEWORK_AI_CONCURRENCY,async(page,index):Promise<PageExtraction>=>{
    const fingerprint=await coverageFingerprint(pages,index);
    const cached=await db.prepare('SELECT result_json FROM submission_page_extractions WHERE submission_id=? AND page_id=? AND fingerprint=? AND status=\'complete\'').bind(submissionId,page.id,fingerprint).first<{result_json:string}>();
    if(cached)return JSON.parse(cached.result_json) as PageExtraction;
    // A worksheet's inventory and coordinates must come from one physical image.
    // Neighbours may supply missing conditions later, never the questions on this page.
    const context=curriculum==='school'?[page]:pages.slice(Math.max(0,index-1),index+2),contextNumbers=context.map(p=>p.page_order+1);
    try{
      const images=await Promise.all(context.map(p=>homeworkAssetDataUrl(p.processed_asset_id)));
      const read=normalizePageExtraction(await model({images,prompt:completedPageExtractionPrompt(page.page_order+1,contextNumbers,pages.length,curriculum,inventory),schema:completedPageExtractionSchema,schemaName:'completed_homework_page_extraction',upperAttempt}),page.page_order+1,contextNumbers,pages.length,curriculum,knownNumbers);
      const incomplete=read.questions.filter(q=>!q.question_complete);
      if(!sheet && read.questions.length && (originalImages.length || (curriculum==='school' && incomplete.length && pages.length>1))){
        const targets=originalImages.length?read.questions:incomplete;
        const neighbours=curriculum==='school'?pages.slice(Math.max(0,index-1),index+2).filter(p=>p.id!==page.id):context.filter(p=>p.id!==page.id);
        const contextPages=[page,...neighbours],contextImages=await Promise.all(contextPages.map(p=>homeworkAssetDataUrl(p.processed_asset_id)));
        const supplemented=normalizePageExtraction(await model({
          images:[...contextImages,...originalImages],
          prompt:completedPageExtractionPrompt(page.page_order+1,contextPages.map(p=>p.page_order+1),pages.length,curriculum)+`\n当前任务只补全已独立识别的下列题目缺失的印刷条件，不重新识别题目清单。第1张图是目标 PDF 第${page.page_order+1}页，后续图片仅作条件参考。PDF可能乱序，不能假定前一张就是题目的前半页。${originalImages.length?`前 ${contextImages.length} 张是学生作业页面，最后 ${originalImages.length} 张是学校作业原件，仅含印刷题目。原件页码与学生页面不一定对应，必须结合题号和题干内容确认同一题；不能把原件中的空白当作学生漏答，不能加入只在原件出现的题，原件上的内容也不能当作参考答案。`:''}只有能在原图确认属于同一题的条件才可补入 stem、options、figure_notes、max_score；无法确认则保留目标页原有条件和 question_complete，不猜测。不得补写其他小问或学生解答。question_number、page_numbers、bbox、figures、teacher_mark、student_answer、answer_state 必须沿用下列目标页记录，不得采用参考页的题号或坐标。page.question_numbers只列下列题号：\n${JSON.stringify(targets)}`,
          schema:completedPageExtractionSchema,schemaName:'completed_homework_page_context',upperAttempt,
        }),page.page_order+1,[page.page_order+1],pages.length,curriculum);
        requireExactQuestionNumbers(targets.map(q=>q.question_number),supplemented.questions.map(q=>q.question_number),'题目条件补全');
        read.questions=read.questions.map(q=>{
          const extra=supplemented.questions.find(item=>item.question_number===q.question_number);
          return extra?{...q,stem:extra.stem,options:extra.options,figure_notes:extra.figure_notes,question_complete:extra.question_complete,max_score:extra.max_score??q.max_score}:q;
        });
      }
      // Figures are cut once here; the cached extraction keeps their stored images for every later run.
      const {storeExtractedFigures}=await import('./homework-figures');
      const result={...read,questions:await storeExtractedFigures(read.pageNumber,page.processed_asset_id,read.questions,{ownerUserId:String(assignment?.owner_user_id),submissionId,assignmentId})};
      await db.prepare(`INSERT INTO submission_page_extractions(submission_id,page_id,processed_asset_id,fingerprint,status,result_json,error,updated_at) VALUES(?,?,?,?,'complete',?,'',?)
        ON CONFLICT(submission_id,page_id) DO UPDATE SET processed_asset_id=excluded.processed_asset_id,fingerprint=excluded.fingerprint,status='complete',result_json=excluded.result_json,error='',updated_at=excluded.updated_at`)
        .bind(submissionId,page.id,page.processed_asset_id,fingerprint,JSON.stringify(result),Date.now()).run();
      return result;
    }catch(error){
      await db.prepare(`INSERT INTO submission_page_extractions(submission_id,page_id,processed_asset_id,fingerprint,status,error,updated_at) VALUES(?,?,?,?,'failed',?,?)
        ON CONFLICT(submission_id,page_id) DO UPDATE SET fingerprint=excluded.fingerprint,status='failed',error=excluded.error,updated_at=excluded.updated_at`)
        .bind(submissionId,page.id,page.processed_asset_id,fingerprint,error instanceof Error?error.message:'页面处理失败',Date.now()).run();
      invalid(error);
    }
  });
  await assertCompletePageCoverage(submissionId);
  let questions:CompletedQuestion[];
  try{questions=mergePageExtractions(extracted,Boolean(sheet));}
  catch(error){
    // A misread page would otherwise be reused from cache on every retry; read the conflicting pages again.
    const misread=new Set(conflictingPages(extracted));
    if(misread.size)await db.batch(pages.filter(page=>misread.has(page.page_order+1)).map(page=>db.prepare("UPDATE submission_page_extractions SET status='failed',error=? WHERE submission_id=? AND page_id=?")
      .bind(error instanceof Error?error.message:'页面识别不一致',submissionId,page.id)));
    invalid(error);
  }
  // An assigned question keeps the content it was handed out with; the pages only tell where and how it was answered.
  if(sheet)questions=questions.map(q=>{
    const row=oldByNumber.get(q.question_number)!;
    return {...q,type:row.type,stem:row.stem,options:JSON.parse(row.options_json||'[]') as string[],question_complete:true,max_score:null,figures:[],figure_notes:''};
  });
  // A question read again as sub-questions (5-3 → 5-3(1), 5-3(2)) passes its record to the first sub-question.
  const numbers=new Set(questions.map(q=>q.question_number)),inherited=new Map<string,string>();
  for(const old of stored)if(!numbers.has(old.question_number)){
    const first=questions.find(q=>q.question_number.startsWith(`${old.question_number}(`)&&!oldByNumber.has(q.question_number)&&!inherited.has(q.question_number));
    if(first)inherited.set(first.question_number,old.id);
  }
  const recordId=(number:string)=>oldByNumber.get(number)?.id??inherited.get(number);
  // Old rows remain as history, but a successful reread must not resurrect
  // questions absent from its inventory (including misattributed neighbour pages).
  questions.sort((a,b)=>a.page_numbers[0]-b.page_numbers[0]||a.question_number.localeCompare(b.question_number,undefined,{numeric:true}));
  // Every page has been read, and what the pages hold does not change between attempts: these fail at once, not after retries.
  if(!questions.length)invalid(new Error(sheet?'上传的页面里没有找到这份作业的题目，请核对是不是这份作业':'全部页面已检查，但没有可识别的题目，请核对原件'));
  if(!sheet&&questions.length>200)invalid(new Error('每份作业最多200道题，当前未标记完成，请分份上传'));
  const pendingPages=pendingIds.filter((id:string)=>id.startsWith('page:')).map((id:string)=>Number(id.slice(5)));
  if(pendingIds.length)questions=questions.filter(q=>pendingIds.includes(recordId(q.question_number)??'')||q.page_numbers.some(p=>pendingPages.includes(p)));
  if(!questions.length)invalid(new Error('上传的页面里没有找到本次需要处理的题目，请核对题号和原件'));
  const ids=new Map(questions.map(q=>[q.question_number,recordId(q.question_number)??crypto.randomUUID()]));
  if(pendingIds.length)await db.prepare('UPDATE homework_submissions SET reprocess_question_ids_json=? WHERE id=?').bind(JSON.stringify([...ids.values()]),submissionId).run();
  // A question read beside a printed ID naming it is that question, handed in on paper: it keeps that question's content,
  // as an assigned one does, and only where and how it was answered comes from the page.
  const known=await (await import('./homework-wrong-book')).printedQuestions({id:String(assignment?.owner_user_id),email:'',role:'member'},String(submission?.student_id),sheet?[]:questions);
  if(known.size)questions=questions.map(q=>{const question=known.get(q.question_number)?.question;return question?{...q,type:question.type,stem:question.stem,options:question.options??[],question_complete:true}:q;});
  const now=Date.now();
  // An assigned question already has its row, content and place on the sheet; only where it was answered changes.
  if(sheet)for(let start=0;start<questions.length;start+=40)await db.batch(questions.slice(start,start+40).map(q=>db.prepare('UPDATE assignment_questions SET page_number=?,bbox_json=?,input_evidence_json=?,updated_at=? WHERE id=? AND assignment_id=?')
    .bind(q.page_numbers[0],q.bbox?JSON.stringify(q.bbox):null,JSON.stringify(q),now,ids.get(q.question_number),assignmentId)));
  else for(let start=0;start<questions.length;start+=40)await db.batch(questions.slice(start,start+40).map((q,index)=>db.prepare(`INSERT INTO assignment_questions(id,assignment_id,question_number,page_number,type,stem,options_json,answer,analysis,bbox_json,confidence,warnings_json,knowledge_tags_json,capability_keys_json,sort_order,created_at,updated_at,reference_source,reference_verified,input_evidence_json,source_json)
      VALUES(?,?,?,?,?,?,?,'','',?,0,'[]',?,?,?,?,?,'unresolved',0,?,?) ON CONFLICT(id) DO UPDATE SET question_number=excluded.question_number,${pendingIds.length?'':'sort_order=excluded.sort_order,'}stem=excluded.stem,options_json=excluded.options_json,type=excluded.type,page_number=excluded.page_number,bbox_json=excluded.bbox_json,input_evidence_json=excluded.input_evidence_json,source_json=excluded.source_json,updated_at=excluded.updated_at`)
      .bind(ids.get(q.question_number),assignmentId,q.question_number,q.page_numbers[0],q.type,q.stem,JSON.stringify(q.options),q.bbox?JSON.stringify(q.bbox):null,JSON.stringify(q.knowledge_tags),JSON.stringify(q.capability_keys),start+index,now,now,JSON.stringify(q),known.has(q.question_number)?JSON.stringify(known.get(q.question_number)!.question):'')));
  // Its own answer is its reference, as when it is handed out, unless the teacher has since given another. One without
  // an answer is solved below like any other question.
  const answered=[...known].flatMap(([number,{reference}])=>reference?[{number,reference}]:[]);
  if(answered.length)await db.batch(answered.map(({number,reference})=>db.prepare("UPDATE assignment_questions SET answer=?,analysis=?,reference_source=?,reference_verified=1,reference_evidence=?,reference_fingerprint='',updated_at=? WHERE id=? AND assignment_id=? AND reference_evidence NOT LIKE '教师补充并确认%'")
    .bind(reference.answer,reference.analysis,reference.source,reference.evidence,now,ids.get(number),assignmentId)));
  // These verdicts need no model request and must not wait behind slow reference batches.
  for(const q of questions.filter(q=>!q.question_complete))await db.prepare("UPDATE assignment_questions SET reference_verified=0,reference_source='unresolved',reference_evidence='题意不完整或页面无法辨认',reference_fingerprint='' WHERE id=? AND assignment_id=?").bind(ids.get(q.question_number),assignmentId).run();
  await onReady(questions.filter(q=>!q.question_complete||(q.teacher_mark??'none')!=='none').map(q=>ids.get(q.question_number)!));
  const refs=await db.prepare("SELECT asset_id FROM assignment_assets WHERE assignment_id=? AND role='answer' ORDER BY page_order").bind(assignmentId).all<{asset_id:string}>();
  const referenceIds=(refs.results as Array<{asset_id:string}>).map(r=>r.asset_id);
  if(referenceIds.length>30)throw new Error('参考答案最多30页');
  const answerImages=await Promise.all(referenceIds.map(id=>homeworkAssetDataUrl(id)));
  const reviewed=await db.prepare('SELECT assignment_question_id,verdict FROM grading_items WHERE submission_id=? AND reviewed_at IS NOT NULL').bind(submissionId).all<{assignment_question_id:string;verdict:string}>();
  const reviewedVerdicts=new Map(reviewed.results.map(row=>[row.assignment_question_id,row.verdict]));
  const readable=questions.filter(q=>q.question_complete&&(reviewedVerdicts.get(ids.get(q.question_number)!)??q.teacher_mark??'none')!=='correct').map(q=>{
    // Some recognized sub-parts explicitly refer to a previous part instead of repeating its conditions.
    const dependency=curriculum==='school'?q.stem.match(/在[（(](\d+)[）)]的条件下/):null;
    if(!dependency)return q;
    const number=q.question_number.replace(/\([^()]+\)$/,'')+`(${dependency[1]})`;
    const saved=oldByNumber.get(number);
    const previous=questions.find(item=>item.question_number===number)??(saved?JSON.parse(saved.input_evidence_json) as CompletedQuestion:null);
    if(!previous||number===q.question_number)return q;
    return {...q,stem:`本题引用的第(${dependency[1]})问条件（仅用于补足条件）：\n${previous.stem}${previous.figure_notes?`\n配图条件：${previous.figure_notes}`:''}\n当前小问：\n${q.stem}`};
  });
  const pendingReferences:CompletedQuestion[]=[],ready:CompletedQuestion[]=[];
  const keys=new Map<string,string>();
  for(const q of readable){
    const key=await hash({contract:'reference-batch-v1',stem:q.stem,type:q.type,options:q.options,figure_notes:q.figure_notes||undefined,referenceIds,...(curriculum==='international'?{curriculum,max_score:q.max_score}:{})});keys.set(q.question_number,key);
    const old=oldByNumber.get(q.question_number);
    // An assigned question's own answer is its reference; only one handed out without an answer is solved here.
    if(known.get(q.question_number)?.reference || old?.reference_fingerprint===key || old?.reference_evidence.startsWith('教师补充并确认') || (old?.source_json && Number(old.reference_verified)===1))ready.push(q);
    else pendingReferences.push(q);
  }
  // Each slot owns its entire solve → verify → grade chain, so stages together never exceed four requests.
  const pendingNumbers=new Set(pendingReferences.map(q=>q.question_number));
  const batches=[...homeworkQuestionBatches(ready,upperAttempt),...homeworkQuestionBatches(pendingReferences,upperAttempt)];
  await boundedMap(batches,HOMEWORK_AI_CONCURRENCY,async batch=>{
    try{
      if(batch.some(q=>pendingNumbers.has(q.question_number))){
        // A pending: fingerprint stores a generated answer, never a completed verification.
        const unsolved=batch.filter(q=>oldByNumber.get(q.question_number)?.reference_fingerprint!==`pending:${keys.get(q.question_number)}`);
        const answers=normalizeCompletedReferences({answers:batch.filter(q=>!unsolved.includes(q)).map(q=>{const old=oldByNumber.get(q.question_number)!;return {question_number:q.question_number,answer:old.answer,analysis:old.analysis,source:old.reference_source};})});
        if(unsolved.length){
          const generated=normalizeCompletedReferences(await model({images:answerImages,prompt:completedReferencePrompt(unsolved,answerImages.length,curriculum),schema:completedReferenceSchema,schemaName:'completed_homework_reference',upperAttempt}));
          requireExactQuestionNumbers(unsolved.map(q=>q.question_number),generated.map(a=>a.question_number),'参考解答');
          answers.push(...generated);
          await db.batch(generated.map(answer=>db.prepare("UPDATE assignment_questions SET answer=?,analysis=?,reference_source=?,reference_verified=0,reference_evidence='',reference_fingerprint=?,updated_at=? WHERE id=? AND assignment_id=?")
            .bind(answer.answer,curriculum==='international'?answer.analysis:'',answer.source==='provided'&&!answerImages.length?'agent':answer.source,`pending:${keys.get(answer.question_number)}`,Date.now(),ids.get(answer.question_number),assignmentId)));
        }
        const checks=normalizeCompletedVerification(await model({images:[],prompt:completedVerificationPrompt(batch,answers,curriculum),schema:completedVerificationSchema,schemaName:'completed_homework_verification',upperAttempt}));
        requireExactQuestionNumbers(batch.map(q=>q.question_number),checks.map(a=>a.question_number),'参考解答核验');
        await db.batch(batch.map(q=>{
          const answer=answers.find(a=>a.question_number===q.question_number)!,check=checks.find(c=>c.question_number===q.question_number)!;
          const verified=Boolean(answer.answer&&answer.source!=='unresolved'&&check.verified);
          return db.prepare('UPDATE assignment_questions SET reference_source=?,reference_verified=?,reference_evidence=?,reference_fingerprint=?,updated_at=? WHERE id=? AND assignment_id=?')
            .bind(verified?(answer.source==='provided'&&answerImages.length?'provided':'agent'):'unresolved',verified?1:0,check.reason||(verified?'已独立核验参考答案':'参考答案无法核验'),keys.get(q.question_number),Date.now(),ids.get(q.question_number),assignmentId);
        }));
      }
      // The callback uses one worker inside this slot and skips verdicts already saved in this run.
      await onReady(batch.map(q=>ids.get(q.question_number)!));
    }catch(error){invalid(error);}
  },true);
  await assertCompletePageCoverage(submissionId);
  await db.prepare('UPDATE homework_assignments SET template_confirmed=1,updated_at=? WHERE id=?').bind(Date.now(),assignmentId).run();
}
