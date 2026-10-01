import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSource } from './load-source.mjs';
import { finalizeHomeworkVerdict } from '../lib/homework-grading-rules.mjs';
const {normalizeCompletedQuestions,completedReferencePrompt,completedVerificationPrompt,normalizeCompletedReferences,normalizeCompletedVerification}=await loadSource('lib/completed-homework-contract.ts');
const base={question_number:'1',page_numbers:[1,2],type:'解答题',stem:'题目跨页',options:[],student_answer:'PRIVATE STUDENT ANSWER',answer_state:'readable',question_complete:true,bbox:{x:20,y:30,width:400,height:300},knowledge_tags:[],capability_keys:[]};
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
 assert.deepEqual(finalizeHomeworkVerdict({type:'填空题',standardAnswer:'5',studentAnswer:'',modelVerdict:'unreadable',confidence:.3}),{verdict:'unreadable',requiresReview:true,confidence:.3});
 assert.equal(finalizeHomeworkVerdict({type:'解答题',standardAnswer:'5',studentAnswer:'过程',modelVerdict:'review_required',confidence:.4}).verdict,'review_required');
});
