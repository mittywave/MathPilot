import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { repairMathSource, scanMathSource, splitMathParagraphs } from '../lib/math-source.mjs';
import { splitMathText } from '../lib/math-text-core.mjs';
const require=createRequire(import.meta.url);
const ts=require('typescript');

// Compile the actual pure implementation, without a model, browser or DOCX
// package mock. DOCX packer integration is covered in the companion test.
const dir=await mkdtemp(join(tmpdir(),'zhiti-word-math-'));
for(const name of ['math-grid','math-omml','xml-text','math-text','studio-math-layout']) {
  const file=new URL(`../lib/${name}.ts`,import.meta.url);
  const source=await readFile(file,'utf8');
  const result=ts.transpileModule(source,{fileName:file.pathname,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}});
  await writeFile(join(dir,name+'.js'),result.outputText);
}
for(const name of ['math-capabilities.mjs','math-notation.mjs','math-text-core.mjs','math-source.mjs']) await writeFile(join(dir,name),await readFile(new URL('../lib/'+name,import.meta.url)));
// Unit-test the actual escape-normalization function without importing the
// unrelated question database/types module or duplicating its implementation.
const normalizerSource=await readFile(new URL('../lib/answer-studio-normalize.ts',import.meta.url),'utf8');
const ast=ts.createSourceFile('normalize.ts',normalizerSource,ts.ScriptTarget.Latest,true);
const declaration=ast.statements.find(s=>ts.isFunctionDeclaration(s)&&s.name?.text==='normalizeStudioMathEscapes');
const normalizer=ts.transpileModule('import {normalizeProseLineBreaks,repairMathSource,restoreDecodedCommands,scanMathSource} from "./math-source.mjs";\n'+declaration.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
await writeFile(join(dir,'normalize.js'),normalizer);
const {normalizeStudioMathEscapes}=require(join(dir,'normalize.js'));
const {mathOmml}=require(join(dir,'math-omml.js'));
const {studioWordEquationXml,studioWordDisplayXml,isStudioDisplayMathLine,studioMathIssues}=require(join(dir,'studio-math-layout.js'));
test.after(()=>rm(dir,{recursive:true,force:true}));

const system=String.raw`\begin{cases}a_{1}=4\\d=2\end{cases}`;
test('mixed display boundaries become balanced inline proof spans without changing content',()=>{
  for(const [source,expected] of [
    [String.raw`$$\therefore P$、$O$、$F$ 三点共线 $\therefore PF \perp BC$$`,String.raw`$\therefore P$、$O$、$F$ 三点共线 $\therefore PF \perp BC$`],
    [String.raw`$$\therefore CD$、$AO$的交点$G$为$\triangle ABC$的重心`,String.raw`$\therefore CD$、$AO$的交点$G$为$\triangle ABC$的重心`],
    [String.raw`$$\therefore \text{易知 }D$、$E$是$\widehat{AB}$中点`,String.raw`$\therefore \text{易知 }D$、$E$是$\widehat{AB}$中点`],
  ]){
    const field=`$x=1$\n${source}\n$$y=2$$`;
    const repaired=repairMathSource(field);
    assert.equal(repaired,`$x=1$\n${expected}\n$$y=2$$`);
    assert.equal(repairMathSource(repaired),repaired);
    assert.deepEqual(studioMathIssues(repaired),[]);
    assert.equal(repaired.replaceAll('$',''),field.replaceAll('$',''));
  }
});
test('mixed-marker recovery preserves valid multiline formulas, code, currency and ambiguous prose',()=>{
  const fenced='```latex\n'+String.raw`$$\therefore CD$与$AB$垂直`+'\n```';
  assert.equal(repairMathSource(fenced),fenced);
  for(const source of ['$$\nx=1\ny=2\n$$',String.raw`$$\text{price $5 and $10}+x$$`,String.raw`\verb|$$\therefore A$和$B$|`,'`$$x=1$a$b$`','$$price $5 and $10 and $20','$$\\therefore 中文$x$+y$'])assert.equal(repairMathSource(source),source);
});
test('arc and checkmark commands produce editable Word math',()=>{
  assert.equal(mathOmml(String.raw`\wideparen{BC}`),mathOmml(String.raw`\overparen{BC}`));
  assert.match(mathOmml(String.raw`\wideparen{BC}`),/<m:acc>/);
  assert.match(mathOmml(String.raw`\checkmark`),/>✓<\/m:t>/);
});
for(const [input,expected] of [
  [`$${system}$$$`,`$${system}$`],
  [`$$$${system}$$$`,`$$${system}$$`],
  ['$x=1$$','$x=1$'],['$$x=1$','$$x=1$$'],['$x=1','$x=1$'],
  ['$$\nx=1\n$$$','$$\nx=1\n$$'],
]) test(`repairs only a clear mathematical pair: ${JSON.stringify(input)}`,()=>{
  assert.equal(repairMathSource(input),expected);
  assert.equal(repairMathSource(expected),expected,'idempotent');
  assert.deepEqual(scanMathSource(expected).issues,[]);
});
test('preserves prefix and all mathematical content around the damaged cases block',()=>{
  const text=`\u7531\u2460,\u2461$ \\Rightarrow ${system}$$$`;
  const fixed=repairMathSource(text);
  assert.equal(fixed,`\u7531\u2460,\u2461$ \\Rightarrow ${system}$`);
  assert.deepEqual(studioMathIssues(fixed),[]);
  assert.doesNotMatch(studioWordDisplayXml(fixed),/Rightarrow|\$/);
});
for(const source of [
  String.raw`cost \$5 and \$10`, 'price $5', 'price $5 and $10',
  String.raw`\text{C:\\folder and \$5}`, String.raw`\verb|\\Rightarrow|`,
  String.raw`example: \text{\\Rightarrow}`, '`\\\\Rightarrow`',
  String.raw`C:\\Rightarrow\folder`,
  String.raw`\begin{aligned}a&=1\\beta&=2\end{aligned}`,
  String.raw`\begin{cases}x=1\\\Rightarrow y=2\end{cases}`,
]) test(`does not damage protected source: ${JSON.stringify(source)}`,()=>assert.equal(repairMathSource(source),source));
test('repairs escaped arrows between cases without damaging either row separator',()=>{
  const source=system+String.raw`\\Rightarrow`+system+String.raw`\\Rightarrow`;
  assert.equal(repairMathSource(source),system+String.raw`\Rightarrow`+system+String.raw`\Rightarrow`);
  const xml=mathOmml(repairMathSource(source));
  assert.equal((xml.match(/<m:eqArr>/g)||[]).length,2);
  assert.equal((xml.match(/\u21d2/g)||[]).length,2);
  assert.doesNotMatch(xml,/Rightarrow/);
});
test('unknown or genuinely ambiguous dollar syntax remains visible and is diagnosed',()=>{
  for(const s of ['before $\\frac{1}{2', '$$not clear$$$', 'before \\[x=1']) {
    assert.equal(repairMathSource(s),s);
    assert.ok(studioMathIssues(s).length);
  }
});
test('scanner handles adjacent inline math and escaped dollars inside text',()=>{
  const s=String.raw`$x=1$$y=2$ and $\text{price \$5}+x$`;
  assert.deepEqual(scanMathSource(s).ranges.map(r=>r.value),['x=1','y=2',String.raw`\text{price \$5}+x`]);
  assert.equal(splitMathText(s).filter(s=>s.kind==='math').length,3);
});
test('multiline display environments stay intact through paragraph splitting',()=>{
  const block='$$\n'+String.raw`\begin{cases}`+'\n'+String.raw`a_1=4\\`+'\n'+String.raw`d=2\end{cases}`+'\n$$';
  const parts=splitMathParagraphs(`before\n${block}\nafter`).filter(s=>s.trim());
  assert.deepEqual(parts,['before',block,'after']);
  assert.deepEqual(studioMathIssues(block),[]);
});
test('display equations embedded between prose are separate blocks, with no lost text',()=>{
  assert.deepEqual(splitMathParagraphs('before $$x=1$$ after'),['before ','$$x=1$$',' after']);
});
for(const name of ['R','N','Z','Q','C']) test(`mathbb ${name} is native double-struck math, not an image or fallback`,()=>{
  const xml=mathOmml(`\\mathbb{${name}}`);
  assert.match(xml,/<m:scr m:val="double-struck"\/>/);
  assert.match(xml,new RegExp(`>${({R:"\u211D",N:"\u2115",Z:"\u2124",Q:"\u211A",C:"\u2102"})[name]}</m:t>`));
  assert.doesNotMatch(xml,/mathbb|drawing|pict/);
  assert.deepEqual(studioMathIssues(`$\\mathbb{${name}}$`),[]);
});
test('double-struck style is scoped to its group; ordinary variables remain italic',()=>{
  const xml=mathOmml(String.raw`\mathbb{R}+x`);
  assert.equal((xml.match(/double-struck/g)||[]).length,1);
  assert.match(xml,/<m:sty m:val="i"\/><\/m:rPr><m:t xml:space="preserve">x<\/m:t>/);
});
test('mathbb with subscripts and superscripts retains one correctly paired base',()=>{
  const xml=mathOmml(String.raw`\mathbb{R}_{+}^{2}`);
  assert.match(xml,/<m:sSubSup>/);
  assert.match(xml,/<m:sub>/);assert.match(xml,/<m:sup>/);
  assert.equal((xml.match(/double-struck/g)||[]).length,1);
});
test('k CD has both letters in the same subscript, even inside a fraction',()=>{
  const xml=mathOmml(String.raw`\frac{\frac{1}{2}k_{CD}}{1+\frac{1}{2}k_{CD}}`);
  const subs=[...xml.matchAll(/<m:sub>([\s\S]*?)<\/m:sub>/g)].map(m=>m[1]);
  assert.equal(subs.length,2);
  for(const sub of subs){assert.match(sub,/>C<\/m:t>/);assert.match(sub,/>D<\/m:t>/);}
});
test('does not guess a missing multi-letter subscript grouping',()=>{
  const xml=mathOmml('k_CD');
  const sub=xml.match(/<m:sub>([\s\S]*?)<\/m:sub>/)[1];
  assert.match(sub,/>C<\/m:t>/);assert.doesNotMatch(sub,/>D<\/m:t>/);
});
for(const command of ['frac','dfrac','tfrac']) test(`native ${command} remains editable with no font-depth heuristic`,()=>{
  const xml=studioWordEquationXml(`\\${command}{1}{\\frac{1}{2}}`,true);
  assert.match(xml,/^<m:oMathPara>/);
  assert.equal((xml.match(/<m:f>/g)||[]).length,2);
  assert.ok([...xml.matchAll(/<w:sz w:val="(\d+)"\/>/g)].every(m=>m[1]==='22'));
});
test('plain and complex display lines share one 11 pt base size',()=>{
  for(const value of [String.raw`k_{CD}=-\frac{1}{2}`,String.raw`\frac{\frac12 k_{CD}}{1+\frac12 k_{CD}}=\frac43`]) {
    const xml=studioWordEquationXml(value,true);
    assert.match(xml,/<w:sz w:val="22"\/>/);
    assert.doesNotMatch(xml,/<w:sz w:val="(?:24|26|30)"\/>/);
  }
  const inline=studioWordEquationXml(String.raw`\mathbb{R}`,false);
  assert.match(inline,/^<m:oMath>/);assert.match(inline,/<w:sz w:val="22"\/>/);
});
test('proof cues do not shrink a complex calculation; prose stays inline',()=>{
  assert.equal(isStudioDisplayMathLine(String.raw`\u53ef $\frac{a}{b}=2$`.replace('\\u53ef','\u53ef')),true);
  assert.equal(isStudioDisplayMathLine('$k_{CD}=-1$'),true);
  assert.equal(isStudioDisplayMathLine('\u6545 $f(x)$ \u4e3a $\\mathbb{R}$ \u4e0a\u7684\u589e\u51fd\u6570'),false);
});
test('XML output escapes literal proof text and rejects invalid color properties',()=>{
  assert.match(studioWordDisplayXml('$x<2$',{color:'C00000'}),/x|&lt;/);
  assert.throws(()=>studioWordEquationXml('x',false,{color:'"/><bad/>'}));
});
test('unknown math commands remain explicit errors, never silently discarded',()=>{
  assert.throws(()=>mathOmml(String.raw`\unknown{R}`),/unknown/);
  assert.throws(()=>mathOmml('$x=1$'),/delimiter/);
});

test('normalization preserves literal dollars and codes, not only the low-level sanitizer',()=>{
  for(const text of [String.raw`$\text{price \$5}+x$`,String.raw`$\begin{aligned}a&=1\\beta&=2\end{aligned}$`,String.raw`$\text{C:\\folder}$`]) {
    assert.equal(normalizeStudioMathEscapes(text),text);
  }
});
test('normalization repairs known control characters without changing prose tabs',()=>{
  assert.equal(normalizeStudioMathEscapes('text\tkeep $\frac{1}{2}$'),String.raw`text`+'\t'+String.raw`keep $\frac{1}{2}$`);
});
test('normalization fixes the screenshot dollar pattern and bare escaped arrows together',()=>{
  const raw=`\u7531\u2460,\u2461$ \\\\Rightarrow ${system}$$$`;
  const text=normalizeStudioMathEscapes(raw);
  assert.equal(text,`\u7531\u2460,\u2461$ \\Rightarrow ${system}$`);
  assert.equal(normalizeStudioMathEscapes(text),text);
  assert.deepEqual(studioMathIssues(text),[]);
});
