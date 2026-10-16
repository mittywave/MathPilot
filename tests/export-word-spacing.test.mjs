import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { loadSource } from './load-source.mjs';

test('question Word export never clips native math or inline images with a fixed line height', async t => {
  const OriginalImage = globalThis.Image;
  // Only browser image decoding is stubbed; the actual DOCX builder is executed.
  globalThis.Image = class {
    naturalWidth = 160; naturalHeight = 100;
    set src(_value) { queueMicrotask(() => this.onload()); }
  };
  t.after(() => { if (OriginalImage === undefined) delete globalThis.Image; else globalThis.Image = OriginalImage; });
  const { buildQuestionsWordBlob } = await loadSource('lib/export-word.ts');
  const question = { id: 'synthetic', type: '单选题', stem: '计算 $x=\\frac{1}{2}$。',
    options: ['$\\frac{1}{2}$', '1', '2', '4'], answer: 'A', analysis: '$\\frac{1}{2}$',
    tags: [], difficulty: '基础', contentImages: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVQIHWP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'], imageLayout: 'right' };
  const blob = await buildQuestionsWordBlob([question], '版式回归', true);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const xml = await zip.file('word/document.xml').async('string');
  const paragraphs = xml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) || [];
  const mediaParagraphs = paragraphs.filter(p => /<m:oMath>|<w:drawing>/.test(p));
  assert.ok(mediaParagraphs.length >= 4);
  // Auto or at-least spacing grows with a tall fraction or picture; an exact height would cut it off.
  for (const p of mediaParagraphs) assert.match(p, /<w:spacing[^>]*w:lineRule="(?:auto|atLeast)"/);
  assert.doesNotMatch(xml, /w:lineRule="exact"/);
  assert.match(xml, /<m:f>/);
  assert.match(xml, /<w:drawing>/);
  assert.match(xml, /<w:tbl>/);
  const styles = await zip.file('word/styles.xml').async('string');
  assert.match(styles, /<w:spacing[^>]*w:line="468"[^>]*w:lineRule="atLeast"/);
});

test('homework stems export without their printed number and with unbraced degree signs', async () => {
  const { buildQuestionsWordBlob } = await loadSource('lib/export-word.ts');
  // Wrong-question snapshots keep the number the stem was printed with and may write 90^\circ without braces.
  const question = { id: 'homework', type: '填空题', stem: '8. 在 $\\mathrm{Rt}\\triangle OAB$ 中，$\\angle B=90^\\circ$，则 $OA=$______。',
    options: [], answer: '', analysis: '', tags: [], difficulty: '中等', source: '9月份错题' };
  const blob = await buildQuestionsWordBlob([question], '错题练习', false, 'basket');
  const xml = await (await JSZip.loadAsync(await blob.arrayBuffer())).file('word/document.xml').async('string');
  const text = xml.replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '');
  assert.match(text, /1．（9月份错题）在/);
  assert.match(text, /∠B＝90°/);
  assert.doesNotMatch(text, /\\circ|8\. 在/);
});

test('Word standalone figures have a readable print width for screenshot and PDF imports', async t => {
  const originalImage = globalThis.Image;
  globalThis.Image = class {
    naturalWidth = 1400; naturalHeight = 900;
    set src(_value) { queueMicrotask(() => this.onload()); }
  };
  t.after(() => { if (originalImage === undefined) delete globalThis.Image; else globalThis.Image = originalImage; });
  const { buildQuestionsWordBlob } = await loadSource('lib/export-word.ts');
  const base = { id: 'figure', type: '解答题', stem: '如图，求证四边形 ABCD 是矩形。', options: [], answer: '', analysis: '', tags: [], difficulty: '中等',
    diagramImage: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVQIHWP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', imageLayout: 'right' };
  const questions = [base, { ...base, originalImage: '/page', diagramBox: { x: 700, y: 200, width: 180, height: 100 } },
    { ...base, originalImage: '/page', diagramBox: { x: 20, y: 300, width: 620, height: 300 } },
    { ...base, originalImage: '/page', diagramBox: { x: 500, y: 200, width: 900, height: 300 } }];
  const blob = await buildQuestionsWordBlob(questions, '配图尺寸回归', false);
  const xml = await (await JSZip.loadAsync(await blob.arrayBuffer())).file('word/document.xml').async('string');
  const widths = [...xml.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"/g)].map(match => Number(match[1]));
  assert.deepEqual(widths, [260, 260, 403, 293].map(pixels => pixels * 9525));
  const paragraphs = xml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g) ?? [];
  paragraphs.forEach((paragraph, index) => {
    if (paragraph.includes('<w:drawing>')) assert.match(paragraphs[index - 1], /<w:keepNext\/>/, 'a standalone figure stays with the preceding stem');
  });
  globalThis.Image = class {
    naturalWidth = 300; naturalHeight = 1400;
    set src(_value) { queueMicrotask(() => this.onload()); }
  };
  const portrait = await buildQuestionsWordBlob([questions[1]], '竖图回归', false);
  const portraitXml = await (await JSZip.loadAsync(await portrait.arrayBuffer())).file('word/document.xml').async('string');
  const extent = portraitXml.match(/<wp:extent cx="(\d+)" cy="(\d+)"/);
  assert.equal(Number(extent[2]), 320 * 9525, 'a tall figure is capped within the page');
  assert.ok(Math.abs(Number(extent[1]) / Number(extent[2]) - 300 / 1400) < .003, 'the height cap preserves aspect ratio');
});
