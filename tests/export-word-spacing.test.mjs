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
