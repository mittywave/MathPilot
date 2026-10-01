import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSource} from './load-source.mjs';
const {normalizePageExtraction,mergePageExtractions,requireExactQuestionNumbers,boundedMap}=await loadSource('lib/completed-homework-coverage.ts');
const question=(number,pages)=>({question_number:number,page_numbers:pages,type:'解答题',stem:'完整题干',options:[],student_answer:'作答',answer_state:'readable',question_complete:true,bbox:null,knowledge_tags:[],capability_keys:[]});
const receipt=(number,questions,kind='questions',reason='')=>({page:{page_number:number,kind,reason,question_numbers:questions.map(q=>q.question_number)},questions});
test('a partial multi-page response cannot acknowledge an unprocessed page',()=>{
 assert.throws(()=>normalizePageExtraction({questions:[question('1-1',[1])]},4,[3,4,5],27),/回执/);
 assert.throws(()=>normalizePageExtraction(receipt(1,[question('1-1',[1])]),4,[3,4,5],27),/第 4 页/);
 assert.throws(()=>normalizePageExtraction({...receipt(4,[question('4-1',[4])]),page:{page_number:4,kind:'questions',reason:'',question_numbers:['4-1','4-2']}},4,[3,4,5],27),/遗漏或截断/);
 assert.throws(()=>normalizePageExtraction(receipt(4,[]),4,[3,4,5],27),/空题目/);
});
test('blank and unreadable pages require explicit dispositions and cannot silently discard questions',()=>{
 assert.equal(normalizePageExtraction(receipt(7,[],'blank','此页没有题目或作答'),7,[6,7,8],27).kind,'blank');
 assert.throws(()=>normalizePageExtraction(receipt(7,[],'blank'),7,[6,7,8],27),/原因/);
 const unreadable=normalizePageExtraction(receipt(7,[],'unreadable','整页字迹无法辨认'),7,[6,7,8],27);
 assert.deepEqual(mergePageExtractions([unreadable]),[]);assert.equal(unreadable.kind,'unreadable');
});
test('continuations retain all pages and answers, while repeated printed numbers on different pages stay separate',()=>{
 const first=normalizePageExtraction(receipt(3,[{...question('3-12',[3,4]),student_answer:'第一问作答'}]),3,[2,3,4],27);
 const second=normalizePageExtraction(receipt(4,[{...question('3-12',[3,4]),student_answer:'第二问作答'},question('4-1',[4])]),4,[3,4,5],27);
 const merged=mergePageExtractions([first,second]);assert.equal(merged.length,2);assert.deepEqual(merged[0].page_numbers,[3,4]);assert.match(merged[0].student_answer,/第一问作答[\s\S]*第二问作答/);
 const restarted=normalizePageExtraction(receipt(5,[question('1',[5])]),5,[4,5,6],27);assert.equal(restarted.questions[0].question_number,'5-1');
});
test('reference, verification and grading responses must match all expected question identifiers exactly',()=>{
 requireExactQuestionNumbers(['a','b'],['b','a'],'核验');
 for(const returned of [['a'],['a','a'],['a','c']])assert.throws(()=>requireExactQuestionNumbers(['a','b'],returned,'核验'),/未完整/);
});
test('bounded workers wait for in-flight work on failure and never start the remaining batch',async()=>{
 let release;const pending=new Promise(resolve=>release=resolve);const started=[];
 const run=boundedMap([1,2,3],2,async value=>{started.push(value);if(value===1)throw new Error('truncated');await pending;return value;});
 let finished=false;run.catch(()=>{finished=true;});await new Promise(r=>setTimeout(r,1));assert.equal(finished,false);release();await assert.rejects(run,/truncated/);assert.deepEqual(started,[1,2]);
});
