import {before,after} from 'node:test';
import {readFileSync} from 'node:fs';
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
import katex from 'katex';
import { loadSource } from './load-source.mjs';
import {wordMathFractionDepth} from '../lib/word-math-sizing.mjs';
const nativeFetch=globalThis.fetch;
before(()=>{globalThis.fetch=(url,...args)=>url==='/standard-math-paper.docx'?Promise.resolve(new Response(readFileSync('public/standard-math-paper.docx'))):nativeFetch(url,...args);});
after(()=>{globalThis.fetch=nativeFetch;});
const require = createRequire(import.meta.url);

test('fractions in every cases row use body-size digits in inline and display math', async () => {
  const { renderKatex } = await loadSource('lib/math-render.ts');
  const systems = [
    String.raw`\begin{cases}3x+2y=5\\\frac{x+1}{3}-\frac{1-y}{5}=\frac{4}{15}\end{cases}`,
    String.raw`\begin{cases}\frac{2x-1}{3}-\frac{5x+1}{2}\ge1\\5x-1<3(x+1)\end{cases}`,
    String.raw`f(x)=\begin{cases}\frac{x+1}{3}&x>0\\0&x\le0\end{cases}`,
    String.raw`\begin {cases}x=\begin{cases}\frac{1}{2}\\3\end{cases}\\y=4\end {cases}`,
  ];
  for (const source of systems) for (const display of [false, true]) {
    const { html, error } = renderKatex(source, display);
    assert.equal(error, undefined);
    assert.match(html, /<mstyle scriptlevel="0" displaystyle="true">/);
    assert.doesNotMatch(html, /<mstyle scriptlevel="0" displaystyle="false">/);
    assert.doesNotMatch(html, /katex-sizing reset-size6 size3/, 'first-level fraction digits must not shrink');
    assert.equal((html.match(/<mfrac>/g) || []).length, (source.match(/\\frac\b/g) || []).length);
  }
});

test('cases sizing preserves genuine nested fractions, scripts and explicit compact fractions', async () => {
  const { renderKatex } = await loadSource('lib/math-render.ts');
  for (const source of [
    String.raw`\begin{cases}x^{2}+y_{1}=5\\\frac{x+1}{3}=2\end{cases}`,
    String.raw`\begin{cases}x=\frac{1+\frac{2}{3}}{4}\\y=5\end{cases}`,
    String.raw`\begin{cases}x=\frac{1}{2}\\y=\tfrac{3}{4}\end{cases}`,
  ]) {
    const { html, error } = renderKatex(source);
    assert.equal(error, undefined);
    assert.match(html, /katex-sizing reset-size6 size3/, 'scripts, inner fractions and tfrac retain smaller type');
    const expected = katex.renderToString('\\displaystyle ' + source.replaceAll('{cases}', '{dcases}'), {
      output: 'htmlAndMathml', strict: 'ignore', throwOnError: true,
    });
    assert.equal(html, expected, 'KaTeX calculates spacing and script sizes without CSS overrides');
  }
});

test('cases rendering leaves other environments, literals and syntax failures intact', async () => {
  const { renderKatex } = await loadSource('lib/math-render.ts');
  for (const source of [
    String.raw`\begin{cases}x=1\\y=2\end{cases}`,
    String.raw`\begin{cases}x=\dfrac{1}{2}\\y=\tfrac{3}{4}\end{cases}`,
    String.raw`\begin{bmatrix}\frac{1}{2}&3\\4&5\end{bmatrix}`,
    String.raw`\frac{1}{2}+\text{cases}+\verb|\begin{cases}|`,
  ]) {
    const expected = katex.renderToString((source.includes('\\frac') ? '\\displaystyle ' : '') + source, {
      output: 'htmlAndMathml', strict: 'ignore', throwOnError: true,
    });
    assert.equal(renderKatex(source).html, expected);
  }
  for (const source of [
    String.raw`\begin{cases}\frac{1}{2}\end{dcases}`,
    String.raw`\begin{dcases}\frac{1}{2}\end{cases}`,
    String.raw`\begin{cases}\frac{1}{2}`,
  ]) assert.ok(renderKatex(source).error, 'a style adjustment must not silently repair invalid environments');
});

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

test('generated Studio DOCX uses reference fraction sizing while preserving native nested math', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zhiti-word-sizing-'));
  try {
    const output = join(dir,'export.cjs');
    await build({entryPoints:['lib/answer-studio-export.ts'],bundle:true,platform:'node',format:'cjs',packages:'external',alias:{docx:require.resolve('docx'),jszip:require.resolve('jszip')},external:[require.resolve('docx'),require.resolve('jszip')],outfile:output,logLevel:'silent'});
    const {buildStudioWord} = require(output);
    const question = {id:'q',lesson:'Regression',section:'Examples',number:'1',stem:'$x=1$',analysis:String.raw`ordinary $\frac{1}{8}$; nested $\frac{\frac{5\sqrt{2}}{4}}{\frac{25}{2}}$; continued $1+\frac{1}{1+\frac{1}{1+\frac{1}{4x}}}$`,questionSources:[],answerIds:[],diagrams:[],warnings:[],resolutions:{},reviewed:true};
    const draft = {version:1,title:'Regression',pages:[],questions:[question],answers:[]};
    const blob = await buildStudioWord(draft,'answers',{reviewCopy:true});
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const xml = await zip.file('word/document.xml').async('string');
    const equations = [...xml.matchAll(/<m:oMath\b[^>]*>[\s\S]*?<\/m:oMath>/g)].map(m=>m[0]);
    assert.equal(equations.length,3);
    assert.equal([...equations[1].matchAll(/<m:f>/g)].length,3);
    assert.equal(wordMathFractionDepth(equations[2]),3);
    for(const equation of equations){
      assert.doesNotMatch(equation,/<w:sz w:val="(?:26|30)"\/>/);
      assert.equal((equation.match(/<m:ctrlPr>/g)||[]).length,(equation.match(/<m:f>/g)||[]).length,'every fraction retains the reference control size');
      assert.match(equation,/<m:ctrlPr><w:rPr><w:sz w:val="28"\/>/);
      let depth=0;
      for(const token of equation.matchAll(/<m:f>|<\/m:f>|<m:r>[\s\S]*?<\/m:r>/g)){
        if(token[0]==='<m:f>')depth++;else if(token[0]==='</m:f>')depth--;else assert.match(token[0],new RegExp(`<w:sz w:val="${depth?28:21}"/>`));
      }
    }
    assert.doesNotMatch(equations[1],/<w:sz w:val="21"\/>/,'nested fraction arguments use the same nominal size; Office handles script reduction');
    assert.doesNotMatch(xml,/<undefined>|\\frac|\\dfrac/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
