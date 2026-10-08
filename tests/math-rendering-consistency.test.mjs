import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import JSZip from 'jszip';
const require = createRequire(import.meta.url);

test('both web renderers share explicit math styles and expose parse failures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zhiti-math-render-'));
  try {
    const output = join(dir, 'render.cjs');
    await build({stdin:{contents:`
      export { MathText as MainMath } from './app/components/MathText';
      export { MathText as StudioMath } from './app/components/StudioMathText';
      export { splitMathText as mainParser } from './lib/math-text';
      export { splitMathText as studioParser } from './lib/answer-studio-math-text';
    `,resolveDir:process.cwd(),sourcefile:'math-render-contract.ts'},bundle:true,platform:'node',format:'cjs',jsx:'automatic',outfile:output,logLevel:'silent'});
    const {MainMath,StudioMath,mainParser,studioParser} = require(output);
    assert.equal(MainMath,StudioMath);
    assert.equal(mainParser,studioParser);
    const text = String.raw`inline $\frac{1}{8}$; $$\frac{\frac{5\sqrt{2}}{4}}{\frac{25}{2}}$$`;
    const html = renderToStaticMarkup(createElement(MainMath,{text}));
    assert.equal(html,renderToStaticMarkup(createElement(StudioMath,{text})));
    assert.match(html,/data-math-display="inline"/);
    assert.match(html,/data-math-display="block"/);
    assert.match(html,/katex-display/);
    assert.doesNotMatch(html,/math-fraction-nested|math-fraction-deep|\\dfrac/);
    const broken = renderToStaticMarkup(createElement(MainMath,{text:String.raw`$\frac{1}{$`}));
    assert.match(broken,/math-render-error/);
    assert.match(broken,/math-error-label/);
    assert.ok(broken.includes('frac'), 'failed source is retained for correction');
    const recovered = renderToStaticMarkup(createElement(MainMath,{text:String.raw`关于直线$l$对称.\n（2）点$C$的坐标为$(6,0)$，满足$S_{\triangle POA}=S_{\triangle PBC}$`}));
    assert.doesNotMatch(recovered,/math-render-error|公式待核对|\\n/);
    assert.match(recovered.replace(/<[^>]*>/g,''),/对称\.\n（2）点/);
    assert.match(recovered,/katex/);
    assert.match(renderToStaticMarkup(createElement(MainMath,{text:String.raw`$\n$`})),/math-render-error/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('generated Studio DOCX retains native nested math without forced font sizes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zhiti-word-sizing-'));
  try {
    const output = join(dir,'export.cjs');
    await build({entryPoints:['lib/answer-studio-export.ts'],bundle:true,platform:'node',format:'cjs',packages:'external',alias:{docx:require.resolve('docx'),jszip:require.resolve('jszip')},external:[require.resolve('docx'),require.resolve('jszip')],outfile:output,logLevel:'silent'});
    const {buildStudioWord} = require(output);
    const question = {id:'q',lesson:'Regression',section:'Examples',number:'1',stem:'$x=1$',analysis:String.raw`ordinary $\frac{1}{8}$; nested $\frac{\frac{5\sqrt{2}}{4}}{\frac{25}{2}}$`,questionSources:[],answerIds:[],diagrams:[],warnings:[],resolutions:{},reviewed:true};
    const draft = {version:1,title:'Regression',pages:[],questions:[question],answers:[]};
    const blob = await buildStudioWord(draft,'answers',{reviewCopy:true});
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const xml = await zip.file('word/document.xml').async('string');
    const equations = [...xml.matchAll(/<m:oMath\b[^>]*>[\s\S]*?<\/m:oMath>/g)].map(m=>m[0]);
    assert.equal(equations.length,2);
    assert.equal([...equations[1].matchAll(/<m:f>/g)].length,3);
    for(const equation of equations) assert.doesNotMatch(equation,/<w:sz w:val="(?:26|30)"\/>|<m:ctrlPr>/);
    assert.doesNotMatch(xml,/<undefined>|\\frac|\\dfrac/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
