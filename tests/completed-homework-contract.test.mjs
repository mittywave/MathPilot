import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource } from './load-source.mjs';
import { finalizeHomeworkVerdict } from '../lib/homework-grading-rules.mjs';
const {normalizeCompletedQuestions,completedReferencePrompt,completedVerificationPrompt,normalizeCompletedReferences,normalizeCompletedVerification}=await loadSource('lib/completed-homework-contract.ts');
const base={question_number:'1',page_numbers:[1,2],type:'解答题',stem:'题目跨页',options:[],student_answer:'PRIVATE STUDENT ANSWER',answer_state:'readable',question_complete:true,bbox:{x:20,y:30,width:400,height:300},knowledge_tags:[],capability_keys:[]};
test('mistake coordinates preserve the whole answer box and reject uncertain, duplicate and out-of-box marks',async()=>{
 const {normalizeHomeworkGrading}=await loadSource('lib/homework-grading-contract.ts');
 const outer={x:100,y:200,width:700,height:500};
 const right={x:500,y:250,width:220,height:45},bottom={x:180,y:600,width:150,height:50};
 const errors=[right,bottom,right,{x:0,y:0,width:50,height:50},{x:790,y:250,width:60,height:40},{...right,width:0},{...right,x:'500'},{...right,y:NaN},null];
 const item={question_number:'19',verdict:'incorrect',bbox:{...outer,errors}};
 const normalize=patch=>normalizeHomeworkGrading({results:[{...item,...patch}]})[0];
 assert.deepEqual(normalize({}).bbox,{...outer,errors:[right,bottom]});
 for(const verdict of ['correct','unreadable','review_required'])assert.deepEqual(normalize({verdict}).bbox,outer);
 assert.deepEqual(normalize({bbox:outer}).bbox,outer,'older results need no local marks');
 assert.deepEqual(normalize({bbox:{...outer,errors:[{...right,x:-1}]}}).bbox,outer,'invalid local coordinates never move the outer frame');
 assert.equal(normalize({bbox:null}).bbox,null);
});
test('cross-page transcription retains page attribution and rejects duplicate question numbers or invalid pages',()=>{
 const questions=normalizeCompletedQuestions({questions:[base]},2);assert.deepEqual(questions[0].page_numbers,[1,2]);
 assert.throws(()=>normalizeCompletedQuestions({questions:[base,base]},2),/重复/);
 assert.throws(()=>normalizeCompletedQuestions({questions:[{...base,page_numbers:[3]}]},2),/页码无效/);
 assert.throws(()=>normalizeCompletedQuestions({questions:[{...base,page_numbers:[]}]},2),/页码无效/);
});
test('solving and verification never receive student answers',()=>{
 const q=normalizeCompletedQuestions({questions:[base]},2);
 const a=normalizeCompletedReferences({answers:[{question_number:'1',answer:'2',analysis:'独立解题',source:'agent'}]});
 assert.doesNotMatch(completedReferencePrompt(q,0),/PRIVATE STUDENT ANSWER|student_answer/);
 assert.doesNotMatch(completedVerificationPrompt(q,a),/PRIVATE STUDENT ANSWER|student_answer/);
 assert.equal(normalizeCompletedVerification({results:[{question_number:'1',verified:false,reason:'条件不足'}]})[0].verified,false);
});
test('clear blanks are missed answers, while unreadable answers and unresolved judgements require attention',()=>{
 assert.equal(finalizeHomeworkVerdict({type:'填空题',standardAnswer:'5',studentAnswer:'',answerState:'blank',modelVerdict:'incorrect',confidence:1}).verdict,'incorrect');
 assert.deepEqual(finalizeHomeworkVerdict({type:'填空题',standardAnswer:'5',studentAnswer:'',modelVerdict:'unreadable',confidence:.3}),{verdict:'unreadable',score:null,requiresReview:true,confidence:.3});
 assert.equal(finalizeHomeworkVerdict({type:'解答题',standardAnswer:'5',studentAnswer:'过程',modelVerdict:'review_required',confidence:.4}).verdict,'review_required');
});
test('figures are located on the page being read and their conditions reach solving without entering the stem',()=>{
 const figure={kind:'stem',bbox:{x:788,y:454,width:141,height:110}};
 const [q]=normalizeCompletedQuestions({questions:[{...base,page_numbers:[2],figures:[figure],figure_notes:'直线经过第二、四象限'}]},2,2);
 assert.deepEqual(q.figures,[{page:2,...figure}]);assert.equal(q.stem,'题目跨页');
 assert.equal(normalizeCompletedQuestions({questions:[base]},2)[0].figures,undefined);
 const a=normalizeCompletedReferences({answers:[{question_number:'1',answer:'B',analysis:'k<0',source:'agent'}]});
 for(const prompt of [completedReferencePrompt([q],0),completedVerificationPrompt([q],a)]){assert.match(prompt,/直线经过第二、四象限/);assert.doesNotMatch(prompt,/PRIVATE STUDENT ANSWER/);}
});
test('IGCSE / A Level references are written as mark points that add up to the printed marks',async()=>{
 const {completedPageExtractionPrompt}=await loadSource('lib/completed-homework-coverage.ts');
 const q={...base,max_score:5};
 assert.match(completedReferencePrompt([q],1,'international'),/得分点分值合计必须等于 max_score[\s\S]*"max_score":5/);
 assert.doesNotMatch(completedReferencePrompt([q],1),/得分点/);
 assert.match(completedVerificationPrompt([q],[],'international'),/合计等于 max_score/);
 assert.match(completedPageExtractionPrompt(2,[1,2,3],3,'international'),/第 2 页，即输入的第 2 张图片[\s\S]*按印刷分值的粒度拆分[\s\S]*figure_notes/);
 assert.match(completedPageExtractionPrompt(1,[1,2],2),/起始页码-印刷题号/);
 assert.equal(normalizeCompletedQuestions({questions:[{...base,max_score:'4'}]},2)[0].max_score,4);
});

test('school worksheets skip marked-answer transcription while exam marking preserves working',async()=>{
 const {completedPageExtractionPrompt}=await loadSource('lib/completed-homework-coverage.ts');
 const school=completedPageExtractionPrompt(1,[1,2],2);
 assert.match(school,/已有老师批改符号的题 student_answer 留空/);
 assert.match(school,/不能因为省略转录就当作空白作答/);
 const exam=completedPageExtractionPrompt(1,[1,2],2,'international');
 assert.match(exam,/完整转录学生原答，保留逐步评分所需的过程/);
 assert.doesNotMatch(exam,/已有老师批改符号的题 student_answer 留空/);
});

test('school answer verification checks mathematics without demanding a hidden written derivation',()=>{
 assert.match(completedVerificationPrompt([base],[]),/不能仅因答案未附推导或说明理由而判为未通过/);
 assert.doesNotMatch(completedVerificationPrompt([base],[],'international'),/不能仅因答案未附推导/);
});
