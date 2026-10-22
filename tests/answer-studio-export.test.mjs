import {before,after} from 'node:test';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import JSZip from 'jszip';
import {loadSource} from './load-source.mjs';
const nativeFetch=globalThis.fetch;
before(()=>{globalThis.fetch=(url,...args)=>url==='/standard-math-paper.docx'?Promise.resolve(new Response(readFileSync('public/standard-math-paper.docx'))):nativeFetch(url,...args);});
after(()=>{globalThis.fetch=nativeFetch;});
const require=createRequire(import.meta.url);
test('standard figure padding preserves boundary labels without capturing the adjacent allocated paragraph',async t=>{
  const originals={Image:globalThis.Image,document:globalThis.document,FileReader:globalThis.FileReader};t.after(()=>Object.assign(globalThis,originals));
  const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',draws=[];
  globalThis.Image=class {width=1000;height=1000;set src(value){void value;queueMicrotask(()=>this.onload());}};
  globalThis.FileReader=class {readAsDataURL(){this.result=png;queueMicrotask(()=>this.onload());}};
  globalThis.document={createElement:()=>{const canvas={width:0,height:0,toBlob:callback=>callback(new Blob([Uint8Array.from(Buffer.from(png.split(',')[1],'base64'))]))};canvas.getContext=()=>({fillStyle:'',fillRect(){},drawImage(image,...args){if(args.length===8)draws.push({x:args[0],y:args[1],width:args[2],height:args[3]});},getImageData:()=>({width:canvas.width,height:canvas.height,data:new Uint8ClampedArray(canvas.width*canvas.height*4).fill(255).map((value,i)=>i%4===3?value:0)})});return canvas;}};
  const {buildStudioWord}=await loadSource('lib/answer-studio-export.ts');
  const blocks=[{id:'stem',role:'stem',text:'1．如图，求证。',rows:[],box:{x:100,y:100,width:700,height:30},continuation:false},{id:'figure',role:'figure',text:'',rows:[],box:{x:200,y:200,width:200,height:200},continuation:false},{id:'proof',role:'body',text:'在三角形中，继续证明。',rows:[],box:{x:100,y:402,width:700,height:30},continuation:false}];
  const draft={version:1,title:'图文边界',inputMode:'questions',pages:[{id:'p',role:'question',name:'source.pdf',page:1,image:png,hash:'p',selected:true,processed:true,document:{printed:true,parts:[{kind:'questions',title:'图文边界',heading:'',continuation:false,sections:[{title:'',continuation:false,questions:[{number:'1',continuation:false,blocks}]}]}],warnings:[]}}],questions:[],answers:[]};
  const before=structuredClone(draft),zip=await JSZip.loadAsync(await(await buildStudioWord(draft,'full')).arrayBuffer()),crop=draws.at(-1);
  assert.ok(crop.y+crop.height>400,'the figure can still grow to preserve its boundary labels');
  assert.ok(crop.y+crop.height<402,'growth must stop before the already allocated following text');
  const xml=await zip.file('word/document.xml').async('string');assert.equal((xml.match(/在三角形中/g)||[]).length,1);assert.match(xml,/<w:drawing>/);assert.deepEqual(draft,before);
  draws.length=0;const precise=structuredClone(draft);precise.pages[0].textHint=[[100,50,15,'图文边界'],[100,115,10.5,'1．如图，求证。'],[100,412,10.5,'在三角形中，继续证明。']].map(x=>JSON.stringify(x)).join('\n');
  await buildStudioWord(precise,'full');assert.ok(draws.at(-1).y+draws.at(-1).height<400,'PDF baseline evidence excludes glyphs overhanging an approximate paragraph box');
  draws.length=0;const loose=structuredClone(precise);loose.pages[0].document.parts[0].sections[0].questions[0].blocks[0].box.height=99;loose.pages[0].textHint=loose.pages[0].textHint.replace('[100,115,','[100,180,');
  await buildStudioWord(loose,'full');assert.ok(draws.at(-1).y<190,'an overestimated preceding paragraph box must not cut off figure labels above a tight figure box');
  draws.length=0;const {cropStudioImage}=await loadSource('lib/answer-studio-images.ts');await cropStudioImage(png,blocks[1].box);
  assert.ok(draws.at(-1).y+draws.at(-1).height>=402,'unstructured legacy crops retain their existing padding policy');
});
test('every transcription mode uses one retained framework for prose, simple scripts, complex math and paragraph flow',async()=>{
  const {buildStudioWord}=await loadSource('lib/answer-studio-export.ts');
  const coordinate=String.raw`1．设 $F(m,\frac{2}{m})$，并求 $x_1^2$。`;
  const calculation=String.raw`$=m\times\frac4m-\frac12(m-\frac12m)$`;
  const cases=String.raw`$\begin{cases}x=\frac12\\y=2\end{cases}$`;
  const matrix=String.raw`$\begin{bmatrix}1&2\\3&4\end{bmatrix}$`;
  const q={id:'q',lesson:'Reference lesson',section:'Part I 一、解答题',number:'1',stem:coordinate,analysis:[coordinate,calculation,cases,matrix].join('\n'),questionSources:[],answerIds:[],diagrams:[],warnings:[],resolutions:{},reviewed:true,drawingsChecked:true};
  const legacy={version:1,title:'共用格式',inputMode:'questions',pages:[],questions:[q],answers:[]};
  const blocks=[coordinate,calculation,cases,matrix].map((text,i)=>({id:`b${i}`,role:i?'body':'stem',text,rows:[],box:{x:40,y:100+i*100,width:900,height:80},continuation:false}));
  const printed={...legacy,questions:[],pages:[{id:'p',role:'question',name:'paper.pdf',page:1,image:'',hash:'p',selected:true,processed:true,document:{printed:true,parts:[{kind:'questions',title:'共用格式',heading:'',continuation:false,sections:[{title:'一、解答题',continuation:false,questions:[{number:'1',continuation:false,blocks}]}]}],warnings:[]}}]};
  const template=await JSZip.loadAsync(await readFile('public/standard-math-paper.docx'));
  for(const draft of [legacy,printed])for(const mode of draft===legacy?['full','text','steps','answers']:['full','text']){
    const before=structuredClone(draft),zip=await JSZip.loadAsync(await(await buildStudioWord(draft,mode,{transcription:true,includeTranscriptionWarnings:false})).arrayBuffer());
    const xml=await zip.file('word/document.xml').async('string');
    for(const part of ['word/styles.xml','word/theme/theme1.xml','word/fontTable.xml','word/footer1.xml'])assert.equal(await zip.file(part).async('string'),await template.file(part).async('string'),`${mode}: ${part}`);
    assert.match(xml,/<w:pgMar w:top="1418"[^>]*w:right="1134"[^>]*w:bottom="1418"[^>]*w:left="1134"/);
    assert.doesNotMatch(xml,/Songti SC|MP_TEMPLATE_|MP_DOCUMENT_|<w:sz w:val="22"|<m:oMathPara>/);
    for(const [run] of xml.matchAll(/<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g))if(/<w:t(?:\s|>)/.test(run)){
      assert.match(run,/w:ascii="Times New Roman"/,'headings, labels and prose must not inherit an editor default Latin font');
      assert.match(run,/w:eastAsia="新宋体"/,'every text run follows the reference Chinese font');
    }
    assert.match(xml,/<w:sz w:val="24"\/>[\s\S]*?<w:vertAlign/,'simple scripts share the reference text formatting');
    const paragraphs=[...xml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].map(m=>m[0]);
    const coordinateParagraph=paragraphs.find(p=>p.includes('设'));
    assert.ok(coordinateParagraph);assert.doesNotMatch(coordinateParagraph,/<m:d>/,'ordinary coordinate parentheses stay literal body-size characters');
    assert.match(coordinateParagraph,/<m:t>\(<\/m:t>/);assert.match(coordinateParagraph,/<m:t>\)<\/m:t>/);
    const independent=paragraphs.filter(p=>p.includes('<m:oMath>')&&!p.includes('设'));
    assert.ok(independent.length>=3);
    for(const p of independent){assert.match(p,/<w:t>\u200C<\/w:t><\/w:r><m:oMath>/);assert.match(p,/<w:ind w:left="312"/);assert.doesNotMatch(p,/<w:r>(?:(?!<\/w:r>)[\s\S])*?<m:oMath>/,'native math is a valid paragraph child');}
    assert.match(xml,/<m:begChr m:val="\{"/);assert.match(xml,/<m:begChr m:val="\["/,'matrix brackets retain scalable native structure');
    assert.ok((xml.match(/<m:m>/g)||[]).length>=2);assert.match(xml,/<m:mcJc m:val="left"/);
    assert.deepEqual(draft,before);
  }
});
test('standard paper output uses the supplied Word structure and paragraph styles rather than floating OCR text boxes',async t=>{
  const templateBytes=await readFile('public/standard-math-paper.docx'),source=await JSZip.loadAsync(templateBytes),originalFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=originalFetch;});
  globalThis.fetch=async url=>{assert.equal(url,'/standard-math-paper.docx');return new Response(templateBytes);};
  const {buildStudioWord}=await loadSource('lib/answer-studio-export.ts');
  const box={x:50,y:100,width:850,height:100};const block=(id,role,text,rows=[])=>({id,role,box,continuation:false,text,rows});
  const part=(kind,blocks)=>({kind,title:'标准原卷标题',heading:kind==='answers'?'参考答案与试题解析':'',continuation:false,sections:[{title:'一、填空题。',continuation:false,questions:[{number:'1',continuation:false,blocks}]}]});
  const document={printed:true,parts:[part('questions',[block('q1','stem','1．已知 $a^2+b^2=4ab$，求 $\\frac{a+b}{a-b}$为_____。'),block('table','table','',[['条件','结论'],['$x^2=1$','$\\sqrt{3}$']])]),part('answers',[block('a1','stem','1．已知 $a^{2}+b^{2}=4ab$，求 $\\frac{a+b}{a-b}$为____$\\pm\\sqrt{3}$____。'),block('analysis','analysis','【分析】完整原文分析。'),block('solution','solution','【解答】解：$x=1$。'),block('proof','body','∵$x=1$，∴$20*24=22$。填空$\\underline{\\quad6\\quad}$后续$x=2$。另一个空<u> 305 </u>。'),block('comment','comment','【点评】完整原文点评。'),block('html-math','body','含公式<u>$\\sqrt{3}$</u>。'),block('two-blanks','body','两个独立下划线$\\underline{x}+\\underline{y}$。'),block('cases','body','嵌套方程组$\\begin{cases}x=1\\\\y=\\begin{cases}2\\\\3\\end{cases}\\end{cases}$。')])],warnings:[]};
  const draft={version:1,inputMode:'questions',title:'任务名称不应覆盖原卷',pages:[{id:'p',role:'question',name:'sample.pdf',page:1,image:'',hash:'p',selected:true,processed:true,document}],questions:[],answers:[],updatedAt:0};const before=structuredClone(draft);
  const zip=await JSZip.loadAsync(await(await buildStudioWord(draft,'full',{transcription:true,includeTranscriptionWarnings:false})).arrayBuffer());const xml=await zip.file('word/document.xml').async('string');
  const plain=[...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(m=>m[1]).join('');
  assert.equal((xml.match(/标准原卷标题/g)||[]).length,2);assert.equal((plain.match(/1．已知/g)||[]).length,2);assert.match(xml,/参考答案与试题解析/);assert.match(xml,/完整原文分析/);assert.match(xml,/完整原文点评/);assert.doesNotMatch(xml,/任务名称不应覆盖原卷|待校对样张/);
  assert.match(xml,/<w:pgMar w:top="1418"[^>]*w:right="1134"[^>]*w:bottom="1418"[^>]*w:left="1134"/);assert.match(xml,/<w:docGrid w:type="lines" w:linePitch="312"/);assert.match(xml,/w:hanging="312"/);assert.match(xml,/<w:sz w:val="30"/);assert.match(xml,/<w:sz w:val="21"/);assert.match(xml,/新宋体/);assert.match(xml,/Times New Roman/);
  assert.match(xml,/<w:color w:val="0000FF"\/>/);assert.match(xml,/<w:vertAlign w:val="superscript"\/>/);assert.match(xml,/<m:f>/);assert.match(xml,/<m:rad>/);assert.match(xml,/<w:tbl>/);assert.match(xml,/<w:pageBreakBefore\/>/);assert.doesNotMatch(xml,/<wp:anchor|<w:framePr|<wps:txbx/);
  assert.match(xml,/<w:sz w:val="28"\/>/,'top-level fraction arguments retain the reference size');
  assert.match(plain,/a2\+b2＝4ab/,'the references use the narrow plus glyph in editable text math');
  const script=[...xml.matchAll(/<w:r>[\s\S]*?<\/w:r>/g)].find(r=>r[0].includes('w:val="superscript"'))?.[0];assert.match(script,/<w:sz w:val="24"\/>/,'all four references use 12 pt before Word reduces simple scripts');
  assert.match(xml,/<m:fPr><m:type m:val="bar"\/><m:ctrlPr><w:rPr><w:sz w:val="28"\/>/,'the fraction bar uses the same control size as the reference');
  for(const math of xml.matchAll(/<m:oMath\b[^>]*>[\s\S]*?<\/m:oMath>/g))assert.doesNotMatch(math[0],/w:eastAsia="Songti SC"/,'Chinese inside native equations uses the reference Chinese font as well');
  assert.doesNotMatch(xml,/<m:eqArr>/);assert.ok((xml.match(/<m:m>/g)||[]).length>=2,'nested cases retain separate native matrices');assert.ok((xml.match(/<m:mcJc m:val="left"/g)||[]).length>=2,'case rows keep the reference left alignment');
  assert.match(xml,/<m:bar>/,'a clearly matched filled blank keeps the standard underline even when OCR returns the value between underscores');assert.equal((plain.match(/_{2,}/g)||[]).length,1,'only the unanswered question retains literal underscores');
  const proof=[...xml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].find(p=>p[0].includes('>∵<'))?.[0];assert.ok(proof);assert.doesNotMatch(proof,/<m:oMath>/,'ordinary proof cues and a simple custom operator stay body-sized editable text');
  const padded=[...proof.matchAll(/<w:r>[\s\S]*?<\/w:r>/g)].map(m=>m[0]);assert.ok(padded.some(r=>r.includes('>　</w:t>')&&r.includes('<w:u ')),'native underlined spaces retain the source answer-slot width');assert.ok(padded.some(r=>r.includes('>6</w:t>')&&r.includes('<w:u ')));assert.ok(padded.some(r=>r.includes('>后续</w:t>')&&!r.includes('<w:u ')),'underline does not leak into following content');
  assert.doesNotMatch(plain,/&lt;\/?u|<\/?u>/,'provider underline tags never leak into printed content');assert.ok(padded.some(r=>r.includes('305')&&r.includes('<w:u ')),'recognized inline underline becomes an editable native underline');assert.match(xml,/<m:bar>[\s\S]*?<m:rad>/,'inline underline can contain native math as well');
  const footer=await zip.file('word/footer1.xml').async('string');assert.match(footer,/NUMPAGES/);assert.match(footer,/PAGE/);assert.deepEqual(draft,before);
  for(const part of ['word/styles.xml','word/theme/theme1.xml','word/fontTable.xml','word/footer1.xml','word/footnotes.xml','word/endnotes.xml'])assert.equal(await zip.file(part).async('string'),await source.file(part).async('string'),`${part} must be copied from the reference template unchanged`);
  assert.doesNotMatch(xml,/MP_DOCUMENT_|MP_TEMPLATE_/);assert.match(await zip.file('word/settings.xml').async('string'),/<w:updateFields w:val="true"/);
});
test('both studio exports preserve OMML, native geometry, media relationships and updated content',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mitty-studio-export-'));
  try {
    const output=join(dir,'export.cjs');
    await build({entryPoints:['lib/answer-studio-export.ts'],bundle:true,platform:'node',format:'cjs',packages:'external',alias:{docx:require.resolve('docx'),jszip:require.resolve('jszip')},external:[require.resolve('docx'),require.resolve('jszip')],outfile:output,logLevel:'silent'});
    const normalizer=join(dir,'normalize.cjs');
    await build({entryPoints:['lib/answer-studio-normalize.ts'],bundle:true,platform:'node',format:'cjs',outfile:normalizer,logLevel:'silent'});
    const {normalizeStudioTextFields}=require(normalizer);
    const {buildStudioWord,studioAnswerParagraphs}=require(output);
    assert.deepEqual(studioAnswerParagraphs('证明：(1)\n$x=2$\n（2）\n$y=3$'),[{text:'证明：',keepNext:true},{text:'(1) $x=2$',keepNext:false},{text:'（2） $y=3$',keepNext:false}]);
    assert.deepEqual(studioAnswerParagraphs('解：(1) 原文\n(2) 后文'),[{text:'解：',keepNext:true},{text:'(1) 原文',keepNext:false},{text:'(2) 后文',keepNext:false}]);
    const q={id:'q',lesson:'一',section:'例题精练',number:'3',stem:'原题 $\\angle A=90^\\circ$，$\\triangle ABC\\backsim\\triangle DEF$。',analysis:'第一步 $r=\\frac{5}{2}\\text{cm}$\n第二步 $S=\\pi r^2$',questionSources:[{pageId:'p',box:{x:0,y:0,width:100,height:100}}],answerIds:['a'],diagrams:[{id:'g',width:100,height:100,caption:'解答图',baseImage:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',warnings:[],shapes:[{id:'s',kind:'line',x:-10,y:0,width:100,height:100,weight:2,color:'#C00000',dash:true,text:'',points:[]}]}],warnings:[],resolutions:{},reviewed:true};
    const draft={version:1,title:'验证',pages:[],questions:[q],answers:[{id:'a'}]};
    for(const mode of ['full','answers']) {
      const zip=await JSZip.loadAsync(await (await buildStudioWord(draft,mode)).arrayBuffer()),xml=await zip.file('word/document.xml').async('string'),rels=await zip.file('word/_rels/document.xml.rels').async('string');
      assert.equal(xml.includes('>原题</w:t>'),mode==='full');assert.match(xml,/<m:f>/);assert.match(xml,/<v:line/);assert.match(xml,/第一步/);assert.match(xml,/第二步/);assert.doesNotMatch(xml,/<undefined>|STUDIO_DIAGRAM_|>circ<|>backsim<|>text</);
      for(const [,rid] of xml.matchAll(/<v:imagedata r:id="([^"]+)"/g)){assert.ok(rels.includes(`Id="${rid}"`));}
      assert.ok(Object.keys(zip.files).some(p=>p.startsWith('word/media/')));
      assert.match(await zip.file('word/settings.xml').async('string'),/<m:defJc m:val="left"\/>/);
      const paragraphs=[...xml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].map(m=>m[0]);
      const caption=paragraphs.find(p=>p.includes('解答图'));
      assert.match(caption,/<w:keepNext\b/,'caption must stay with its drawing');
      for(const p of paragraphs.filter(p=>/第一步|第二步/.test(p))) {
        assert.match(p,/<w:pPr>[\s\S]*?<w:rPr><w:color w:val="C00000"\/><\/w:rPr><\/w:pPr>/);
        for(const m of p.matchAll(/<m:r>[\s\S]*?<\/m:r>/g)) assert.match(m[0],/<w:color w:val="C00000"\/>/);
      }
      if(mode==='full')assert.match(xml,/<(?:m|w):t(?:\s[^>]*)?>°<\/(?:m|w):t>/);
    }
    q.analysis='已经修改 $x=2$\n$y=3$';
    for(const mode of ['full','answers']) {const zip=await JSZip.loadAsync(await (await buildStudioWord(draft,mode)).arrayBuffer());const xml=await zip.file('word/document.xml').async('string');assert.match(xml,/已经修改/);assert.doesNotMatch(xml,/第一步/);}
    q.answerOnly=true;q.stem='';q.questionSources=[];draft.inputMode='answers';
    await assert.rejects(()=>buildStudioWord(draft,'full'),/缺少原题文字/);
    const onlyZip=await JSZip.loadAsync(await (await buildStudioWord(draft,'answers')).arrayBuffer());
    assert.match(await onlyZip.file('word/document.xml').async('string'),/已经修改/);
    q.reviewed=false;await assert.rejects(()=>buildStudioWord(draft,'answers'));
    q.analysis='(1) $\\sin\\alpha=\\frac{1}{2}$\n(2) $\\begin{cases}x+y=3\\\\x-y=1\\end{cases}$\n$\\widehat{AB}=\\overparen{CD}$\n$EF\\xlongequal{//}CD$';
    const reviewZip=await JSZip.loadAsync(await(await buildStudioWord(draft,'answers',{reviewCopy:true})).arrayBuffer());
    const reviewXml=await reviewZip.file('word/document.xml').async('string');
    assert.match(reviewXml,/待校对样张/);assert.match(reviewXml,/不可作为完成稿/);assert.match(reviewXml,/<m:m>/);assert.match(reviewXml,/<m:acc>/);assert.match(reviewXml,/<m:limUpp>/);
    assert.match(reviewXml,/<m:sty m:val="p"\/>[\s\S]*?>sin<\/m:t>/);
    for(const r of reviewXml.matchAll(/<m:r>[\s\S]*?<\/m:r>/g))if(/<m:t[^>]*>[0-9]/.test(r[0]))assert.match(r[0],/<m:sty m:val="p"\/>/);
    assert.equal(q.reviewed,false);await assert.rejects(()=>buildStudioWord(draft,'answers'));
    q.analysis='证明：(1)\n$x=2$\n(2)\n$y=3$';
    q.diagrams[0].shapes.push({id:'label',kind:'label',x:5,y:5,width:40,height:20,weight:1,color:'#C00000',dash:false,text:'A12点',points:[]});
    const layoutZip=await JSZip.loadAsync(await(await buildStudioWord(draft,'answers',{reviewCopy:true})).arrayBuffer());
    const layoutXml=await layoutZip.file('word/document.xml').async('string');
    for(const label of ['证明：','(1)','(2)']) {
      const p=[...layoutXml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].find(m=>m[0].includes(`>${label}</w:t>`))?.[0];
      assert.ok(p);
      if(label==='证明：')assert.match(p,/<w:keepNext\b/);
      else {assert.doesNotMatch(p,/<w:tab\/>|<w:tabs>/);assert.ok(p.includes(`>${label}</w:t></w:r><w:r>`),'the label runs straight into its text');assert.match(p,/w:left="312"/);assert.doesNotMatch(p,/w:hanging=/);}
    }
    assert.match(layoutXml,/<w:i w:val="false"\/>[^]*?<w:t xml:space="preserve">12点<\/w:t>/);
    q.analysis='$\\sqrt{10}$';q.answerPlacements=[{kind:'blank',placeholder:'____',answer:q.analysis}];q.drawingsChecked=true;
    const shortZip=await JSZip.loadAsync(await(await buildStudioWord(draft,'answers',{transcription:true})).arrayBuffer());
    const shortXml=await shortZip.file('word/document.xml').async('string');
    assert.equal([...shortXml.matchAll(/<m:rad>/g)].length,1,'standalone short answers are not duplicated');
    assert.match(shortXml,/<m:bar>/,'the answer retains its native underline');
    // A model's missing placeholder used to fail the entire page. Both export
    // variants must retain the recovered answer as native math, not silently
    // drop it or guess where to insert it in the source question.
    const recovered=normalizeStudioTextFields({...q,answerOnly:false,stem:'结果____。',analysis:'教师原文证明',answerPlacements:[{kind:'blank',placeholder:'',answer:'$\\sqrt{10}$'}]});
    const recoveredDraft={...draft,inputMode:'paired',questions:[recovered]};
    for(const mode of ['full','answers']){
      const zip=await JSZip.loadAsync(await(await buildStudioWord(recoveredDraft,mode,{transcription:true})).arrayBuffer());
      const xml=await zip.file('word/document.xml').async('string');
      assert.match(xml,/教师原文证明/);assert.equal([...xml.matchAll(/<m:rad>/g)].length,1);
      assert.match(xml,/短答案填入位置不明确/);assert.match(xml,/<v:line/);
      if(mode==='full'){
        const stemParagraph=[...xml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].map(m=>m[0]).find(p=>p.includes('>结果'));
        assert.ok(stemParagraph);assert.doesNotMatch(stemParagraph,/<m:rad>/,'ambiguous placements must not insert the recovered answer into the source');
        assert.equal([...stemParagraph.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(m=>m[1]).join(''),'结果____。');
      }
    }
    recovered.analysis=String.raw`$\therefore \angle FED=\angle FAD$
$\phantom{\therefore \angle FED}=\angle FAE=\angle FDE$`;
    for(const mode of ['full','answers']){
      const zip=await JSZip.loadAsync(await(await buildStudioWord(recoveredDraft,mode,{transcription:true})).arrayBuffer());
      const xml=await zip.file('word/document.xml').async('string');
      assert.equal([...xml.matchAll(/<m:phant>/g)].length,1);
      assert.match(xml,/<m:phantPr><m:show m:val="0"\/><\/m:phantPr>/);
      assert.match(xml,/<m:phant>[\s\S]*?<w:color w:val="C00000"\/>/);
      assert.doesNotMatch(xml,/\\phantom|STUDIO_MATH_/);
    }
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('source pictures keep their place and print size from the original page; a printed question number stays one run',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'mitty-studio-figures-'));
  try {
    const output=join(dir,'export.cjs');
    await build({entryPoints:['lib/answer-studio-export.ts'],bundle:true,platform:'node',format:'cjs',packages:'external',alias:{docx:require.resolve('docx'),jszip:require.resolve('jszip')},external:[require.resolve('docx'),require.resolve('jszip')],outfile:output,logLevel:'silent'});
    const {buildStudioWord}=require(output);
    const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const figure=(id,pageId,box)=>({id,caption:'',baseImage:png,...(box?{baseSource:{pageId,box}}:{}),width:200,height:100,shapes:[],warnings:[]});
    const q={id:'q',lesson:'一',section:'例题精练',number:'2',stem:'2. 如图，求 $\\triangle ABC$ 的外接圆半径．',analysis:'略',answerIds:['a'],warnings:[],resolutions:{},reviewed:true,
      questionSources:[{pageId:'p',box:{x:100,y:100,width:800,height:600}}],
      diagrams:[
        figure('row-a','p',{x:450,y:300,width:200,height:100}),figure('row-b','p',{x:680,y:310,width:200,height:90}), // one printed row, ending at the right margin
        figure('centred','p',{x:400,y:450,width:200,height:100}),
        figure('left','p',{x:100,y:600,width:200,height:90}),
        figure('unplaced'),
        figure('other-page','p2',{x:700,y:100,width:200,height:100}),
        {...figure('tall','p',{x:500,y:700,width:400,height:200}),width:100,height:400},
      ]};
    const zip=await JSZip.loadAsync(await(await buildStudioWord({version:1,title:'配图',inputMode:'questions',pages:[],questions:[q],answers:[{id:'a'}]},'full')).arrayBuffer());
    const xml=await zip.file('word/document.xml').async('string');
    const rows=[...xml.matchAll(/<w:p(?:\s[^>]*)?>(?:(?!<w:p[ >])[\s\S])*?<v:group[\s\S]*?<\/w:p>/g)].map(m=>m[0]);
    assert.deepEqual(rows.map(p=>[p.match(/<w:jc w:val="(\w+)"\/>/)?.[1],(p.match(/<v:group /g)||[]).length]),[['right',2],['center',1],['left',1],['center',1],['center',1],['right',1]]);
    // A row keeps its share of the original line (a quarter each here, beside a 21 pt gap), a lone picture gets at least
    // 40% of the 466.3 pt line, an unplaced one keeps the compact size, and none is taller than 240 pt.
    const sizes=[...xml.matchAll(/<v:group id="studio\d+" style="width:([\d.]+)pt;height:([\d.]+)pt"/g)].map(m=>[Number(m[1]),Number(m[2])]);
    const line=466.3;
    for(const [[width],expected] of sizes.slice(0,6).map((size,i)=>[size,[(line-21)/4,(line-21)/4,line*.4,line*.4,130,130][i]]))assert.ok(Math.abs(width-expected)<.01,`${width} ≠ ${expected}`);
    assert.ok(Math.abs(sizes[6][1]-240)<.01&&sizes[6][0]<80,'a tall picture is capped at 240 pt high');
    assert.match(xml,/<w:t xml:space="preserve">2\.<\/w:t><\/w:r><w:r>(?:<w:rPr>(?:(?!<\/w:rPr>)[\s\S])*<\/w:rPr>)?<w:t xml:space="preserve">如图/,'the printed question number is one run, straight before its text');
    assert.match(rows[0],/<v:group [\s\S]*?<\/w:pict><\/w:r><w:r>(?:<w:rPr>[\s\S]*?<\/w:rPr>)?<w:t xml:space="preserve">\u3000\u3000<\/w:t><\/w:r><w:r><w:pict /,'pictures on one row sit side by side');
    for(const p of rows)assert.match(p,/<w:spacing w:line="360" w:lineRule="auto"\/>/);
    assert.doesNotMatch(xml,/STUDIO_DIAGRAM_/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
