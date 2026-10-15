import assert from 'node:assert/strict';
import test from 'node:test';
import katex from 'katex';
import { normalizeProseLineBreaks } from '../lib/math-source.mjs';
import { splitMathText, splitMathLines, plainTextWebLines, toReadableNestedFractionLatex, toLatexMath, latexFractionDepth } from '../lib/math-text-core.mjs';
import { fullSizeInlineFractions, wordMathFractionDepth, ensureWordMathSettings } from '../lib/word-math-sizing.mjs';

const math = text => splitMathText(text, { autoDetect: false }).filter(s => s.kind === 'math');
for (const [open, close, display] of [['$', '$', false], ['$$', '$$', true], ['\\(', '\\)', false], ['\\[', '\\]', true]]) {
  test(`retains ${open} math style without modifying LaTeX`, () => {
    const formula = String.raw`\frac{a_{n}}{2^{n}}=1+(n-1)\times\frac{3}{2}`;
    assert.deepEqual(math(`before ${open}${formula}${close} after`), [{ kind: 'math', value: formula, explicit: true, display }]);
  });
}
test('mixed inline and display delimiters retain their order and mode', () => {
  assert.deepEqual(math('$a$ $$b$$ \\(c\\) \\[d\\]').map(s => [s.value, s.display]), [['a',false],['b',true],['c',false],['d',true]]);
});
test('escaped dollars are literal and do not swallow later formulas', () => {
  const segments = splitMathText(String.raw`cost \$5; $x=2$; \$10`, {autoDetect:false});
  assert.deepEqual(segments.filter(s=>s.kind==='math').map(s=>s.value), ['x=2']);
  assert.equal(segments.map(s=>s.value).join(''), 'cost $5; x=2; $10');
});
test('escaped dollar inside a text command is not a closing delimiter', () => {
  assert.equal(math(String.raw`$\text{cost \$5}+x$`)[0].value, String.raw`\text{cost \$5}+x`);
});
test('backslash parity does not open an escaped parenthesis delimiter', () => {
  assert.deepEqual(math(String.raw`\\(literal\\)`), []);
});
test('math boundaries do not split Chinese text inside LaTeX braces', () => {
  const source = String.raw`\frac{1}{2}\text{` + '\u5398\u7c73' + '}';
  assert.equal(splitMathText(source).length, 1);
  assert.equal(splitMathText(source)[0].value, source);
});
test('strict mode leaves undelimited expressions untouched', () => {
  assert.deepEqual(splitMathText('A-B and x=2', {autoDetect:false}), [{kind:'text',value:'A-B and x=2'}]);
});
test('legacy Unicode equations and fill-in blanks remain supported', () => {
  const source = 'y\uff1dax\u00b2\uff0bbx\uff0bc\uff08a\uff0cb\uff0cc \u4e3a\u5e38\u6570\uff09 ____';
  const segments = splitMathText(source);
  assert.equal(segments.map(s=>s.value).join(''), source);
  assert.ok(segments.some(s=>s.kind==='math' && s.value==='y\uff1dax\u00b2\uff0bbx\uff0bc'));
  assert.ok(segments.some(s=>s.kind==='text' && s.value==='____'));
});
test('multiline display math stays whole while surrounding prose splits', () => {
  const formula = '$$\n\\begin{aligned}\na&=1\\\\\nb&=2\n\\end{aligned}\n$$';
  assert.deepEqual(splitMathLines(`before\n${formula}\nafter`), ['before',formula,'after']);
  assert.equal(math(formula)[0].display, true);
  assert.equal(plainTextWebLines(formula).length, 1);
  assert.equal(plainTextWebLines(formula)[0].align, 'center');
});
test('CRLF and surrounding blank lines are preserved without splitting formulas', () => {
  assert.deepEqual(splitMathLines('a\r\n\r\n\\[x\r\n+y\\]\r\nb'), ['a','','\\[x\r\n+y\\]','b']);
});
test('unclosed delimiters are preserved for correction, never discarded', () => {
  for (const source of ['$x', '$$x', '\\(x', '\\[x']) {
    assert.equal(splitMathText(source,{autoDetect:false}).map(s=>s.value).join(''), source);
  }
});
test('empty input and prose-only input are safe', () => {
  assert.deepEqual(splitMathText(''), []);
  assert.deepEqual(splitMathLines(''), ['']);
  assert.deepEqual(splitMathLines('a\nb'), ['a','b']);
});
for (const source of [String.raw`\frac{1}{8}`, String.raw`\frac{\frac{5\sqrt{2}}{4}}{\frac{25}{2}}`, String.raw`1+\frac{1}{1+\frac{1}{1+\frac{1}{4x}}}`, String.raw`\dfrac{1}{1+\tfrac{1}{x}}`]) {
  test(`does not promote nested fraction style: ${source}`, () => {
    assert.equal(toReadableNestedFractionLatex(source), source);
  });
}
test('fraction depth remains diagnostic, not a sizing policy', () => {
  assert.equal(latexFractionDepth(String.raw`\frac{\frac{1}{2}}{\frac{3}{4}}`), 2);
  assert.equal(toLatexMath('x\u00b2\uff0by\uff1d0'), 'x^{2}+y=0');
});
test('Word sets only the top-level fraction of an inline equation one size up, as printed papers read', () => {
  const run = value => `<m:r><m:t>${value}</m:t></m:r>`;
  const frac = (num,den) => `<m:f><m:num>${num}</m:num><m:den>${den}</m:den></m:f>`;
  const sized = value => `<m:r><w:rPr><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr><m:t>${value}</m:t></m:r>`;
  assert.equal(fullSizeInlineFractions(`<m:oMath>${run('-')}${frac(run('1'),run('3'))}</m:oMath>`), `<m:oMath>${run('-')}${frac(sized('1'),sized('3'))}</m:oMath>`);
  // The fraction inside keeps Word's own step down.
  assert.equal(fullSizeInlineFractions(`<m:oMath>${frac(run('1'),`${run('1+')}${frac(run('1'),run('x'))}`)}</m:oMath>`), `<m:oMath>${frac(sized('1'),`${sized('1+')}${frac(run('1'),run('x'))}`)}</m:oMath>`);
  // Display equations are already full size.
  const display = `<m:oMathPara><m:oMath>${frac(run('1'),run('2'))}</m:oMath></m:oMathPara>`;
  assert.equal(fullSizeInlineFractions(display), display);
  for (let depth=1;depth<=4;depth++) {
    let body=run('x');
    for(let i=0;i<depth;i++)body=frac(run('1'),body);
    assert.equal(wordMathFractionDepth(`<w:p><m:oMath>${body}</m:oMath></w:p>`), depth);
  }
});
test('author-defined imported Word sizes are preserved byte for byte', () => {
  const source='<m:oMath><m:f><m:fPr/><m:num><m:r><w:rPr><w:sz w:val="24"/></w:rPr><m:t>1</m:t></m:r></m:num><m:den><m:f/></m:den></m:f></m:oMath>';
  assert.equal(fullSizeInlineFractions(source),source);
});
test('Word math settings are still present and idempotent', () => {
  const result=ensureWordMathSettings('<w:settings xmlns:w="word" xmlns:m="math"><w:compat/></w:settings>');
  assert.match(result, /Cambria Math/);
  assert.equal(ensureWordMathSettings(result),result);
});
test('legacy undelimited formulas never swallow physical line breaks', () => {
  assert.deepEqual(splitMathText('x=1\ny=2').filter(s=>s.kind==='math').map(s=>s.value), ['x=1','y=2']);
});

test('saved homework prose with escaped newlines renders without becoming a formula', () => {
  const source = String.raw`点$A$与点$B$关于直线$l$对称.\n（2）点$C$的坐标为$(6, 0)$，满足$S_{\triangle POA}=S_{\triangle PBC}$`;
  const expected = source.replace('\\n', '\n');
  assert.deepEqual(splitMathText(source), splitMathText(expected));
  assert.deepEqual(splitMathLines(source), splitMathLines(expected));
  for (const segment of splitMathText(source).filter(s => s.kind === 'math')) {
    assert.doesNotThrow(() => katex.renderToString(toLatexMath(segment.value), { throwOnError: true, strict: 'ignore' }));
    assert.doesNotMatch(segment.value, /对称|点/);
  }
});

test('prose newline recovery handles CRLF, consecutive lines and remains idempotent', () => {
  const source = String.raw`条件。\r\n（1）求值。\n\n（2）证明。`;
  const expected = '条件。\n（1）求值。\n\n（2）证明。';
  assert.equal(normalizeProseLineBreaks(source), expected);
  assert.equal(normalizeProseLineBreaks(expected), expected);
  assert.deepEqual(splitMathText(source, { autoDetect: false }), [{ kind: 'text', value: source }]);
});

test('newline recovery leaves explicit math, commands, literals and paths intact', () => {
  for (const source of [
    String.raw`$\n$`, String.raw`\(\n\)`, String.raw`\[\n\]`,
    String.raw`$$\begin{aligned}a&=1\\n&=2\end{aligned}$$`,
    String.raw`\neq \nabla \nu \notin \newcommand`,
    '`\\n`', '```text\n\\n\n```', String.raw`\text{换行\n示例}`,
    String.raw`\verb|\n|`, String.raw`C:\n\file`, String.raw`C:\notes\n.txt`,
    String.raw`\\n`, String.raw`\\r\\n`,
  ]) assert.equal(normalizeProseLineBreaks(source), source, source);
  const source = String.raw`$\n$之后。\n（2）$a\neq b$`;
  assert.equal(normalizeProseLineBreaks(source), '$\\n$之后。\n（2）$a\\neq b$');
});

test('newline recovery starts choice options and sentences on new lines but keeps negated arrows', () => {
  const source = String.raw`等于( )\n\nA. -1\nB. $-2x-1$\r\nC. 1\nThe end`;
  const expected = '等于( )\n\nA. -1\nB. $-2x-1$\nC. 1\nThe end';
  assert.equal(normalizeProseLineBreaks(source), expected);
  assert.equal(normalizeProseLineBreaks(expected), expected);
  for (const source of [String.raw`p\nRightarrow q`, String.raw`A\nLeftarrow B`, String.raw`$p\nRightarrow q$`, String.raw`C:\data\nA.txt`])
    assert.equal(normalizeProseLineBreaks(source), source, source);
});
