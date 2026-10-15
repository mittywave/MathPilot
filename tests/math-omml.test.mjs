import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import fs from 'node:fs/promises';
const compiled=await build({entryPoints:['lib/math-omml.ts'],bundle:true,write:false,format:'esm',platform:'node'});
const {mathOmml}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const splitBuild=await build({entryPoints:['lib/answer-studio-math-text.ts'],bundle:true,write:false,format:'esm',platform:'node'});
const {splitMathText}=await import('data:text/javascript;base64,'+Buffer.from(splitBuild.outputFiles[0].text).toString('base64'));
const normalizeBuild=await build({entryPoints:['lib/answer-studio-normalize.ts'],bundle:true,write:false,format:'esm',platform:'node'});
const {normalizeStudioMathEscapes,normalizeStudioTextFields}=await import('data:text/javascript;base64,'+Buffer.from(normalizeBuild.outputFiles[0].text).toString('base64'));
test('native math retains fractions in scripts and roots, systems, arcs and parallel-equal notation',()=>{
  assert.match(mathOmml(String.raw`x^{\frac{1}{2}}+\sqrt[3]{\frac{a}{b}}`),/<m:sSup>[\s\S]*<m:f>/);
  assert.match(mathOmml(String.raw`\begin{cases}x+y=3\\x-y=1\end{cases}`),/<m:eqArr>/);
  assert.match(mathOmml(String.raw`\overparen{AB}`),/<m:chr m:val="⏜"/);
  assert.match(mathOmml(String.raw`\widehat{AB}`),/<m:acc>/);
  assert.match(mathOmml(String.raw`AB\xlongequal{//}CD`),/<m:limUpp>/);
  assert.match(mathOmml(String.raw`AB\underline{\parallel}CD`),/<m:bar>/);
});
test('digits, function names and explicit text are upright while variables remain italic',()=>{
  const xml=mathOmml(String.raw`12x+\sin\alpha+\text{cm}`);
  for(const r of xml.matchAll(/<m:r>[\s\S]*?<\/m:r>/g)) {
    const t=r[0].match(/<m:t[^>]*>(.*?)<\/m:t>/)[1];
    assert.match(r[0],new RegExp(`m:val="${['x','α'].includes(t)?'i':'p'}"`));
  }
});
test('unsupported and malformed math fails closed',()=>{
  for(const source of [String.raw`\unknown{x}`,String.raw`\frac{1}`,String.raw`\sqrt{2`,String.raw`\begin{unsupported}x\end{unsupported}`,`x${'\\'}`])assert.throws(()=>mathOmml(source));
});
test('overgroup accents and bigodot retain distinct native mathematical symbols',()=>{
  const xml=mathOmml(String.raw`\overgroup{AB}+\overparen{CD}+\bigodot O+\odot P`);
  assert.match(xml,/<m:acc><m:accPr><m:chr m:val="⏠"\/><\/m:accPr><m:e>/);
  assert.match(xml,/<m:chr m:val="⏜"/);
  assert.match(xml,/>⨀<\/m:t>/);assert.match(xml,/>⊙<\/m:t>/);
  assert.doesNotMatch(xml,/overgroup|bigodot|<w:drawing|<v:/);
  assert.throws(()=>mathOmml(String.raw`\overgroup`));
  assert.throws(()=>mathOmml(String.raw`\overgroup{AB`));
});
test('OCR nequiv typo is normalized to the intended parallel symbol',async()=>{
  const normalized=normalizeStudioMathEscapes(String.raw`$NE \nequiv BC$`);
  assert.equal(normalized,String.raw`$NE \parallel BC$`);
  assert.match(mathOmml(splitMathText(normalized).find(s=>s.kind==='math').value),/>∥<\/m:t>/);
});
test('doubly escaped newlines between transcribed choices become real lines with native formulas',()=>{
  // A whole page of model output arrived with \\n instead of \n; \nA then failed Word export as a command.
  const stem=String.raw`假设$-1<x<0$，那么$\sqrt{x^2}-\sqrt{(x+1)^2}$等于( )\n\nA. -1\nB. 1\nC. $-2x-1$\nD. $-2x+1$`;
  const record=normalizeStudioTextFields({stem,analysis:String.raw`选D.\n【点评】本题考查二次根式，$a\neq b$。`,warnings:[]});
  assert.equal(record.stem,'假设$-1<x<0$，那么$\\sqrt{x^2}-\\sqrt{(x+1)^2}$等于( )\n\nA. -1\nB. 1\nC. $-2x-1$\nD. $-2x+1$');
  assert.equal(record.analysis,'选D.\n【点评】本题考查二次根式，$a\\neq b$。');
  assert.deepEqual(record.warnings,[],'no formula warnings reach the Word file');
  for(const line of record.stem.split('\n'))for(const segment of splitMathText(line).filter(s=>s.kind==='math'))assert.doesNotThrow(()=>mathOmml(segment.value),line);
  assert.equal(normalizeStudioMathEscapes(record.stem),record.stem);
});
test('S9 winter answer export fixture keeps every reported math form native',async()=>{
  const fixture=JSON.parse(await fs.readFile(new URL('./fixtures/answer-studio-s9-math.json',import.meta.url),'utf8'));
  for(const sample of fixture.samples){
    const normalized=normalizeStudioMathEscapes(sample.text);
    for(const segment of splitMathText(normalized).filter(s=>s.kind==='math')){
      assert.doesNotThrow(()=>mathOmml(segment.value),`paragraph ${sample.index} should remain editable math`);
    }
    // eslint-disable-next-line no-control-regex -- verify that repaired output contains no XML-invalid backspace
    assert.doesNotMatch(normalized,/\x08/,'illegal XML control must not survive');
  }
  assert.match(mathOmml(String.raw`\boldsymbol\times`),/>×<\/m:t>/);
  assert.match(mathOmml(String.raw`\text{√}{5}`),/<m:rad>/);
});
test('geometry square point-name markers become editable parallelogram symbols',()=>{
  for(const source of [String.raw`$∵□ABCD$`,String.raw`$∴\\square BNCG\\Rightarrow CG=BN$`]){
    const normalized=normalizeStudioMathEscapes(source);
    assert.match(mathOmml(normalized.slice(1,-1)),/>▱<\/m:t>/);
  }
  assert.doesNotMatch(normalizeStudioMathEscapes(String.raw`$□1234$`),/parallelogram/);
});
test('phantom alignment remains hidden native math and retains its dimensions',()=>{
  const xml=mathOmml(String.raw`\phantom{\therefore \angle FED}=\angle FAE`);
  assert.match(xml,/<m:phant><m:phantPr><m:show m:val="0"\/><\/m:phantPr><m:e>/);
  assert.doesNotMatch(xml,/zeroWid|zeroAsc|zeroDesc/);
  assert.match(xml,/<\/m:phant><m:r>[\s\S]*?>=<\/m:t>/,'following equation must remain visible');
  assert.match(mathOmml(String.raw`\hphantom{\frac{1}{2}}`),/<m:zeroAsc m:val="1"\/><m:zeroDesc m:val="1"\/>/);
  assert.match(mathOmml(String.raw`\vphantom{\sqrt{2}}`),/<m:zeroWid m:val="1"\/>/);
  assert.throws(()=>mathOmml(String.raw`\phantom{\frac{1}}`));
  assert.throws(()=>mathOmml(String.raw`\phantom`));
});
test('undelimited OCR LaTeX retains Chinese braced text as one parseable line',()=>{
  const source=String.raw`x \geqslant -\frac{1}{2} \text{且} x \neq 0`;
  const segments=splitMathText(source);
  assert.equal(segments.length,1);assert.equal(segments[0].value,source);assert.doesNotThrow(()=>mathOmml(segments[0].value));
  assert.ok(splitMathText('文字 $x=1$，后续文字').some(s=>s.kind==='text'&&s.value.includes('后续')));
});
