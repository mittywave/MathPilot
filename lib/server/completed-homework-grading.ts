import type { GradingVerdict, QuestionType } from '../types';
import type { CompletedQuestion } from '../completed-homework-contract';
import { buildHomeworkGradingPrompt, homeworkGradingSchema, INTERNATIONAL_GRADING_RULES, normalizeHomeworkGrading } from '../homework-grading-contract';
import { boundedMap, HOMEWORK_AI_CONCURRENCY, homeworkQuestionBatches, requireExactQuestionNumbers } from '../completed-homework-coverage';
import { finalizeHomeworkVerdict, isSimpleObjectiveAnswer, normalizeHomeworkAnswer, normalizeMaxScore, reconcileHomeworkScore } from '../homework-grading-rules.mjs';
import type { HomeworkCurriculum } from '../types';
import { homeworkCurriculum, homeworkDb } from './homework';
import { homeworkAssetDataUrl } from './homework-assets';
import { callHomeworkModel, parseHomeworkModelText } from './homework-model';
import { AiQueueFailure } from './ai/queue-policy';
import { upsertResult } from './homework-grading';
// School homework is judged right or wrong only; the mark-scheme analysis stays for IGCSE / A Level scoring.
const VERDICT_ONLY_RULES='本作业只判对错：verdict 照常判定；feedback、error_type、evidence_summary 返回空字符串，step_analysis 返回空数组，不写解析、步骤分析和订正建议。';
const TEACHER_MARK_EVIDENCE={correct:'老师已打勾',partial:'老师判为半对',incorrect:'老师已打叉或圈出答案'};
type Row={id:string;question_number:string;page_number:number;type:QuestionType;stem:string;answer:string;analysis:string;reference_verified:number;input_evidence_json:string};
export async function gradeCompletedQuestions(submissionId:string,questions:Row[],upperAttempt:number,concurrency=HOMEWORK_AI_CONCURRENCY){
  const batches=homeworkQuestionBatches(questions,upperAttempt,concurrency);
  const assignment=await homeworkDb().prepare('SELECT a.curriculum FROM homework_submissions s JOIN homework_assignments a ON a.id=s.assignment_id WHERE s.id=?').bind(submissionId).first<{curriculum:string}>();
  const curriculum=homeworkCurriculum(assignment?.curriculum);
  await boundedMap(batches,concurrency,batch=>gradeBatch(submissionId,batch,upperAttempt,curriculum),true);
}
async function gradeBatch(submissionId:string,questions:Row[],upperAttempt:number,curriculum:HomeworkCurriculum){
  if(!questions.length)return;
  const pages=await homeworkDb().prepare('SELECT id,processed_asset_id,quality_json FROM submission_pages WHERE submission_id=? ORDER BY page_order').bind(submissionId).all<{id:string;processed_asset_id:string;quality_json:string}>();
  const gradeable:Row[]=[];
  for(const q of questions){
    const evidence=JSON.parse(q.input_evidence_json) as CompletedQuestion;
    const page=pages.results[evidence.page_numbers[0]-1];
    const badPage=evidence.page_numbers.some(n=>JSON.parse(pages.results[n-1]?.quality_json??'{}').blocking);
    const mark=evidence.teacher_mark??'none';
    if(mark!=='none'){
      // The teacher's own tick or cross is the verdict: nothing is solved, compared or explained.
      await upsertResult({submissionId,question:q,pageId:page?.id??null,verdict:mark,score:reconcileHomeworkScore(mark,null,evidence.max_score,curriculum).score,studentAnswer:evidence.student_answer,feedback:evidence.question_complete?'':'题干不完整，补充清晰页面后才能收入错题本',errorType:'',evidenceSummary:TEACHER_MARK_EVIDENCE[mark],confidence:1,bbox:evidence.bbox,requiresReview:!evidence.question_complete});
      continue;
    }
    let verdict:GradingVerdict|null=null,feedback='';
    if(!q.reference_verified||!evidence.question_complete){verdict='review_required';feedback='题意或参考解答尚未通过校验，请补充题目或参考答案';}
    else if(evidence.answer_state==='unreadable'||badPage){verdict='unreadable';feedback=curriculum==='international'?'本题作答看不清，按 0 分计；补交清晰照片后可重新批改':'本题作答无法可靠辨认，请补充清晰页面';}
    else if(evidence.answer_state==='blank'){verdict='incorrect';feedback='本题作答区域清晰完整但为空白，属于漏答';}
    if(verdict)await upsertResult({submissionId,question:q,pageId:page?.id??null,verdict,score:reconcileHomeworkScore(verdict,0,evidence.max_score,curriculum).score,studentAnswer:evidence.student_answer,feedback,errorType:verdict==='incorrect'?'漏答':'待处理',evidenceSummary:feedback,confidence:verdict==='incorrect'?1:0,bbox:evidence.bbox,requiresReview:verdict!=='incorrect'});
    else gradeable.push(q);
  }
  if(!gradeable.length)return;
  // Send only the pages used by this group, preserving their actual page labels in the prompt.
  const pageNumbers=[...new Set(gradeable.flatMap(q=>(JSON.parse(q.input_evidence_json) as CompletedQuestion).page_numbers))].sort((a,b)=>a-b);
  const images=await Promise.all(pageNumbers.map(n=>homeworkAssetDataUrl(pages.results[n-1].processed_asset_id)));
  // The stem is the printed text; what the extraction read from the figure travels beside it.
  const figureNotes=(q:Row)=>(JSON.parse(q.input_evidence_json) as CompletedQuestion).figure_notes;
  const prompt=buildHomeworkGradingPrompt(questions[0].page_number,gradeable.map(q=>({questionNumber:q.question_number,type:q.type,stem:figureNotes(q)?`${q.stem}\n（配图条件：${figureNotes(q)}）`:q.stem,answer:q.answer,analysis:q.analysis,maxScore:normalizeMaxScore((JSON.parse(q.input_evidence_json) as CompletedQuestion).max_score)})))+(curriculum==='international'?`\n${INTERNATIONAL_GRADING_RULES}`:`\n${VERDICT_ONLY_RULES}`)+`\n本次是已完成作业直接批改，没有空白模板图片。输入图片为学生答卷，实际页码依次为 ${pageNumbers.join('、')}。跨页题应结合所有页批改。只比较参考解答与学生原答；不能从学生答案倒推标准答案。无法确定则返回 review_required。`;
  const result=await callHomeworkModel({images,prompt,schema:homeworkGradingSchema,schemaName:'completed_homework_grading',upperAttempt});
  if(!result.text)throw new AiQueueFailure(result);
  let results;try{results=normalizeHomeworkGrading(parseHomeworkModelText(result.text));requireExactQuestionNumbers(gradeable.map(q=>q.question_number),results.map(r=>r.question_number),'批改结果');}catch{throw new AiQueueFailure({code:'OUTPUT_INVALID',status:422,error:'逐题批改返回内容未通过校验'});}
  for(const q of gradeable){
    const evidence=JSON.parse(q.input_evidence_json) as CompletedQuestion;const item=results.find(r=>r.question_number===q.question_number);const page=pages.results[evidence.page_numbers[0]-1];
    if(!item){await upsertResult({submissionId,question:q,pageId:page.id,verdict:'review_required',studentAnswer:evidence.student_answer,feedback:'本题未返回可确认的批改结果',errorType:'待处理',confidence:0,bbox:evidence.bbox,requiresReview:true});continue;}
    if(isSimpleObjectiveAnswer(q.type,q.answer) && normalizeHomeworkAnswer(evidence.student_answer)!==normalizeHomeworkAnswer(item.student_answer)) {
      await upsertResult({submissionId,question:q,pageId:page.id,verdict:'review_required',studentAnswer:evidence.student_answer,feedback:'识别阶段与批改阶段的学生作答转录不一致，请查看原卷或补图确认',errorType:'转录不一致',confidence:0,bbox:evidence.bbox,requiresReview:true});continue;
    }
    const final=finalizeHomeworkVerdict({type:q.type,standardAnswer:q.answer,studentAnswer:item.student_answer,modelVerdict:item.verdict,confidence:item.confidence,maxScore:evidence.max_score,modelScore:item.score,curriculum});
    const analysis=curriculum==='international'?{feedback:item.feedback,errorType:item.error_type,stepAnalysis:item.step_analysis,evidenceSummary:item.evidence_summary}:{feedback:'',errorType:'',stepAnalysis:[],evidenceSummary:''};
    await upsertResult({submissionId,question:q,pageId:page.id,verdict:final.verdict,score:final.score,studentAnswer:item.student_answer,...analysis,capabilityKeys:item.capability_keys,confidence:final.confidence,bbox:item.bbox??evidence.bbox,requiresReview:final.requiresReview});
  }
}
