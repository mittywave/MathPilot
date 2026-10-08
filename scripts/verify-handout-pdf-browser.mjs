import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
// The PDF route lives in the Vite dev server, so this starts `vinext dev` on an isolated
// database (STUDIO_TEST_STATE) and exports from the real 讲义 page. No AI service is used.
// Usage: PLAYWRIGHT_PACKAGE=<package.json beside playwright> CHROMIUM_PATH=<chrome> node scripts/verify-handout-pdf-browser.mjs [questions.json]
const require = createRequire(process.env.PLAYWRIGHT_PACKAGE || import.meta.url);
const { chromium } = require('playwright');
const root = process.cwd();
const out = resolve('artifacts/handout-pdf-verification');
await mkdir(out, { recursive: true });
const state = await mkdtemp(join(tmpdir(), 'zhiti-handout-pdf-'));
const port = 3027;
const base = `http://127.0.0.1:${port}`;
const migrate = spawnSync(join(root, 'node_modules/.bin/wrangler'), ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state, '--config', 'wrangler.jsonc'], { cwd: root, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
if (migrate.status !== 0) throw Error(migrate.stderr + migrate.stdout);
const server = spawn(join(root, 'node_modules/.bin/vinext'), ['dev', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: root, env: { ...process.env, STUDIO_TEST_STATE: state, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = ''; server.stdout.on('data', v => serverLog += v); server.stderr.on('data', v => serverLog += v);
const result = { steps: [], pageErrors: [], downloads: {} };
const step = name => { result.steps.push(name); console.log('✓', name); };
const api = async (path, body) => {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json', Origin: base } : {}, body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json();
  if (!response.ok) throw Error(`${path}: ${response.status} ${JSON.stringify(payload)}`);
  return payload;
};
// pdf.js reads the typeset PDF back, so the checks see what students see.
async function pdfText(file) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await getDocument({ data: new Uint8Array(await readFile(file)), cMapUrl: resolve('node_modules/pdfjs-dist/cmaps') + '/', cMapPacked: true, standardFontDataUrl: resolve('node_modules/pdfjs-dist/standard_fonts') + '/', disableFontFace: true, isEvalSupported: false }).promise;
  const pages = [];
  for (let index = 1; index <= pdf.numPages; index++) pages.push((await (await pdf.getPage(index)).getTextContent()).items.map(item => item.str + (item.hasEOL ? '\n' : '')).join(''));
  return pages;
}
const inOrder = (text, markers, label) => markers.reduce((from, marker) => {
  const index = text.indexOf(marker, from);
  assert.ok(index >= 0, `${label}: missing ${marker} after position ${from}`);
  return index + marker.length;
}, 0);
let browser;
try {
  for (let i = 0; ; i++) {
    if (server.exitCode !== null || i > 600) throw Error(serverLog.slice(-3000));
    try { if ((await fetch(base + '/api/auth/me')).ok) break; } catch { /* the dev server is still starting */ }
    await delay(200);
  }
  assert.equal((await api('/api/auth/me')).user?.local, true, 'the isolated dev server runs as the local administrator');
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  page.setDefaultTimeout(30000);
  page.on('pageerror', e => result.pageErrors.push(String(e)));

  // Entry paths store PNG/JPEG; one WebP figure also exercises the PDF converter's redraw path.
  await page.goto(base + '/api/auth/me');
  const [figure, figurePng] = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 360; canvas.height = 220;
    const c = canvas.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, 360, 220); c.strokeStyle = '#111'; c.lineWidth = 3;
    c.beginPath(); c.moveTo(40, 190); c.lineTo(250, 190); c.lineTo(320, 40); c.lineTo(110, 40); c.closePath(); c.stroke();
    c.setLineDash([6, 5]); c.beginPath(); c.moveTo(40, 190); c.lineTo(320, 40); c.stroke();
    c.fillStyle = '#111'; c.font = 'italic 22px serif'; c.fillText('A', 92, 32); c.fillText('D', 324, 36); c.fillText('B', 18, 206); c.fillText('C', 254, 210);
    return [canvas.toDataURL('image/webp', 0.92), canvas.toDataURL('image/png')];
  });
  const { module: mine } = await api('/api/modules', { module: { name: '初二数学', subtitle: '' }, scope: 'mine' });
  await api('/api/categories', { category: { id: 'cat-para', name: '平行四边形', moduleId: mine.id, parentId: mine.id, createdAt: Date.now() }, scope: 'mine' });
  const question = (id, fields) => api('/api/questions', { scope: 'mine', question: { id, moduleId: mine.id, categoryId: 'cat-para', difficulty: '基础', provenance: '来源待核实', options: [], answer: '', analysis: '', source: '', tags: [], createdAt: Date.now(), updatedAt: Date.now(), ...fields } });
  await question('own-1', { type: '单选题', stem: '在 □ABCD 中，∠A=70°，则 ∠C 的度数是（　　）', options: ['$70^\\circ$', '$110^\\circ$', '$140^\\circ$', '$20^\\circ$'], answer: 'A', analysis: '【分析】平行四边形的对角相等。\n【解答】∵四边形 ABCD 是平行四边形，∴∠C=∠A=70°，故选 A。', source: '2025 期中', tags: ['平行四边形的性质', '对角相等'] });
  await question('own-2', { type: '填空题', stem: '在 $\\parallelogram ABCD$ 中，$AB=5$，$BC=3$，则它的周长为____。', answer: '$16$', analysis: '周长为 $2\\times(5+3)=16$。', tags: ['平行四边形的周长'] });
  await question('own-4', { type: '解答题', stem: '在 □ABCD 中，∠ABC 的平分线交 AD 于点 E，AE=2，ED=1，求 □ABCD 的周长。', answer: '$10$', analysis: '【分析】平行线遇上角平分线，得到等腰三角形。\n【解答】∵AD∥BC，∴∠AEB=∠EBC。∵BE 平分 ∠ABC，∴∠ABE=∠EBC，∴∠ABE=∠AEB，∴AB=AE=2。\n∵AD=AE+ED=3，∴□ABCD 的周长为 2×(2+3)=10。', tags: ['平行四边形的性质', '角平分线', '等腰三角形'] });
  await question('own-3', { type: '解答题', stem: '如图，在 □ABCD 中，对角线 AC、BD 相交于点 O，点 E、F 分别是 OA、OC 的中点。求证：四边形 BFDE 是平行四边形。', answer: '见解析', analysis: '【证明】∵四边形 ABCD 是平行四边形，∴OA=OC，OB=OD。\n∵E、F 分别是 OA、OC 的中点，∴OE=OF。\n∴四边形 BFDE 是平行四边形。', contentImages: [figure], imageLayout: 'right' });
  const sourceFile = process.argv[2] || 'artifacts/word-import-regression/fixed/saved-questions.json';
  const imported = existsSync(sourceFile) ? JSON.parse(await readFile(sourceFile, 'utf8')).sort((a, b) => b.createdAt - a.createdAt).slice(0, 8) : [];
  for (const [index, item] of imported.entries()) {
    const swap = value => typeof value === 'string' && value.startsWith('/api/assets/') ? figurePng : value;
    const fields = { ...item }; for (const key of ['id', 'moduleId', 'categoryId', 'createdBy', 'createdByEmail', 'canEdit']) delete fields[key];
    await question(`word-${index + 1}`, { ...fields, contentImages: (item.contentImages ?? []).map(swap), stemDocxAssets: Object.fromEntries(Object.entries(item.stemDocxAssets ?? {}).map(([k, v]) => [k, swap(v)])), analysisDocxAssets: Object.fromEntries(Object.entries(item.analysisDocxAssets ?? {}).map(([k, v]) => [k, swap(v)])) });
  }
  const ref = (id, band = 'example') => ({ id: `item-${id}`, kind: 'question', scope: 'mine', questionId: id, band });
  const importedBand = index => index < 2 ? 'example' : index < 6 ? 'practice' : 'variant';
  const { handout } = await api('/api/handouts', { handout: { title: '第一讲-平行四边形的性质', items: [
    { id: 's1', kind: 'section', title: '一、平行四边形的概念和性质', note: '两组对边分别平行的四边形叫做平行四边形，记作 $\\parallelogram ABCD$。\n平行四边形的对边相等，对角相等，对角线互相平分。' },
    ref('own-1'), ref('own-3'), ref('own-2', 'practice'), ref('own-4', 'variant'),
    { id: 's2', kind: 'section', title: '周练真题', note: '' },
    ...imported.map((_, index) => ref(`word-${index + 1}`, importedBand(index))),
  ] } });
  step(`seeded 4 written + ${imported.length} Word-imported questions in a two-module 讲义 across 例题/练习/变式`);

  await page.goto(`${base}/tools/handouts?id=${handout.id}`);
  await page.locator('.handout-question').nth(3 + imported.length).waitFor();
  await page.waitForFunction(() => !document.body.innerText.includes('正在读取题目'));

  // 知识点截图识别: a synthetic textbook snippet; recognition is stubbed with the structure the real model returns.
  const knowledge = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 900; canvas.height = 700;
    const c = canvas.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, 900, 700); c.fillStyle = '#111';
    c.font = 'bold 34px sans-serif'; c.fillText('正方形的判定', 40, 60);
    c.font = '22px serif'; c.fillText('判定一个四边形是正方形时，只需判定它既是矩形又是菱形：', 40, 120);
    c.font = 'bold 22px serif'; c.fillText('（1）先证它是矩形，再证它有一组邻边相等或对角线垂直；', 40, 170); c.fillText('（2）先证它是菱形，再证它有一个角为直角或对角线相等。', 40, 215);
    c.strokeStyle = '#111'; c.lineWidth = 3; c.strokeRect(330, 300, 240, 240); c.beginPath(); c.moveTo(330, 300); c.lineTo(570, 540); c.moveTo(570, 300); c.lineTo(330, 540); c.stroke();
    c.font = 'italic 22px serif'; c.fillText('D', 310, 296); c.fillText('C', 576, 296); c.fillText('A', 310, 560); c.fillText('B', 576, 560); c.fillText('P', 444, 446);
    c.font = '22px serif'; c.fillText('正方形 ABCD 的对角线交于点 P', 330, 600);
    c.fillText('容易证明，△APB 等四个三角形均为等腰直角三角形。', 40, 640);
    return canvas.toDataURL('image/png');
  });
  await writeFile(join(out, 'knowledge.png'), Buffer.from(knowledge.split(',')[1], 'base64'));
  let recognitionCalls = 0;
  await page.route('**/api/recognize-note', async route => {
    recognitionCalls += 1;
    assert.match(route.request().postDataJSON().image, /^data:image\//);
    // Text boxes as the model returns them; the figure's box deliberately clips the square and its corner labels.
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: { warnings: [], blocks: [
      { type: 'heading', level: 2, text: '正方形的判定', bbox: { x: 40, y: 38, width: 250, height: 55 } },
      { type: 'paragraph', text: '判定一个四边形是正方形时，只需判定它既是矩形又是菱形：', bbox: { x: 40, y: 140, width: 640, height: 40 } },
      { type: 'item', marker: '（1）', text: '**先证它是矩形，再证它有一组邻边相等或对角线垂直；**', bbox: { x: 40, y: 212, width: 640, height: 40 } },
      { type: 'item', marker: '（2）', text: '**先证它是菱形，再证它有一个角为直角或对角线相等。**', bbox: { x: 40, y: 276, width: 640, height: 40 } },
      { type: 'figures', side: '', sideBox: null, figures: [{ bbox: { x: 380, y: 440, width: 240, height: 320 }, caption: '正方形 $ABCD$ 的对角线交于点 $P$', captionBox: { x: 360, y: 820, width: 380, height: 50 } }] },
      { type: 'paragraph', text: '容易证明，$\\triangle APB$ 等四个三角形均为等腰直角三角形。', bbox: { x: 40, y: 880, width: 640, height: 50 } },
    ] } }) });
  });
  const firstSection = page.locator('.handout-module').first().locator('.handout-lane.knowledge');
  const chooser = page.waitForEvent('filechooser');
  await firstSection.getByRole('button', { name: '截图识别', exact: true }).click();
  await (await chooser).setFiles(join(out, 'knowledge.png'));
  await page.locator('.toast', { hasText: '已识别' }).waitFor();
  const preview = firstSection.getByRole('textbox', { name: '模块一知识点' });
  await preview.locator('h4', { hasText: '正方形的判定' }).waitFor();
  assert.equal(await preview.locator('.note-item-line strong').count(), 2, 'both key points stay bold');
  await page.waitForFunction(() => { const img = document.querySelector('.handout-lane.knowledge .note-figure img:not(.ProseMirror-separator)'); return img && img.complete && img.naturalWidth > 0; });
  assert.ok(await preview.locator('.katex').count() >= 1, 'formulas render in the note');
  assert.doesNotMatch(await preview.innerText(), /##|\*\*|\$|!\[/, 'the note never shows its markup');
  await firstSection.screenshot({ path: join(out, 'note-preview.png') });
  await page.locator('.handout-save', { hasText: '已保存' }).waitFor();
  const raw = (await api(`/api/handouts/${handout.id}`)).handout.items.find(item => item.id === 's1').note;
  assert.match(raw, /^两组对边分别平行的四边形叫做平行四边形/, 'the recognized text is appended after the existing note');
  assert.match(raw, /\n## 正方形的判定\n判定一个四边形是正方形时[^\n]*\n（1）\*\*先证它是矩形[^\n]*\n（2）\*\*先证它是菱形[^\n]*\n!\[正方形 \$ABCD\$ 的对角线交于点 \$P\$\]\(\/api\/assets\/[0-9a-f-]{36}\)\n容易证明/);
  assert.match(await preview.locator('figcaption').innerText(), /的对角线交于点/, 'the caption is typeset under its figure');
  // The figure is cut from its strokes: the whole square with all four corner labels, not the caption under it.
  const figureSize = await page.evaluate(async source => { const img = new Image(); img.src = source; await img.decode(); return [img.naturalWidth, img.naturalHeight]; }, raw.match(/\/api\/assets\/[0-9a-f-]{36}/)[0]);
  assert.ok(Math.abs(figureSize[0] / figureSize[1] - 1) < .08, `square figure, got ${figureSize.join('×')}`);
  result.figureSize = figureSize;
  // The recognized text is edited in place: click into it and type.
  const recognizedLine = preview.locator('p', { hasText: '容易证明' });
  const line = await recognizedLine.boundingBox();
  await page.mouse.click(line.x + line.width - 4, line.y + line.height / 2);
  await page.keyboard.press('Meta+ArrowRight');
  await page.waitForTimeout(60);
  await page.keyboard.type('（课上证明）');
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await page.locator('.handout-save', { hasText: '已保存' }).waitFor();
  assert.match((await api(`/api/handouts/${handout.id}`)).handout.items.find(item => item.id === 's1').note, /容易证明，\$\\triangle APB\$ 等四个三角形均为等腰直角三角形。（课上证明）$/);
  step('知识点截图识别 via button: heading, bold points, formula and cropped figure, shown formatted and edited in place');
  // Dragging a screenshot onto a module's 知识点, or pasting it there, runs the same shared path.
  const secondSection = page.locator('.handout-module').nth(1).locator('.handout-lane.knowledge');
  const sendImage = (target, kind) => target.evaluate(async (element, [dataUrl, eventKind]) => {
    const file = new File([await (await fetch(dataUrl)).blob()], 'note.png', { type: 'image/png' });
    const transfer = new DataTransfer(); transfer.items.add(file);
    if (eventKind === 'paste') { element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })); return; }
    element.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    if (eventKind === 'drop') element.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, [knowledge, kind]);
  const secondNote = secondSection.getByRole('textbox', { name: '模块二知识点' });
  await sendImage(secondNote, 'hover');
  await page.locator('.handout-lane.knowledge.dropping').waitFor();
  assert.match(await secondSection.locator('.handout-lane-head').innerText(), /松开即可识别截图/);
  await sendImage(secondNote, 'drop');
  await secondNote.locator('h4', { hasText: '正方形的判定' }).waitFor();
  assert.equal(await page.locator('.handout-lane.dropping').count(), 0);
  await page.locator('.toast', { hasText: '已识别' }).waitFor();
  await page.locator('.toast').waitFor({ state: 'detached' });
  await sendImage(secondNote, 'paste');
  await page.waitForFunction(() => document.querySelectorAll('.handout-lane.knowledge')[1]?.querySelectorAll('.note-preview h4').length === 2);
  assert.equal(recognitionCalls, 3);
  await page.locator('.handout-save', { hasText: '已保存' }).waitFor();
  await page.reload();
  await page.locator('.handout-lane.knowledge').first().locator('.note-preview h4').waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.note-figure img:not(.ProseMirror-separator)')].length === 3 && [...document.querySelectorAll('.note-figure img:not(.ProseMirror-separator)')].every(img => img.complete && img.naturalWidth > 0));
  step('知识点截图识别 via drag-and-drop and paste; all notes and figures persist after reload');
  const dialog = page.locator('.export-modal');
  async function exportAs({ format, answers, file, source = false }) {
    await page.getByRole('button', { name: '导出', exact: true }).click();
    await dialog.waitFor();
    await page.locator('.export-modal .primary-button:not(:disabled)').waitFor();
    await dialog.locator('label', { hasText: answers }).click();
    const started = Date.now();
    const download = page.waitForEvent('download', { timeout: 420000 });
    // PDF is the main action; Word and the LaTeX source sit under 其他格式.
    if (source || format === 'word') {
      await dialog.getByText('其他格式', { exact: true }).click();
      await dialog.getByRole('menuitem', { name: source ? '下载 LaTeX 源码' : '导出 Word' }).click();
    } else await dialog.getByRole('button', { name: '生成 PDF', exact: true }).click();
    await (await download).saveAs(join(out, file));
    await dialog.waitFor({ state: 'hidden', timeout: 30000 });
    result.downloads[file] = { seconds: Math.round((Date.now() - started) / 100) / 10, notice: await page.locator('.toast').innerText().catch(() => '') };
  }
  await page.getByRole('button', { name: '导出', exact: true }).click();
  await page.locator('.export-modal .primary-button:not(:disabled)').waitFor();
  assert.equal(await dialog.getByRole('button', { name: '生成 PDF', exact: true }).isEnabled(), true, 'PDF is the main action when the local typesetter is available');
  assert.equal(await dialog.locator('fieldset').count(), 1, 'the only choice is where answers go');
  result.firstRunHint = await dialog.locator('.handout-export-status').innerText().catch(() => '');
  await page.screenshot({ path: join(out, 'export-dialog.png') });
  await dialog.getByText('其他格式', { exact: true }).click();
  assert.deepEqual(await dialog.getByRole('menuitem').allInnerTexts(), ['导出 Word', '下载 LaTeX 源码']);
  await page.screenshot({ path: join(out, 'export-dialog-more.png') });
  await dialog.locator('h2').click();
  await dialog.getByRole('menuitem').first().waitFor({ state: 'hidden' });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await exportAs({ format: 'pdf', answers: '不附', file: 'handout-none.pdf' });
  step(`PDF 学生版 exported (first run incl. engine setup: ${result.downloads['handout-none.pdf'].seconds}s)`);
  await exportAs({ format: 'pdf', answers: '文末', file: 'handout-end.pdf' });
  await exportAs({ format: 'pdf', answers: '每题后', file: 'handout-each.pdf' });
  step(`PDF 附答案 / 教师版 exported (${result.downloads['handout-end.pdf'].seconds}s, ${result.downloads['handout-each.pdf'].seconds}s)`);
  const pdfs = {};
  for (const key of ['none', 'end', 'each']) pdfs[key] = await pdfText(join(out, `handout-${key}.pdf`));
  for (const [key, pages] of Object.entries(pdfs)) await writeFile(join(out, `handout-${key}.txt`), pages.map((text, index) => `--- page ${index + 1} ---\n${text}`).join('\n'));
  // xeCJK sets its usual CJK–digit gap inside labels, so the PDF reads 例 1 / 变式 1.
  const lastExample = `例 ${imported.length ? 4 : 2}`;
  for (const [key, pages] of Object.entries(pdfs)) {
    const text = pages.join('\n');
    inOrder(text, ['平行四边形的性质', '一 平行四边形的概念和性质', '知识点 本模块要掌握的内容', '两组对边分别平行', '例题 跟着老师，看知识点怎么用', '例 1', '2025 期中', '考点 平行四边形的性质、对角相等', '例 2', '如图，在 ▱',
      '练习 自己动手，检验掌握', '考点 平行四边形的周长', '变式 换个情境，抓住本质', '变式 1', '考点 平行四边形的性质、角平分线、等腰三角形',
      ...(imported.length ? ['二 周练真题', '例 3', lastExample, '练习 自己动手', '变式 换个情境', '变式 2'] : [])], key);
    const notes = (text.match(/课堂笔记/g) ?? []).length;
    if (key === 'each') assert.equal(notes, 0, 'the teacher version has no note areas');
    else assert.equal(notes, imported.length ? 4 : 2, `${key}: one 课堂笔记 area under every 例题`);
  }
  assert.doesNotMatch(pdfs.none.join('\n'), /参考答案|【解答】/);
  inOrder(pdfs.end.join('\n'), ['参考答案与解析', '例题解析', '例 1 答案 A', '例 2 答案', '练习答案', '1 答案 16', '变式答案', '变式 1 答案 10'], 'end');
  inOrder(pdfs.each.join('\n'), ['例 1', '2025 期中', '答案 A', '例 2', '答案', '1 在', '答案 16', '变式 1', '答案 10'], 'each');
  result.pdfPages = Object.fromEntries(Object.entries(pdfs).map(([key, pages]) => [key, pages.length]));
  step(`PDF structure read back with pdf.js: 模块 → 知识点 → 例题 → 练习 → 变式, 例1/1/变式1, 考点, 课堂笔记 in 学生版 only, grouped key (pages ${JSON.stringify(result.pdfPages)})`);
  assert.ok(existsSync(join(root, '.tools/tectonic/tectonic')), 'the engine was installed into .tools');
  await exportAs({ format: 'pdf', answers: '不附', file: 'handout-source.zip', source: true });
  const zip = await JSZip.loadAsync(await readFile(join(out, 'handout-source.zip')));
  const names = Object.keys(zip.files).filter(name => !zip.files[name].dir);
  assert.ok(names.includes('handout.tex') && names.includes('mitty-handout.cls') && names.some(name => /^figures\/fig-\d+\.png$/.test(name)), names.join(','));
  const tex = await zip.file('handout.tex').async('string');
  inOrder(tex, ['\\handoutsection{一}{平行四边形的概念和性质}', '\\handoutpart{知识点}', '\\handoutpart{例题}', '\\begin{handoutquestion}{例1}', '\\handoutnotesarea{4}', '\\handoutpart{练习}', '\\handoutpart{变式}', '\\begin{handoutquestion}{变式1}'], 'tex');
  result.zipFiles = names;
  step(`LaTeX 源码 zip contains ${names.length} files (main, class, PNG figures)`);
  // Word has never accepted WebP, so its regression runs on a second 讲义 holding the Word-imported questions.
  const recognizedNote = (await api(`/api/handouts/${handout.id}`)).handout.items.find(item => item.id === 's1').note;
  const { handout: wordHandout } = await api('/api/handouts', { handout: { title: '第二讲 真题', items: [{ id: 's', kind: 'section', title: '一、真题演练', note: recognizedNote }, ...imported.map((_, index) => ref(`word-${index + 1}`, importedBand(index)))] } });
  await page.goto(`${base}/tools/handouts?id=${wordHandout.id}`);
  await page.locator('.handout-question').nth(imported.length - 1).waitFor();
  await page.waitForFunction(() => !document.body.innerText.includes('正在读取题目'));
  await exportAs({ format: 'word', answers: '文末', file: 'handout-end.docx' });
  const wordXml = await (await JSZip.loadAsync(await readFile(join(out, 'handout-end.docx')))).file('word/document.xml').async('string');
  const wordText = wordXml.replace(/<[^>]+>/g, '');
  assert.ok(wordText.indexOf('两组对边分别平行') < wordText.indexOf('正方形的判定'), 'the recognized note follows the original note text');
  if (imported.length) inOrder(wordText, ['知识点\u3000本模块要掌握的内容', '两组对边分别平行', '例题\u3000跟着老师', '例1．', '例2．', '练习\u3000自己动手', '1．', '变式\u3000换个情境', '变式1．', '参考答案与试题解析', '例题解析', '练习答案', '变式答案'], 'word');
  assert.ok(wordXml.indexOf('<w:drawing') < wordXml.indexOf('容易证明'), 'the note figure sits inside the note');
  step('Word export still works from the same dialog and carries the recognized note with its figure');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '导出', exact: true }).click();
  await page.locator('.export-modal .primary-button:not(:disabled)').waitFor();
  const mobile = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    wrapped: [...document.querySelectorAll('.export-modal button, .export-modal label')].filter(el => el.offsetParent && el.scrollWidth > el.clientWidth + 1).map(el => el.innerText),
    small: [...document.querySelectorAll('.export-modal button, .export-modal label')].filter(el => el.offsetParent && !el.classList.contains('close') && el.getBoundingClientRect().height < 40).map(el => el.innerText),
  }));
  await page.screenshot({ path: join(out, 'export-dialog-mobile.png') });
  assert.deepEqual(mobile, { overflow: 0, wrapped: [], small: [] });
  step('export dialog on a 390px phone: no overflow, no wrapped labels, touch targets ≥ 40px');
  assert.deepEqual(result.pageErrors, []);
  result.ok = true;
} catch (error) {
  result.failure = String(error?.stack || error);
  throw error;
} finally {
  await writeFile(join(out, 'results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ downloads: result.downloads, firstRunHint: result.firstRunHint, ok: result.ok }, null, 2));
  if (browser) await browser.close();
  server.kill('SIGINT');
  await Promise.race([new Promise(r => server.once('exit', r)), delay(5000)]);
  if (server.exitCode === null) server.kill('SIGKILL');
  await writeFile(join(out, 'server.log'), serverLog);
  await rm(state, { recursive: true, force: true });
}
