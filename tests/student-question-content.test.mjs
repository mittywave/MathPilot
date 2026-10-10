import assert from "node:assert/strict";
import test from "node:test";
import { loadSource } from "./load-source.mjs";

const { normalizeSingleRecognitionResult } = await loadSource("lib/recognition-contract.ts");
const { assignmentQuestionToQuestion } = await loadSource("lib/question-content.ts");

test("library scanning and automatic wrong-book snapshots preserve the same question content", () => {
  for (const raw of [
    { type: "单选题", stem: "计算 $\\frac{1}{2}+\\frac{1}{2}$", options: ["A. 1", "B. 1", "C. 2"], answer: "A", analysis: "通分后相加" },
    { type: "解答题", stem: "（1）解方程\n（2）验算", options: [], answer: "x=2", analysis: "两边同除以 2\n代回原式" },
  ]) {
    const scanned = normalizeSingleRecognitionResult(raw, []);
    const snapshot = assignmentQuestionToQuestion({
      id: "q1", type: scanned.type, stem: scanned.stem, options: scanned.options, answer: scanned.answer, analysis: scanned.analysis,
      pageNumber: 1, knowledgeTags: ["方程"], taxonomyKeys: ["cn-math:topic:linear-equation"], confidence: .98, warnings: [],
    }, { title: "测试作业", createdAt: 1, updatedAt: 2, originalImage: "/api/homework-assets/source" });
    for (const field of ["type", "stem", "options", "answer", "analysis"]) assert.deepEqual(snapshot[field], scanned[field]);
    assert.deepEqual(snapshot.tags, ["方程"]);
    assert.equal(snapshot.originalImage, "/api/homework-assets/source");
    assert.deepEqual(snapshot.taxonomyKeys, ["cn-math:topic:linear-equation"]);
  }
});

test('collected subquestions exclude group headings and duplicate major numbers without adding diagram notices',()=>{
  const q=assignmentQuestionToQuestion({id:'q',questionNumber:'12-15(2)',type:'填空题',stem:'B组 思想方法\n15. 蚂蚁从$O$出发，如图。\n(2) 求坐标。',options:[],answer:'',analysis:'',pageNumber:12,knowledgeTags:[],taxonomyKeys:[],warnings:[],figures:[{url:'/figure',kind:'stem',hasHandwriting:true}]},{title:'原卷',createdAt:1,updatedAt:2});
  assert.equal(q.stem,'蚂蚁从$O$出发，如图。\n(2) 求坐标。');
  assert.equal(q.contentImages[0],'/figure');assert.deepEqual(q.recognitionWarnings,[]);
});

test('collected OCR math repairs explicit command escapes and parallel signs without changing mathematical content',()=>{
  const template={id:'q',questionNumber:'8-17(2)',type:'解答题',stem:'$P_1P\\mathbin{/\negmedspace/}x$，$c=\\\\sqrt{19}$。',options:[],answer:'',analysis:'',pageNumber:8,knowledgeTags:[],taxonomyKeys:[],warnings:[]};
  const question=assignmentQuestionToQuestion(template,{title:'原卷',createdAt:1,updatedAt:2});
  assert.equal(question.stem,'$P_1P\\parallel x$，$c=\\sqrt{19}$。');
  assert.notEqual(question.stem,template.stem);
});

test('Word omits legacy diagram notices while retaining images and editable text',async(t)=>{
  const {readFile}=await import('node:fs/promises');const {default:JSZip}=await import('jszip');
  const {buildQuestionsWordBlob}=await loadSource('lib/export-word.ts');
  const png=await readFile(new URL('./fixtures/homework-question-page.png',import.meta.url));
  // Node has no DOM Image; provide the actual PNG header dimensions. The image
  // bytes still go through the real DOCX packer, and browser QA covers decoding.
  const OriginalImage=globalThis.Image;
  globalThis.Image=class{naturalWidth=png.readUInt32BE(16);naturalHeight=png.readUInt32BE(20);set src(_value){queueMicrotask(()=>this.onload());}};
  t.after(()=>{if(OriginalImage===undefined)delete globalThis.Image;else globalThis.Image=OriginalImage;});
  const url='data:image/png;base64,'+png.toString('base64');
  const question=assignmentQuestionToQuestion({id:'q',questionNumber:'12-15(2)',type:'填空题',stem:'B组 思想方法\n15. 如图。\n(2) 求$x$。',options:[],answer:'1',analysis:'',pageNumber:12,knowledgeTags:[],taxonomyKeys:[],warnings:[],figures:[{url,kind:'stem',hasHandwriting:true}]},{title:'原卷',createdAt:1,updatedAt:2});
  question.recognitionWarnings=['配图说明：原卷图内含手写标注，已忠实保留，请结合原卷核对。'];
  const zip=await JSZip.loadAsync(await (await buildQuestionsWordBlob([question],'配图规范回归',false)).arrayBuffer());
  const xml=await zip.file('word/document.xml').async('string');
  assert.doesNotMatch(xml,/配图说明|手写标注/);assert.match(xml,/<w:drawing/);assert.match(xml,/\(2\)/);assert.doesNotMatch(xml,/B组|思想方法|15\./);
});
