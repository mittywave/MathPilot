import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSource} from './load-source.mjs';
const {normalizePageExtraction,mergePageExtractions,conflictingPages,requireExactQuestionNumbers,boundedMap,homeworkQuestionBatches,completedPageExtractionPrompt}=await loadSource('lib/completed-homework-coverage.ts');
const question=(number,pages)=>({question_number:number,page_numbers:pages,type:'解答题',stem:'完整题干',options:[],student_answer:'作答',answer_state:'readable',question_complete:true,bbox:null,knowledge_tags:[],capability_keys:[]});
const receipt=(number,questions,kind='questions',reason='')=>({page:{page_number:number,kind,reason,question_numbers:questions.map(q=>q.question_number)},questions});
test('a selected day accepts bare correction numbers while ambiguous days and out-of-scope work stay out',()=>{
 const known=new Set(['D2-1','D2-3']);
 const reading=normalizePageExtraction(receipt(1,[question('1',[1]),question('第3题',[1]),question('D1-1',[1]),question('D2-2',[1])]),1,[1],1,'school',known);
 assert.deepEqual(reading.questions.map(q=>q.question_number),['D2-1','D2-3']);
 const ambiguous=normalizePageExtraction(receipt(1,[question('1',[1])]),1,[1],1,'school',new Set(['D1-1','D2-1']));
 assert.deepEqual(ambiguous.questions,[]);
});
test('page identity comes from the supplied primary image, not a neighbouring worksheet',()=>{
 const prompt=completedPageExtractionPrompt(13,[13],27);
 assert.match(prompt,/输入按顺序有 1 页/);assert.match(prompt,/整份 PDF 共 27 页/);
 assert.throws(()=>normalizePageExtraction(receipt(13,[question('12-15',[12])]),13,[13],27),/页面归属/);
 assert.throws(()=>normalizePageExtraction(receipt(13,[question('12-15',[13])]),13,[13],27),/页码前缀/);
 assert.throws(()=>normalizePageExtraction(receipt(12,[question('13-14(3)',[12,13])]),12,[12,13],27),/页码前缀/);
 const part=normalizePageExtraction(receipt(12,[{...question('(3)',[12]),question_complete:false}]),12,[12],27);
 assert.equal(part.questions[0].question_number,'12-(3)');
 assert.equal(part.questions[0].question_complete,false);
});
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
test('each page contributes the figures printed on it, and a continuation keeps both pages\' figures and notes',()=>{
 const figure=(x)=>({kind:'stem',bbox:{x,y:100,width:200,height:150}});
 const first=normalizePageExtraction(receipt(3,[{...question('3-12',[3,4]),figures:[figure(700)],figure_notes:'第一幅图'}]),3,[2,3,4],27);
 const second=normalizePageExtraction(receipt(4,[{...question('3-12',[3,4]),figures:[figure(100)],figure_notes:'第二幅图'}]),4,[3,4,5],27);
 assert.deepEqual(first.questions[0].figures.map(f=>f.page),[3]);
 const [merged]=mergePageExtractions([second,first]);
 assert.deepEqual(merged.figures.map(f=>[f.page,f.bbox.x]),[[3,700],[4,100]]);assert.equal(merged.figure_notes,'第一幅图\n第二幅图');
 const old=normalizePageExtraction(receipt(4,[question('3-12',[3,4])]),4,[3,4,5],27);
 assert.equal(mergePageExtractions([first,old])[0].figures,undefined);
});
test('IGCSE / A Level keeps printed sub-part numbers, and pages that disagree on a start page are read again',()=>{
 const intl=(page,questions)=>normalizePageExtraction(receipt(page,questions),page,[page-1,page,page+1].filter(n=>n>0),27,'international');
 const first=intl(1,[{...question('1(a)',[1]),max_score:2},{...question('1(b)',[1,2]),max_score:5,student_answer:'第一页'}]);
 const continued=intl(2,[{...question('1(b)',[1,2]),max_score:5,student_answer:'第二页'},{...question('2',[2]),max_score:4}]);
 const merged=mergePageExtractions([first,continued]);
 assert.deepEqual(merged.map(q=>[q.question_number,q.page_numbers,q.max_score]),[['1(a)',[1],2],['1(b)',[1,2],5],['2',[2],4]]);
 assert.match(merged[1].student_answer,/第一页[\s\S]*第二页/);
 assert.deepEqual(conflictingPages([first,continued]),[]);
 // Page 3 described page 2's content again, so question 2 seems to start on two pages.
 const misread=intl(3,[{...question('2',[3]),max_score:4}]);
 assert.throws(()=>mergePageExtractions([first,continued,misread]),/起始页不一致/);
 assert.deepEqual(conflictingPages([first,continued,misread]),[2,3]);
});
test('school sub-questions get their own page-prefixed identity and keep the teacher\'s mark; an exam paper never trusts marks',()=>{
 const page=normalizePageExtraction(receipt(5,[{...question('3（1）',[5]),teacher_mark:'correct'},{...question('3(2)',[5]),teacher_mark:'incorrect'},question('5-4',[5])]),5,[4,5,6],27);
 assert.deepEqual(page.questions.map(q=>[q.question_number,q.teacher_mark]),[['5-3(1)','correct'],['5-3(2)','incorrect'],['5-4','none']]);
 const paper=normalizePageExtraction(receipt(1,[{...question('1(a)',[1]),teacher_mark:'incorrect'}]),1,[1,2],2,'international');
 assert.deepEqual(paper.questions.map(q=>[q.question_number,q.teacher_mark]),[['1(a)','none']]);
});
test('a question split across pages carries the strictest teacher mark any part received',()=>{
 const first=normalizePageExtraction(receipt(3,[{...question('3-12',[3,4]),teacher_mark:'correct'}]),3,[2,3,4],27);
 const second=normalizePageExtraction(receipt(4,[{...question('3-12',[3,4]),teacher_mark:'incorrect'}]),4,[3,4,5],27);
 const unmarked=normalizePageExtraction(receipt(4,[question('3-12',[3,4])]),4,[3,4,5],27);
 assert.equal(mergePageExtractions([first,second])[0].teacher_mark,'incorrect');
 assert.equal(mergePageExtractions([first,unmarked])[0].teacher_mark,'correct');
});

test('question batches fill four slots for a short tail and shrink on retries without losing order',()=>{
 assert.deepEqual(homeworkQuestionBatches([1,2,3,4,5,6]).map(b=>b.length),[2,2,1,1]);
 for(const length of [0,1,2,6,25,200])for(const attempt of [1,2,3,4]){
  const items=Array.from({length},(_,i)=>i),batches=homeworkQuestionBatches(items,attempt);
  assert.deepEqual(batches.flat(),items);
  assert.ok(batches.every(b=>b.length>0&&b.length<=Math.max(1,Math.floor(6/2**(attempt-1)))));
 }
 assert.deepEqual(homeworkQuestionBatches([1,2],1,1),[[1,2]],'a pipeline slot must not launch nested workers');
});
test('independent batches finish after another batch fails, and the failure still reaches the queue',async()=>{
 const finished=[];
 await assert.rejects(boundedMap([1,2,3,4,5],2,async value=>{
  if(value===1)throw new Error('retry this batch');
  await new Promise(resolve=>setTimeout(resolve,1));finished.push(value);
 },true),/retry this batch/);
 assert.deepEqual(finished.sort(),[2,3,4,5]);
});
