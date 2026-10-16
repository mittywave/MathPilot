import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import JSZip from 'jszip';
const require=createRequire(import.meta.url);
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
      for(const p of paragraphs.filter(p=>p.includes('w:val="StudioAnswer"'))) {
        assert.match(p,/<w:pPr>[\s\S]*?<w:rPr><w:color w:val="C00000"\/><\/w:rPr><\/w:pPr>/);
        for(const m of p.matchAll(/<m:r>[\s\S]*?<\/m:r>/g)) assert.match(m[0],/<w:color w:val="C00000"\/>/);
      }
      if(mode==='full')assert.match(xml,/<m:t(?:\s[^>]*)?>°<\/m:t>/);
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
    assert.match(reviewXml,/待校对样张/);assert.match(reviewXml,/不可作为完成稿/);assert.match(reviewXml,/<m:eqArr>/);assert.match(reviewXml,/<m:acc>/);assert.match(reviewXml,/<m:limUpp>/);
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
      else {assert.doesNotMatch(p,/<w:tab\/>|<w:tabs>/);assert.ok(p.includes(`>${label}</w:t></w:r><m:oMath`),'the label runs straight into its text');assert.match(p,/w:hanging="420"/);}
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
    // A row keeps its share of the original line (a quarter each here, beside a 22 pt gap), a lone picture gets at least
    // 40% of the 487.3 pt line, an unplaced one keeps the compact size, and none is taller than 240 pt.
    const sizes=[...xml.matchAll(/<v:group id="studio\d+" style="width:([\d.]+)pt;height:([\d.]+)pt"/g)].map(m=>[Number(m[1]),Number(m[2])]);
    const line=487.3;
    for(const [[width],expected] of sizes.slice(0,6).map((size,i)=>[size,[(line-22)/4,(line-22)/4,line*.4,line*.4,130,130][i]]))assert.ok(Math.abs(width-expected)<.01,`${width} ≠ ${expected}`);
    assert.ok(Math.abs(sizes[6][1]-240)<.01&&sizes[6][0]<80,'a tall picture is capped at 240 pt high');
    assert.match(xml,/<w:t xml:space="preserve">2\.<\/w:t><\/w:r><w:r>(?:<w:rPr>(?:(?!<\/w:rPr>)[\s\S])*<\/w:rPr>)?<w:t xml:space="preserve">如图/,'the printed question number is one run, straight before its text');
    assert.match(rows[0],/<v:group [\s\S]*?<\/w:pict><\/w:r><w:r><w:t xml:space="preserve">\u3000\u3000<\/w:t><\/w:r><w:r><w:pict /,'pictures on one row sit side by side');
    for(const p of rows)assert.match(p,/<w:spacing (?=[^>]*w:before="100")(?=[^>]*w:after="140")[^>]*\/>/);
    assert.doesNotMatch(xml,/STUDIO_DIAGRAM_/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
