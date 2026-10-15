import { loadSource } from './load-source.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const {parseStudioPages,deduplicateStudioPages,matchStudioAnswers,reviseStudioQuestion,assertStudioExportable,validateStudioShapes,validateStudioDraft,studioInputMode,growStudioRectToBlankEdges} = await loadSource("lib/answer-studio.ts");
const {diagramBounds,studioDiagramVml,studioDiagramSvg} = await loadSource("lib/answer-studio-diagram.ts");
const record=(id,section='例题精练',extra={})=>({id,lesson:'一',section,number:'1',stem:'已知三角形ABC求外接圆的半径',analysis:'按原文转写',continuation:false,...extra});
const question=()=>({...record('q'),questionSources:[{pageId:'p',box:{x:0,y:0,width:100,height:100}}],answerIds:['a'],diagrams:[],warnings:[],resolutions:{},reviewed:true});
test('page ranges are bounded, deduplicated and selected before PDF rendering',()=>{assert.deepEqual(parseStudioPages('1-3,2,5',5),[1,2,3,5]);for(const s of ['0','4-2','6','1,x'])assert.throws(()=>parseStudioPages(s,5));});
test('the uploaded roles decide the transcription mode',()=>{
  assert.equal(studioInputMode(['question','question']),'questions');
  assert.equal(studioInputMode(['answer']),'answers');
  assert.equal(studioInputMode(['answer','question']),'paired');
  assert.equal(studioInputMode([]),null);
});
test('a tight figure box grows to the figure’s blank edges but not into separate content',()=>{
  const width=100,height=100,data=new Uint8ClampedArray(width*height*4).fill(255);
  const ink=(x,y)=>data.fill(0,(y*width+x)*4,(y*width+x)*4+3);
  for(let a=0;a<360;a+=0.5)ink(Math.round(50+20*Math.cos(a*Math.PI/180)),Math.round(50+20*Math.sin(a*Math.PI/180)));
  for(let x=20;x<80;x++)ink(x,80);// a text line after a blank gap below the circle at y=70
  const image={width,height,data};
  assert.deepEqual(growStudioRectToBlankEdges(image,{left:35,top:35,right:65,bottom:60},20),{left:30,top:30,right:70,bottom:70});
  assert.deepEqual(growStudioRectToBlankEdges(image,{left:28,top:28,right:72,bottom:72},20),{left:28,top:28,right:72,bottom:72},'a clean box is unchanged');
  assert.equal(growStudioRectToBlankEdges(image,{left:35,top:35,right:65,bottom:60},3).bottom,63,'growth is capped');
});
test('duplicate pages collapse only within their source role',()=>{assert.equal(deduplicateStudioPages([{role:'question',hash:'a'},{role:'question',hash:'a'},{role:'answer',hash:'a'}]).length,2);});
test('same numbers across sections cannot steal one another’s answers',()=>{assert.deepEqual(matchStudioAnswers(question(),[record('other','知识拼接'),record('a')]).map(x=>x.id),['a']);});
test('conflicting starts block matching and continuations preserve independent evidence',()=>{assert.equal(matchStudioAnswers(question(),[record('a'),record('b')]).length,0);assert.deepEqual(matchStudioAnswers(question(),[record('a'),record('b','例题精练',{continuation:true,stem:''})]).map(x=>x.id),['a','b']);assert.equal(matchStudioAnswers(question(),[record('b','例题精练',{continuation:true,stem:''})]).length,0);});
test('any edit invalidates review and a source warning needs a written resolution',()=>{const q=question();assert.equal(reviseStudioQuestion(q,{analysis:'改字'}).reviewed,false);const d={pages:[],questions:[q],answers:[record('a')]};assert.doesNotThrow(()=>assertStudioExportable(d));q.warnings=['字迹模糊'];assert.throws(()=>assertStudioExportable(d));q.resolutions={'字迹模糊':'对照原件确认'};assert.doesNotThrow(()=>assertStudioExportable(d));});
test('formal export blocks omitted pages, unassigned and multiply assigned answers',()=>{const d={pages:[],questions:[question()],answers:[record('a')]};assert.throws(()=>assertStudioExportable({...d,pages:[{selected:true}]}));assert.throws(()=>assertStudioExportable({...d,answers:[record('a'),record('b')]}));assert.throws(()=>assertStudioExportable({...d,questions:[question(),question()]}));});
const shape={id:'l',kind:'line',x:-40,y:20,width:100,height:-30,color:'#C00000',weight:2,dash:true,text:'',points:[]};
test('extensions outside base image remain in SVG and native Word group bounds',()=>{const d={width:200,height:100,baseImage:'',shapes:[shape]};assert.doesNotThrow(()=>validateStudioShapes([shape]));const b=diagramBounds(d);assert.ok(b.x<-40);assert.ok(b.y<-10);const xml=studioDiagramVml(d,'rId1','test');assert.match(xml,/<v:line/);assert.match(xml,/from="-40,20"/);assert.match(xml,/dashstyle="dash"/);assert.match(studioDiagramSvg(d),/x1="-40"/);});
test('standalone diagrams remain editable ellipses and labels with escaped content',()=>{const d={width:300,height:200,baseImage:'',shapes:[{...shape,kind:'ellipse',x:10,y:10,width:100,height:100},{...shape,kind:'label',x:10,y:10,width:30,height:20,text:'A<&'}]};const xml=studioDiagramVml(d,'','g');assert.match(xml,/<v:oval/);assert.match(xml,/<w:txbxContent>/);assert.equal([...xml.matchAll(/<w:t(?:\s[^>]*)?>(.*?)<\/w:t>/g)].map(m=>m[1]).join(''),'A&lt;&amp;');assert.doesNotMatch(xml,/<v:imagedata/);});
test('malformed shapes and unsafe backups fail closed',()=>{assert.throws(()=>validateStudioShapes([{...shape,x:NaN}]));assert.throws(()=>validateStudioShapes([{...shape,color:'red"/>'}]));assert.throws(()=>validateStudioDraft({version:1,title:'x',pages:[{id:'x',role:'answer',image:'https://secret'}],questions:[],answers:[]}));});
test('native segments normalize direction without changing either endpoint',()=>{
  for(const [width,height] of [[80,50],[80,-50],[-80,50],[-80,-50],[0,-50],[0,50],[-80,0],[80,0]]){
    const s={...shape,x:120,y:100,width,height};const xml=studioDiagramVml({width:300,height:200,baseImage:'',shapes:[s]},'','g');
    const match=xml.match(/from="([^"]+)" to="([^"]+)"/);assert.ok(match);
    const from=match[1].split(',').map(Number),to=match[2].split(',').map(Number);
    assert.ok(to[0]>=from[0]);if(to[0]===from[0])assert.ok(to[1]>=from[1]);
    assert.deepEqual([from.join(','),to.join(',')].sort(),[`${s.x},${s.y}`,`${s.x+width},${s.y+height}`].sort());
  }
});
