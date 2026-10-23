import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { AlignmentType, Document, ImageRun, Math as WordMath, MathFraction, MathRadical, MathRun, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import { loopbackFetch as fetch } from '../tests/helpers/loopback-fetch.mjs';
import { noteTableMarkup } from '../lib/handout-note.mjs';
// Run after npm run build. The compiled app, D1 and the browser are real; no AI
// service is configured, so only the manual and Word-structure entry paths run.
// Usage: PLAYWRIGHT_PACKAGE=<package.json beside playwright> CHROMIUM_PATH=<chrome> node scripts/verify-handouts-browser.mjs
// Add --notes for queue/concurrency or --note-tables for editable screenshot tables with controlled AI replies.
const require = createRequire(process.env.PLAYWRIGHT_PACKAGE || import.meta.url);
const { chromium } = require('playwright');
const root = process.cwd();
const out = resolve('artifacts/handouts-verification');
await mkdir(out, { recursive: true });
const state = await mkdtemp(join(tmpdir(), 'zhiti-handouts-'));
const port = 3019;
const base = `http://127.0.0.1:${port}`;
const init = spawnSync(join(root, 'node_modules/.bin/wrangler'), ['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state, '--config', 'wrangler.jsonc'], { cwd: root, encoding: 'utf8', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
if (init.status !== 0) throw Error(init.stderr + '\n' + init.stdout);
const vars = { LOCAL_ADMIN_MODE: 'true', HOMEWORK_AUTO_PUBLISH_ENABLED: 'false', OPENAI_API_KEY: '', PUBLIC_LIBRARY_REMOTE_URL: '' };
const worker = spawn(process.execPath, ['scripts/start-local-test-worker.mjs', 'dist/server/wrangler.json', String(port), state, JSON.stringify(vars)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let workerLog = ''; worker.stdout.on('data', v => workerLog += v); worker.stderr.on('data', v => workerLog += v);
const result = { steps: [], pageErrors: [], exports: {} };
const step = name => { result.steps.push(name); console.log('✓', name); };
const api = async (path, body, method = body ? 'POST' : 'GET') => {
  const response = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json', Origin: base } : {}, body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json();
  if (!response.ok) throw Error(`${method} ${path}: ${response.status} ${JSON.stringify(payload)}`);
  return payload;
};
let browser; let page;

async function wordFixture(png) {
  const p = (...children) => new Paragraph({ children });
  const t = text => new TextRun(text);
  const doc = new Document({ sections: [{ children: [
    p(t('Word 回归试卷')),
    p(t('一、选择题')),
    p(t('（多'), t('选）'), t('1．方程 '), new WordMath({ children: [new MathFraction({ numerator: [new MathRun('x')], denominator: [new MathRun('2')] }), new MathRun('=3')] }), t(' 的解满足（　　）')),
    p(t('A．x=3　　B．x=6　　C．x=5　　D．2x=12')),
    p(t('二、解答题')),
    p(t('2．根据下表和图形，列方程求 a 的值，并求 '), new WordMath({ children: [new MathRadical({ children: [new MathRun('4')] })] }), t(' 的值。')),
    p(t('声明：本资料著作权归出题人所有。')),
    p(t('0.5b=4，请继续求 b 的值。')),
    new Table({ width: { size: 4000, type: WidthType.DXA }, rows: [
      new TableRow({ children: [new TableCell({ children: [p(t('月份'))] }), new TableCell({ children: [p(t('销量'))] })] }),
      new TableRow({ children: [new TableCell({ children: [p(t('一月'))] }), new TableCell({ children: [p(t('a+12'))] })] }),
    ] }),
    new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ type: 'png', data: png, transformation: { width: 160, height: 100 } })] }),
    p(t('参考答案与试题解析')),
    p(t('（多选）1．')), p(t('【分析】去分母。')), p(t('【解答】解：x=6，故选：B、D．')), p(t('【点评】本题考查一元一次方程。')),
    p(t('2．')), p(t('【分析】由表格列方程。')), p(t('【解答】解：a+12=20，a=8．')), p(t('0.5b=4，')), p(t('解得：b=8。')), p(t('【点评】本题考查列方程。')),
  ] }] });
  const zip = await JSZip.loadAsync(await Packer.toBuffer(doc));
  const xml = await zip.file('word/document.xml').async('string');
  // Real-world external documents can put OMML inside w:r. Keep one such input
  // alongside a standard equation so both structures traverse the actual UI.
  zip.file('word/document.xml', xml.replace(/<m:oMath>[\s\S]*?<\/m:oMath>/g, math => math.includes('<m:rad>') ? `<w:r>${math}</w:r>` : math));
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function inspectDocx(file) {
  const zip = await JSZip.loadAsync(await readFile(file));
  const xml = await zip.file('word/document.xml').async('string');
  const fonts = await zip.file('word/fontTable.xml').async('string');
  const text = xml.replace(/<w:tab\/>/g, ' ').replace(/<[^>]+>/g, '');
  return {
    xml, text,
    songti: /eastAsia="Songti SC"/.test(xml) && /w:name="Songti SC"/.test(fonts),
    timesNewRoman: /w:ascii="Times New Roman"/.test(xml) && /w:name="Times New Roman"/.test(fonts),
    formulas: (xml.match(/<m:oMath\b/g) || []).length,
    tables: (xml.match(/<w:tbl\b/g) || []).length,
    images: (xml.match(/<w:drawing\b/g) || []).length,
  };
}

// The handout picker shares the library's module tree; the directory is folded below 1680px.
async function choosePickerModule(picker, name) {
  const unfold = picker.getByRole('button', { name: '展开知识目录', exact: true });
  if (await unfold.count()) await unfold.click();
  const returnToModules = picker.getByRole('button', { name: '切换到模块题库', exact: true });
  if (await returnToModules.isVisible()) await returnToModules.click();
  await picker.locator('.picker-module-directory .module-root').filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\d+$`) }).click();
}

// --temporary exercises the current two-pane editor against a real isolated Worker.
// DOCX extraction/storage/export are real. PDF/image AI responses are deterministic fixtures, not OCR accuracy evidence.
async function verifyTemporaryLibrary() {
  const { module: target } = await api('/api/modules', { module: { name: '临时题库验收', subtitle: '' } });
  const { handout } = await api('/api/handouts', { handout: { title: '临时题库验收', items: [{ id: 'section-one', kind: 'section', title: '方程与图表', note: '' }] } });
  await page.goto(`${base}/tools/handouts?id=${handout.id}`);
  const picker = page.locator('.handout-bank');
  const cards = picker.locator('.picker-item');
  const saved = () => page.locator('.handout-save.saved').waitFor();
  const temporary = () => picker.getByRole('tab', { name: /临时题库/ }).click();
  const chooseFile = async file => {
    await picker.getByRole('button', { name: '导入文件', exact: true }).first().click();
    await page.locator('.file-import-modal input[type=file]').setInputFiles(file);
    await page.locator('.file-draft').first().waitFor();
  };
  await temporary();
  await chooseFile(join(out, 'fixture.docx'));
  assert.equal(await page.locator('.file-draft').count(), 2);
  let fail = true;
  await page.route(`**/api/handouts/${handout.id}`, route => {
    if (route.request().method() === 'PUT' && fail) { fail = false; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '验收注入：保存失败' }) }); }
    return route.continue();
  });
  await page.getByRole('button', { name: '保存所选 2 道题', exact: true }).click();
  await page.locator('.file-import-modal .recognition-warning').filter({ hasText: '保存失败' }).waitFor();
  assert.equal(await page.locator('.file-draft').count(), 2, 'a failed handout save keeps both review drafts');
  await page.getByRole('button', { name: '保存所选 2 道题', exact: true }).click();
  await page.locator('.file-import-modal').waitFor({ state: 'hidden' });
  await saved();
  await page.unroute(`**/api/handouts/${handout.id}`);
  assert.equal((await api('/api/library')).questions.length, 0, 'temporary import does not create formal questions');
  assert.equal((await api(`/api/handouts/${handout.id}`)).handout.temporaryQuestions.length, 2, 'retry is idempotent');
  const imported = (await api(`/api/handouts/${handout.id}`)).handout.temporaryQuestions;
  assert.equal(imported[0].type, '多选题');
  assert.equal(imported[0].answer, 'BD', 'all choice letters survive answer-section pairing');
  assert.match(imported[0].stem, /^（多选）/);
  assert.match(imported[0].stemDocxXml.join(''), />1．（多选）</);
  assert.doesNotMatch(imported[0].stemDocxXml.join(''), />（多<|>选）</);
  assert.equal(imported[1].type, '解答题', 'a per-question label never leaks to the following section');
  assert.match(imported[1].stem, /0\.5b=4/);
  assert.doesNotMatch(imported[1].stem, /声明|著作权/, 'a repeated copyright footer never interrupts a continued question');
  assert.match(imported[1].analysis, /0\.5b=4，[\s\S]*解得：b=8。[\s\S]*【点评】/, 'decimal-leading lines never truncate the original analysis');
  assert.ok(await cards.first().locator('.katex').count() > 0);
  assert.ok(await cards.nth(1).locator('table').count() > 0);
  await page.waitForFunction(() => [...document.querySelectorAll('.picker-item img')].every(img => img.complete && img.naturalWidth > 0));
  assert.ok(await cards.nth(1).locator('img').count() > 0);
  await page.screenshot({ path: join(out, 'temporary-import.png'), fullPage: true });
  step('temporary DOCX: 2 questions with native formula/table/figure, no formal records; failed save and retry preserve drafts');

  await cards.first().getByRole('button', { name: '＋ 选择', exact: true }).click();
  await cards.nth(1).getByRole('button', { name: '＋ 选择', exact: true }).click();
  await picker.getByRole('button', { name: '加入例题', exact: true }).click();
  await saved();
  assert.equal(await page.locator('.handout-question').count(), 2);
  assert.equal(await page.locator('.handout-question-foot small').filter({ hasText: '临时题库' }).count(), 2);
  await cards.first().getByRole('button', { name: '删除', exact: true }).click();
  assert.equal(await cards.count(), 2, 'used temporary questions cannot be deleted');
  await page.reload();
  await page.locator('.handout-question').nth(1).waitFor();
  await temporary();
  assert.equal(await cards.count(), 2);
  assert.equal(await picker.getByText('已在讲义中', { exact: true }).count(), 2);
  for (const sheet of ['小测', '作业']) {
    await page.locator('.handout-draft-head').getByRole('tab', { name: new RegExp(sheet) }).click();
    await cards.first().getByRole('button', { name: '＋ 选择', exact: true }).click();
    await picker.getByRole('button', { name: `加入${sheet}`, exact: true }).click();
    await saved();
    assert.equal(await page.locator('.handout-question').count(), 1);
  }
  await page.locator('.handout-draft-head').getByRole('tab', { name: /讲义/ }).click();
  step('temporary selection survives reload; the same question can serve handout, quiz and homework, never twice within a sheet');

  // Archive selections are independent of placement; a lost success response can be retried without another question.
  await cards.first().getByRole('checkbox').check();
  await picker.getByLabel('入库分类').selectOption(target.id);
  let loseResponse = true;
  await page.route('**/api/questions', async route => {
    if (route.request().method() === 'POST' && loseResponse) { loseResponse = false; await route.fetch(); return route.abort('failed'); }
    return route.continue();
  });
  await picker.getByRole('button', { name: '保存勾选 1 题', exact: true }).click();
  await picker.getByRole('button', { name: '保存勾选 1 题', exact: true }).waitFor();
  await page.unroute('**/api/questions');
  await page.locator('.app-toast.error .toast-close').click();
  await picker.getByRole('button', { name: '保存勾选 1 题', exact: true }).click();
  await cards.first().getByText('已存入正式题库', { exact: true }).waitFor();
  assert.equal((await api('/api/library')).questions.length, 1);
  assert.equal(await cards.first().getByRole('checkbox').isDisabled(), true);
  await cards.first().getByRole('button', { name: '校对', exact: true }).click();
  await page.getByRole('textbox', { name: '题干', exact: true }).fill('临时校对：方程 $\\frac{x}{2}=3$ 的解是（　　）');
  await page.getByRole('button', { name: '确认并保存', exact: true }).click();
  await page.locator('.question-modal').waitFor({ state: 'hidden' });
  await saved();
  assert.match((await api(`/api/handouts/${handout.id}`)).handout.temporaryQuestions[0].stem, /临时校对/);
  assert.doesNotMatch((await api('/api/library')).questions[0].stem, /临时校对/, 'editing the temporary snapshot never edits an archived original');
  await picker.getByRole('tab', { name: '正式题库', exact: true }).click();
  await choosePickerModule(picker, target.name);
  await cards.first().waitFor();
  assert.equal(await cards.count(), 1);
  await temporary();
  step('archive is opt-in and idempotent after a lost response; later temporary edits leave the formal original intact');

  // One-page real PDF and an existing image traverse the browser page reader and the background import job; only the
  // job service is substituted: it checks what was uploaded and answers as if the AI had read each page.
  const pdfPage = await browser.newPage();
  await pdfPage.setContent('<h1>1. Solve x + 2 = 5.</h1>');
  await pdfPage.pdf({ path: join(out, 'temporary-input.pdf') });
  await pdfPage.close();
  let recognizedFiles = [];
  const importJobs = new Map();
  // A regex, because a glob's ** stops at slashes unless it stands between them: /jobs/<id>/pages must be caught too.
  const jobsUrl = /\/api\/answer-studio\/jobs(?:[/?]|$)/;
  await page.route(jobsUrl, async route => {
    const request = route.request(), url = new URL(request.url()), [id, pages, pageId] = url.pathname.split('/').slice(4);
    const json = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (!id) {
      if (request.method() === 'GET') return json(url.searchParams.get('count') ? { count: 0 } : { jobs: [...importJobs.values()].reverse().map(entry => entry.job) });
      const input = request.postDataJSON(); assert.equal(input.kind, 'import');
      const job = { id: `import-${importJobs.size + 1}`, kind: 'import', title: input.title, status: 'uploading', stalled: false, pageCount: 0, processedCount: 0, questionCount: 0, progress: '', error: '', createdAt: Date.now(), updatedAt: Date.now() };
      importJobs.set(job.id, { job, pages: [], images: {} }); return json({ job });
    }
    const entry = importJobs.get(id);
    if (pages && pageId) { const [, data] = entry.images[pageId].split(','); return route.fulfill({ status: 200, contentType: 'image/jpeg', body: Buffer.from(data, 'base64') }); }
    if (pages) { const input = request.postDataJSON(); assert.match(input.image, /^data:image\/jpeg;base64,/); assert.match(input.recognizeImage, /^data:image\/jpeg;base64,/); entry.pages.push(input.page); entry.images[input.page.id] = input.image; return json({ job: entry.job }); }
    if (request.method() === 'POST') { recognizedFiles.push(entry.job.title); Object.assign(entry.job, { status: 'done', pageCount: entry.pages.length, processedCount: entry.pages.length, questionCount: entry.pages.length }); return json({ job: entry.job }); }
    if (request.method() === 'DELETE') { importJobs.delete(id); return json({ deleted: true }); }
    const question = { question_number: '1', type: '填空题', difficulty: '基础', stem: `流程样本 ${entry.job.title}：$x+2=5$，则 $x=$____。`, options: [], answer: '3', analysis: '移项。', source: '', tags: ['方程'], diagram_bbox: null, options_bbox: null, diagram_quality: null, confidence: 1, warnings: [], suggested_category_id: null };
    return json({ job: entry.job, draft: { version: 1, fileName: entry.job.title, categories: [], pages: entry.pages, results: Object.fromEntries(entry.pages.map(page => [page.id, { result: { questions: [question], answers: [] } }])), notes: [], updatedAt: Date.now() } });
  });
  for (const file of [join(out, 'temporary-input.pdf'), join(root, 'tests/fixtures/screenshot-number-line.png')]) {
    await picker.getByRole('button', { name: '导入文件', exact: true }).first().click();
    await page.locator('.file-import-modal input[type=file]').setInputFiles(file);
    await page.getByRole('status').filter({ hasText: '已转入后台' }).waitFor();
    await page.locator('.file-import-modal .studio-jobs tr').first().getByRole('button', { name: '打开', exact: true }).click();
    await page.locator('.file-draft').first().waitFor();
    await page.getByRole('button', { name: '保存所选 1 道题', exact: true }).click();
    await page.locator('.file-import-modal').waitFor({ state: 'hidden' });
    await saved();
  }
  await page.unroute(jobsUrl);
  assert.equal(recognizedFiles.length, 2);
  assert.equal(await cards.count(), 4);
  assert.equal((await api('/api/library')).questions.length, 1);
  await picker.getByLabel('来源文件').selectOption('temporary-input.pdf');
  assert.equal(await cards.count(), 1);
  await cards.first().getByRole('button', { name: '删除', exact: true }).click();
  await page.getByRole('dialog', { name: '删除临时题' }).getByRole('button', { name: '删除临时题', exact: true }).click();
  await saved();
  await picker.getByLabel('来源文件').selectOption('');
  assert.equal(await cards.count(), 3);
  step('PDF and PNG rendering/recognition-review/save wiring verified with stubbed AI; file filter and unused-question deletion work');

  // Export before archiving the second question proves temporary-only content needs no formal question row.
  for (const [label, key] of [['附答案', 'end'], ['教师版', 'each'], ['学生版', 'none']]) {
    await page.getByRole('button', { name: '快速排版', exact: true }).click();
    const modal = page.locator('.handout-typeset');
    await modal.locator('label', { hasText: label }).click();
    const downloading = page.waitForEvent('download');
    await modal.getByRole('button', { name: '其他格式', exact: true }).click();
    await modal.getByRole('button', { name: '导出 Word', exact: true }).click();
    const file = join(out, `temporary-${key}.docx`);
    await (await downloading).saveAs(file);
    await modal.getByRole('button', { name: '← 讲义编辑', exact: true }).click();
    await modal.waitFor({ state: 'hidden' });
    const docx = await inspectDocx(file);
    assert.ok(docx.songti && docx.timesNewRoman);
    assert.ok(docx.formulas >= 2 && docx.tables >= 1 && docx.images >= 1);
    for (const [run] of docx.xml.matchAll(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/g)) assert.doesNotMatch(run, /<m:oMath(?:Para)?\b/);
    assert.match(docx.text, /临时校对/);
    assert.match(docx.text, /根据下表/);
    if (key !== 'none') { assert.match(docx.text, /a[+]12=20/); assert.match(docx.text, /解得：b=8/); }
    result.exports[`temporary-${key}`] = { formulas: docx.formulas, tables: docx.tables, images: docx.images };
  }
  step('real browser Word exports: all 3 answer modes retain fonts, formula, table and image from temporary content');
  await page.screenshot({ path: join(out, 'temporary-desktop.png'), fullPage: true });
  // Made through the API with no course or topic, so the 讲义 waits under 专题库 → 未分板块.
  await page.goto(base + '/tools/handouts?shelf=topic&topic=unsorted');
  const entry = page.locator('.handout-entry', { hasText: '临时题库验收' });
  await entry.getByRole('button', { name: '临时题库验收 更多操作', exact: true }).click();
  await entry.getByRole('button', { name: '复制一份', exact: true }).click();
  await page.waitForURL(url => url.searchParams.has('id') && url.searchParams.get('id') !== handout.id);
  await page.locator('.handout-question').nth(1).waitFor();
  const copied = (await api(`/api/handouts/${new URL(page.url()).searchParams.get('id')}`)).handout;
  assert.equal(copied.temporaryQuestions.length, 3);
  assert.equal(copied.items.filter(item => item.kind === 'quiz').length, 1);
  assert.equal(copied.items.filter(item => item.kind === 'homework').length, 1);
  step('copying a handout preserves the temporary bank and all three sheets');
}

// The UI, image decoding/cropping/uploads and D1 saves are real; only AI replies are held and supplied here.
async function verifyNoteQueue(pngUrl) {
  const { handout } = await api('/api/handouts', { handout: { title: '知识点识别队列验收', items: ['a', 'b', 'c', 'd'].map(id => ({ id, kind: 'section', title: `知识模块 ${id}`, note: `原有知识 ${id}` })) } });
  await page.goto(`${base}/tools/handouts?id=${handout.id}`);
  await page.getByRole('textbox', { name: '模块四知识点', exact: true }).waitFor();
  const fixtures = await page.evaluate(async source => {
    const img = new Image(); img.src = source; await img.decode();
    return Object.fromEntries(['a1', 'a2', 'a3', 'b1', 'c1', 'd1', 'd2', 'c2'].map(label => {
      const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0); ctx.fillStyle = '#111'; ctx.font = '16px sans-serif'; ctx.fillText(label, 4, 20);
      return [label, canvas.toDataURL('image/png')];
    }));
  }, pngUrl);
  const calls = new Map(); const active = new Set(); let peak = 0;
  await page.route('**/api/recognize-note', route => {
    const image = route.request().postDataJSON().image;
    const label = Object.keys(fixtures).find(key => fixtures[key] === image);
    assert.ok(label, 'each request carries the submitted screenshot');
    assert.ok(!calls.has(label), 'a screenshot is submitted only once');
    calls.set(label, route); active.add(label); peak = Math.max(peak, active.size);
  });
  const lane = id => page.locator(`#knowledge-${id}`);
  const editor = id => lane(id).getByRole('textbox');
  const call = async label => {
    for (let i = 0; i < 300 && !calls.has(label); i++) await delay(20);
    assert.ok(calls.has(label), `recognition starts for ${label}`);
    assert.ok(peak <= 2, 'at most two recognition requests run together');
    return calls.get(label);
  };
  const submit = async (id, label, method = 'paste') => {
    if (method === 'file') {
      const chooser = page.waitForEvent('filechooser');
      await lane(id).getByRole('button', { name: '截图识别', exact: true }).click();
      await (await chooser).setFiles({ name: `${label}.png`, mimeType: 'image/png', buffer: Buffer.from(fixtures[label].split(',')[1], 'base64') });
    } else await editor(id).evaluate((target, { source, label, method }) => {
      const bytes = Uint8Array.from(atob(source.split(',')[1]), c => c.charCodeAt(0));
      const data = new DataTransfer(); data.items.add(new File([bytes], `${label}.png`, { type: 'image/png' }));
      target.focus();
      target.dispatchEvent(method === 'paste' ? new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }) : new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    }, { source: fixtures[label], label, method });
  };
  const finish = async (label, failed = false, figure = false) => {
    const route = await call(label); active.delete(label);
    await route.fulfill({ status: failed ? 503 : 200, contentType: 'application/json', body: JSON.stringify(failed ? { error: '验收：模型繁忙' } : { result: { warnings: [], blocks: [
      { type: 'paragraph', text: `识别结果 ${label}：$y=\\frac{k}{x}$` },
      ...(figure ? [{ type: 'figures', side: '', sideBox: null, figures: [{ bbox: { x: 0, y: 0, width: 1000, height: 1000 }, caption: '识别配图', captionBox: null }] }] : []),
    ] } }) });
  };
  const pasteText = async id => {
    await editor(id).press('ControlOrMeta+A');
    await editor(id).evaluate((target, id) => {
      const data = new DataTransfer(); data.setData('text/plain', `原有知识 ${id}\n手动补充`);
      target.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    }, id);
    assert.match(await editor(id).innerText(), /手动补充/, 'normal text paste works while recognition is pending');
  };
  await submit('a', 'a1', 'file'); await call('a1');
  // These two pastes share a browser turn, exercising synchronous enqueue protection.
  await editor('a').evaluate((target, sources) => {
    for (const [label, source] of sources) {
      const data = new DataTransfer(); data.items.add(new File([Uint8Array.from(atob(source.split(',')[1]), c => c.charCodeAt(0))], `${label}.png`, { type: 'image/png' }));
      target.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    }
  }, [['a2', fixtures.a2], ['a3', fixtures.a3]]);
  await submit('b', 'b1'); await call('b1');
  await submit('c', 'c1', 'drop'); await submit('d', 'd1', 'file');
  await lane('a').getByRole('status').filter({ hasText: '正在识别… · 排队 2 张' }).waitFor();
  await lane('c').getByRole('status').filter({ hasText: '排队 1 张' }).waitFor();
  assert.deepEqual([...calls.keys()], ['a1', 'b1'], 'other modules queue without losing pasted or dropped screenshots');
  for (const id of ['a', 'b', 'c', 'd']) assert.equal(await lane(id).getByRole('button', { name: '截图识别', exact: true }).isEnabled(), true);
  await pasteText('a'); await pasteText('c');
  assert.equal(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), true);
  await page.locator('.handout-draft-head').getByRole('tab', { name: /小测/ }).click();
  await finish('b1'); await call('c1');
  await page.locator('.handout-draft-head').getByRole('tab', { name: /讲义/ }).click();
  await editor('b').getByText(/识别结果 b1/).waitFor();
  await lane('a').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(out, 'note-queue-desktop.png'), fullPage: true });
  step('continuous file/paste/drop submissions: two modules run concurrently, same-module images queue in order, text stays editable and sheet switches preserve jobs');

  await finish('c1', true); await call('d1');
  await page.locator('.app-toast.error').filter({ hasText: 'c1.png：验收：模型繁忙' }).waitFor();
  await submit('d', 'd2');
  await page.locator('#module-d').getByRole('button', { name: '模块更多操作', exact: true }).click();
  await page.getByRole('button', { name: '删除模块…', exact: true }).click();
  await page.getByRole('dialog', { name: '删除知识模块「知识模块 d」', exact: true }).getByRole('button', { name: '删除知识模块', exact: true }).click();
  await finish('d1');
  await finish('a1', false, true); await call('a2');
  await finish('a2', true); await call('a3');
  await finish('a3');
  await lane('a').getByRole('status').waitFor({ state: 'detached' });
  await page.locator('.handout-save.saved').waitFor();
  assert.deepEqual([...calls.keys()], ['a1', 'b1', 'c1', 'd1', 'a2', 'a3'], 'failed jobs release slots and deleted-module screenshots never start');
  assert.equal(peak, 2);
  const saved = (await api(`/api/handouts/${handout.id}`)).handout;
  assert.deepEqual(saved.items.map(item => item.id), ['a', 'b', 'c']);
  assert.match(saved.items[0].note, /^原有知识 a\n手动补充\n识别结果 a1：[\s\S]*识别结果 a3：/);
  assert.doesNotMatch(saved.items[0].note, /结果 a2|结果 b1|结果 c1|结果 d1/);
  assert.match(saved.items[1].note, /^原有知识 b\n识别结果 b1：/);
  assert.equal(saved.items[2].note, '原有知识 c\n手动补充');
  await page.reload();
  await editor('a').getByText(/识别结果 a3/).waitFor();
  assert.ok(await editor('a').locator('.katex').count() > 0);
  await editor('a').locator('.note-figure img:not(.ProseMirror-separator)').evaluate(async img => { await img.decode(); if (!img.naturalWidth) throw Error('figure did not load'); });
  assert.equal(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), false);
  await lane('a').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(out, 'note-queue-saved.png'), fullPage: true });
  step('out-of-order replies save to their own modules; failures continue the queue, deleted targets stay deleted; manual text, formulas and cropped figures survive reload');

  // A decoding failure before any request also frees its slot; the next valid screenshot still succeeds.
  const brokenChooser = page.waitForEvent('filechooser');
  await lane('c').getByRole('button', { name: '截图识别', exact: true }).click();
  await (await brokenChooser).setFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not a valid image') });
  await page.locator('.app-toast.error').filter({ hasText: '无法读取这张图片' }).waitFor();
  await submit('c', 'c2'); await finish('c2');
  await lane('c').getByRole('status').waitFor({ state: 'detached' });
  await page.locator('.handout-save.saved').waitFor();
  assert.match((await api(`/api/handouts/${handout.id}`)).handout.items[2].note, /手动补充\n识别结果 c2/);
  await page.unroute('**/api/recognize-note');
  step('invalid-image decoding does not stall later submissions; pending work warns before leaving and a completed queue removes the warning');
}

async function verifyNoteTables() {
  const at = (x, y, width, height) => ({ x: x / 1088 * 1000, y: y / 772 * 1000, width: width / 1088 * 1000, height: height / 772 * 1000 });
  const cell = (text, bbox, colSpan = 1, figures = []) => ({ text, bbox, colSpan, rowSpan: 1, figures });
  const figure = x => ({ bbox: at(x, 355, 145, 145), caption: '', captionBox: null });
  const rows = [
    [cell('反比例函数', at(24, 16, 250, 103)), cell('$y=\\frac{k}{x}$（$k$ 为常数，$k\\ne0$）', at(274, 16, 769, 103), 2)],
    [cell('$x$、$y$ 的取值范围', at(24, 119, 250, 103)), cell('$x\\ne0$、$y\\ne0$（与坐标轴无交点）', at(274, 119, 769, 103), 2)],
    [cell('$k$ 的符号', at(24, 222, 250, 103)), cell('$k>0$', at(274, 222, 385, 103)), cell('$k<0$', at(659, 222, 384, 103))],
    [cell('图像', at(24, 325, 250, 201)), cell('', at(274, 325, 385, 201), 1, [figure(395)]), cell('', at(659, 325, 384, 201), 1, [figure(780)])],
    [cell('图像的位置', at(24, 526, 250, 103)), cell('两支曲线分别位于第**一、三**象限', at(274, 526, 385, 103)), cell('两支曲线分别位于第**二、四**象限', at(659, 526, 384, 103))],
    [cell('性质', at(24, 629, 250, 110)), cell('在每一象限内，$y$ 的值随 $x$ 值的**增大而减小**', at(274, 629, 385, 110)), cell('在每一象限内，$y$ 的值随 $x$ 值的**增大而增大**', at(659, 629, 384, 110))],
  ];
  const { module } = await api('/api/modules', { scope: 'mine', module: { name: '表格验收', subtitle: '' } });
  await api('/api/questions', { scope: 'mine', question: { id: 'table-test-q', moduleId: module.id, categoryId: module.id, type: '填空题', difficulty: '基础', stem: '若 $xy=2$，则 $k=$____。', options: [], answer: '2', analysis: '', source: '', createdAt: Date.now(), updatedAt: Date.now() } });
  const { handout } = await api('/api/handouts', { handout: { title: '知识点表格回归', items: [{ id: 'table-section', kind: 'section', title: '反比例函数', note: '截图前的原有知识' }, { id: 'table-q-ref', kind: 'question', scope: 'mine', questionId: 'table-test-q', band: 'practice' }] } });
  await page.route('**/api/recognize-note', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: { warnings: [], blocks: [{ type: 'table', bbox: at(23, 15, 1022, 726), rows }] } }) }));
  await page.goto(`${base}/tools/handouts?id=${handout.id}`);
  const note = page.getByRole('textbox', { name: '模块一知识点' });
  const lane = page.locator('#knowledge-table-section');
  const chooser = page.waitForEvent('filechooser');
  await lane.getByRole('button', { name: '截图识别', exact: true }).click();
  await (await chooser).setFiles(join(root, 'tests/fixtures/note-comparison-table.png'));
  const table = note.locator('table.note-table').first();
  await table.locator('tr').nth(5).waitFor();
  assert.equal(await table.locator('tr').count(), 6);
  assert.equal(await table.locator('td').count(), 16);
  assert.equal(await table.locator('td[colspan="2"]').count(), 2);
  assert.equal(await table.locator('.math-render-error').count(), 0);
  assert.ok(await table.locator('.katex').count() >= 8);
  assert.match(await note.innerText(), /^截图前的原有知识/);
  const graphSizes = await table.locator('.note-figure-frame>img').evaluateAll(async images => Promise.all(images.map(async img => { await img.decode(); return [img.naturalWidth, img.naturalHeight]; })));
  assert.equal(graphSizes.length, 2);
  for (const [width, height] of graphSizes) assert.ok(width > 200 && width < 350 && height > 200 && height < 350, `clean graph ${width}×${height}, with no table frame`);
  await lane.screenshot({ path: join(out, 'note-table-import.png') });
  step('original screenshot enters as one editable 6-row table, two merged cells, native formulas and two clean graphs in their cells');

  await table.locator('td').first().click();
  await page.keyboard.press('Meta+ArrowRight');
  await page.keyboard.type('（校对）');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => getSelection()?.anchorNode?.parentElement?.closest('td')?.colSpan), 2);
  await page.keyboard.press('Shift+Tab');
  assert.match(await page.evaluate(() => getSelection()?.anchorNode?.parentElement?.closest('td')?.innerText), /反比例函数/);
  await table.locator('.note-math').first().click();
  const formula = page.getByRole('dialog', { name: '编辑公式' });
  await formula.getByRole('textbox').fill('y=\\frac{2k}{x}');
  await formula.getByRole('button', { name: '确定', exact: true }).click();
  await table.locator('td').last().click();
  await page.keyboard.press('Meta+ArrowRight');
  await page.keyboard.press('Tab');
  await page.keyboard.type('表格后的补充');
  assert.equal(await page.evaluate(() => Boolean(getSelection()?.anchorNode?.parentElement?.closest('table'))), false);
  const vertical = noteTableMarkup([
    [{ content: '横向且纵向合并', colSpan: 2, rowSpan: 2 }, { content: '$a=1$', colSpan: 1, rowSpan: 1 }],
    [{ content: '末格', colSpan: 1, rowSpan: 1 }],
    [{ content: '', colSpan: 1, rowSpan: 1 }, { content: '$b=2$', colSpan: 1, rowSpan: 1 }, { content: '保留空格', colSpan: 1, rowSpan: 1 }],
  ]);
  await note.evaluate((target, text) => {
    const data = new DataTransfer(); data.setData('text/plain', '\n' + text);
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, vertical);
  await note.locator('td[rowspan="2"]').waitFor();
  await lane.getByRole('button', { name: '完成', exact: true }).click();
  await page.locator('.handout-save.saved').waitFor();
  const saved = (await api(`/api/handouts/${handout.id}`)).handout;
  assert.match(saved.items[0].note, /反比例函数（校对）/);
  assert.match(saved.items[0].note, /y=\\frac\{2k\}\{x\}/);
  assert.match(saved.items[0].note, /表格后的补充/);
  await page.reload();
  await note.locator('td[rowspan="2"]').waitFor();
  assert.equal(await note.locator('table.note-table').count(), 2);
  assert.equal(await note.locator('.note-figure-frame>img').count(), 2);
  assert.equal(await note.locator('.math-render-error').count(), 0);
  await lane.screenshot({ path: join(out, 'note-table-edited.png') });
  step('cell text and formula editing, Tab/Shift+Tab, leaving the table, a vertical merge, empty cells and save/reload all preserve the table');

  await page.getByRole('button', { name: '快速排版', exact: true }).click();
  const modal = page.locator('.handout-typeset');
  const download = page.waitForEvent('download');
  await modal.getByRole('button', { name: '其他格式', exact: true }).click();
  await modal.getByRole('button', { name: '导出 Word', exact: true }).click();
  const file = join(out, 'note-table.docx');
  await (await download).saveAs(file);
  const docx = await inspectDocx(file);
  assert.ok(docx.songti && docx.timesNewRoman);
  assert.ok(docx.formulas >= 1);
  assert.equal(docx.images, 2);
  assert.match(docx.xml, /<w:gridSpan w:val="2"/);
  assert.match(docx.xml, /<w:vMerge w:val="restart"/);
  assert.match(docx.xml, /<w:vMerge w:val="continue"/);
  assert.doesNotMatch(docx.text, /multicolumn|begin\{array\}/);
  result.exports.table = { formulas: docx.formulas, tables: docx.tables, images: docx.images, graphSizes };
  await writeFile(join(out, 'note-table-saved.json'), JSON.stringify(saved, null, 2));
  await page.unroute('**/api/recognize-note');
  step('actual browser Word export contains editable tables, horizontal and vertical merges, native formulas, the two figures and the edited content');
}

// Real browser + isolated D1: custom outlines share the existing handout editor.
async function verifyCourses() {
  await page.goto(base + '/tools/handouts');
  await page.getByRole('heading', { name: '深圳创新体系', exact: true }).waitFor();
  // 深圳创新体系 with 3 grades × 4 terms (16 nodes), plus 专题库 and its 5 topics (6 nodes).
  assert.equal((await api('/api/handouts')).courseNodes.length, 22);
  const addNode = async (button, name) => {
    await page.getByRole('button', { name: button, exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('名称', { exact: true }).fill(name);
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
  };
  const nodeMenu = async name => {
    await page.locator('.handout-nav-row').getByRole('button', { name: `${name} 目录操作`, exact: true }).click();
    return page.getByRole('group', { name: `${name} 目录操作`, exact: true });
  };
  const lessonMenu = async title => {
    await page.getByRole('button', { name: `${title} 更多操作`, exact: true }).click();
    return page.getByRole('group', { name: `${title} 更多操作`, exact: true });
  };
  await addNode('新建体系', 'DIY 数学');
  await addNode('＋ 添加年级 / 阶段', '基础阶段');
  await addNode('＋ 添加学期 / 单元', '代数单元');
  const originUrl = page.url();
  const systemId = new URL(originUrl).searchParams.get('course');
  const stageId = new URL(originUrl).searchParams.get('stage');
  await page.reload();
  await page.getByRole('heading', { name: 'DIY 数学', exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('stage'), stageId);
  await page.getByRole('heading', { name: '代数单元', exact: true }).waitFor();
  await page.goto(base + '/tools/handouts?shelf=course&grade=8');
  await page.getByRole('heading', { name: '深圳创新体系', exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('stage'), 'course-grade-8');
  await page.goto(originUrl);
  await page.getByRole('heading', { name: 'DIY 数学', exact: true }).waitFor();
  step('create an empty system, custom stage and custom unit; reload retains names and active location; old grade links still select the original course');

  await page.getByRole('button', { name: '＋ 添加讲次', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '新建一讲' });
  assert.equal(await dialog.getByLabel('讲次', { exact: true }).inputValue(), '1');
  await dialog.getByLabel('讲次', { exact: true }).fill('8');
  await dialog.getByLabel('本讲标题').fill('代数基础');
  await dialog.getByLabel('模块大纲', { exact: false }).fill('整式的概念\n合并同类项');
  let fail = true;
  await page.route('**/api/handouts', route => {
    if (route.request().method() === 'POST' && fail) { fail = false; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '验收注入：暂时无法保存' }) }); }
    return route.continue();
  });
  await dialog.getByRole('button', { name: '保存大纲', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: '暂时无法保存' }).waitFor();
  assert.equal(await dialog.getByLabel('本讲标题').inputValue(), '代数基础');
  assert.equal(await dialog.getByLabel('讲次', { exact: true }).inputValue(), '8');
  await dialog.getByRole('button', { name: '保存大纲', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.unroute('**/api/handouts');
  await page.locator('.handout-entry').filter({ hasText: '代数基础' }).waitFor();
  assert.equal((await api('/api/handouts')).handouts.length, 1);
  assert.deepEqual(await page.locator('.handout-entry-no').allTextContents(), ['8']);
  await page.getByRole('button', { name: '＋ 添加讲次', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '新建一讲' });
  assert.equal(await dialog.getByLabel('讲次', { exact: true }).inputValue(), '9');
  await dialog.getByLabel('讲次', { exact: true }).fill('3');
  await dialog.getByLabel('本讲标题').fill('函数初步');
  await dialog.getByRole('button', { name: '保存并编写讲义', exact: true }).click();
  await page.locator('.handout-title').waitFor();
  assert.equal(await page.locator('.handout-title').inputValue(), '函数初步');
  assert.equal((await api(`/api/handouts/${new URL(page.url()).searchParams.get('id')}`)).handout.position, 2);
  await page.getByRole('link', { name: '返回讲义书架', exact: true }).click();
  await page.locator('.handout-entry').nth(1).waitFor();
  assert.deepEqual(await page.locator('.handout-entry strong').allTextContents(), ['函数初步', '代数基础']);
  assert.deepEqual(await page.locator('.handout-entry-no').allTextContents(), ['3', '8']);
  await page.getByRole('button', { name: '＋ 添加讲次', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '新建一讲' });
  await dialog.getByLabel('本讲标题').fill('讲次校验');
  for (const invalid of ['', '0', '-2', '1.5']) {
    await dialog.getByLabel('讲次', { exact: true }).fill(invalid);
    await dialog.getByRole('button', { name: '保存并编写讲义', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: '讲次请填写正整数' }).waitFor();
  }
  await dialog.getByLabel('讲次', { exact: true }).fill('8');
  await dialog.getByRole('button', { name: '保存大纲', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: '第8讲已存在' }).waitFor();
  assert.equal(await dialog.getByLabel('本讲标题').inputValue(), '讲次校验');
  assert.equal((await api('/api/handouts')).handouts.length, 2);
  await page.screenshot({ path: join(out, 'lesson-number-dialog.png'), fullPage: true });
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await (await lessonMenu('代数基础')).getByRole('button', { name: '上移', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.handout-entry strong')?.textContent === '代数基础');
  await page.reload();
  await page.locator('.handout-entry').nth(1).waitFor();
  assert.equal(await page.locator('.handout-entry strong').first().innerText(), '代数基础');
  assert.deepEqual(await page.locator('.handout-entry-no').allTextContents(), ['3', '8']);
  await page.screenshot({ path: join(out, 'lesson-numbers-desktop.png'), fullPage: true });
  step('create lesson 8 directly, backfill lesson 3 and open its editor; failed save retains number and outline; invalid/duplicate numbers are refused; reorder and reload retain sparse lesson slots');

  await page.locator('.handout-entry').filter({ hasText: '代数基础' }).getByRole('link').click();
  await page.locator('.handout-module').nth(1).waitFor();
  assert.deepEqual(await page.locator('.handout-module-head input').evaluateAll(inputs => inputs.map(input => input.value)), ['整式的概念', '合并同类项']);
  const lessonId = new URL(page.url()).searchParams.get('id');
  const saved = page.waitForResponse(response => response.url().endsWith(`/api/handouts/${lessonId}`) && response.request().method() === 'PUT' && response.ok());
  await page.locator('.handout-module-head input').first().fill('整式与多项式');
  await page.locator('.handout-module-head input').first().blur();
  await saved;
  await page.reload();
  await page.locator('.handout-module').nth(1).waitFor();
  assert.equal(await page.locator('.handout-module-head input').first().inputValue(), '整式与多项式');
  for (const name of ['小测', '作业', '讲义']) await page.locator('.handout-draft-head').getByRole('tab', { name: new RegExp(name) }).click();
  await page.getByRole('link', { name: '返回讲义书架', exact: true }).click();
  await page.getByRole('heading', { name: 'DIY 数学', exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('course'), systemId);
  assert.equal(new URL(page.url()).searchParams.get('stage'), stageId);
  await (await nodeMenu('DIY 数学')).getByRole('button', { name: '重命名', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '重命名目录' });
  await dialog.getByLabel('名称', { exact: true }).fill('我的数学体系');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal((await api(`/api/handouts/${lessonId}`)).handout.coursePath[0].name, '我的数学体系');
  for (const cancel of ['取消', 'Escape', '关闭']) {
    await (await nodeMenu('我的数学体系')).getByRole('button', { name: '删除目录…', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '删除目录「我的数学体系」' });
    assert.match(await dialog.innerText(), /2 个下级目录/);
    assert.match(await dialog.innerText(), /2 份讲义/);
    assert.match(await dialog.innerText(), /无法恢复.*正式题库/);
    if (cancel === 'Escape') await page.keyboard.press('Escape');
    else await dialog.getByRole('button', { name: cancel, exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal((await api('/api/handouts')).handouts.length, 2);
  }
  await addNode('＋ 添加学期 / 单元', '几何单元');
  await page.getByRole('region', { name: '我的数学体系 / 基础阶段 / 几何单元', exact: true }).getByRole('button', { name: '几何单元 目录操作', exact: true }).click();
  await page.getByRole('group', { name: '几何单元 目录操作' }).getByRole('button', { name: '上移', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.handout-column h2')?.textContent === '几何单元');
  await page.reload();
  await page.locator('.handout-column h2').first().waitFor();
  assert.equal(await page.locator('.handout-column h2').first().innerText(), '几何单元');
  step('edit and reload a lesson; return to its system; deletion lists descendants and lectures; cancel, Escape and close retain content; unit order persists');

  await addNode('新建体系', '另一套课程');
  await addNode('＋ 添加年级 / 阶段', '进阶阶段');
  await addNode('＋ 添加学期 / 单元', '第一单元');
  const targetUrl = page.url();
  await page.goto(originUrl);
  await page.locator('.handout-entry').filter({ hasText: '代数基础' }).waitFor();
  await (await lessonMenu('代数基础')).getByRole('button', { name: '复制一份', exact: true }).click();
  await page.locator('.handout-module').nth(1).waitFor();
  const copyId = new URL(page.url()).searchParams.get('id');
  assert.notEqual(copyId, lessonId);
  await page.getByRole('link', { name: '返回讲义书架', exact: true }).click();
  await page.locator('.handout-entry').filter({ hasText: '代数基础（副本）' }).waitFor();
  await (await lessonMenu('代数基础（副本）')).getByRole('button', { name: '移到…', exact: true }).click();
  await page.getByLabel('目标课程单元').selectOption({ label: '另一套课程 / 进阶阶段 / 第一单元' });
  await page.getByRole('dialog', { name: '移到', exact: true }).getByRole('button', { name: '确定', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '已移到' }).waitFor();
  await page.goto(targetUrl);
  await page.locator('.handout-entry').filter({ hasText: '代数基础（副本）' }).waitFor();
  assert.equal((await api(`/api/handouts/${lessonId}`)).handout.coursePath[0].id, systemId);
  assert.equal((await api(`/api/handouts/${copyId}`)).handout.coursePath[0].name, '另一套课程');
  await page.screenshot({ path: join(out, 'courses-desktop.png'), fullPage: true });
  step('copy and move a lesson across systems without affecting source');

  await page.getByRole('searchbox', { name: '查找讲义' }).fill('代数基础');
  assert.equal(await page.locator('.handout-entry').count(), 2);
  let failDelete = true;
  await page.route('**/api/handout-courses', route => {
    if (route.request().method() === 'DELETE' && failDelete) {
      failDelete = false;
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '验收注入：目录删除失败' }) });
    }
    return route.continue();
  });
  for (const attempt of ['failed', 'retry']) {
    await (await nodeMenu('我的数学体系')).getByRole('button', { name: '删除目录…', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '删除目录「我的数学体系」' });
    assert.match(await dialog.innerText(), /3 个下级目录/);
    assert.match(await dialog.innerText(), /2 份讲义/);
    if (attempt === 'retry') await page.screenshot({ path: join(out, 'directory-delete-confirm.png'), fullPage: true });
    await dialog.getByRole('button', { name: '删除目录', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    if (attempt === 'failed') {
      await page.getByRole('alert').filter({ hasText: '目录删除失败' }).waitFor();
      assert.equal(await page.locator('.handout-entry').count(), 2);
      assert.equal((await api(`/api/handouts/${lessonId}`)).handout.coursePath[0].id, systemId);
    }
  }
  await page.unroute('**/api/handout-courses');
  await page.getByRole('status').filter({ hasText: '目录已删除' }).waitFor();
  assert.equal(await page.getByRole('button', { name: '我的数学体系 目录操作', exact: true }).count(), 0);
  assert.deepEqual(await page.locator('.handout-entry strong').allTextContents(), ['代数基础（副本）']);
  const after = await api('/api/handouts');
  assert.ok(!after.courseNodes.some(node => node.id === systemId || node.id === stageId));
  assert.deepEqual(after.handouts.map(item => item.id), [copyId]);
  await page.screenshot({ path: join(out, 'directory-delete-search.png'), fullPage: true });
  await page.reload();
  await page.getByRole('heading', { name: '另一套课程', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '我的数学体系 目录操作', exact: true }).count(), 0);
  await page.locator('.handout-entry').filter({ hasText: '代数基础（副本）' }).waitFor();
  step('nonempty system deletion: failed request retains content; retry deletes all descendants and lectures, updates search immediately, preserves the other system after reload');

  const topic = await api('/api/handout-courses', { name: '专题删除验收', parentId: 'topic-library' });
  const outline = await api('/api/handout-courses', { name: '专题大纲', parentId: topic.id });
  const group = await api('/api/handout-courses', { name: '待删除专题', parentId: outline.id });
  await api('/api/handout-courses', { name: '空专题', parentId: outline.id });
  for (const [domain, title] of [[topic.id, '分类直属讲义'], [outline.id, '大纲直属讲义'], [group.id, '专题第一讲'], [group.id, '专题第二讲']]) {
    await api('/api/handouts', { handout: { title, domain, items: [] } });
  }
  await page.goto(`${base}/tools/handouts?shelf=topic&topic=${outline.id}`);
  await page.locator('.handout-entry').filter({ hasText: '专题第一讲' }).waitFor();
  const topicColumn = page.getByRole('region', { name: '专题删除验收 / 专题大纲 / 待删除专题', exact: true });
  await topicColumn.getByRole('button', { name: '＋ 添加讲次', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '新建一讲' });
  await dialog.getByLabel('讲次', { exact: true }).fill('12');
  await dialog.getByLabel('本讲标题').fill('专题第十二讲');
  await dialog.getByRole('button', { name: '保存大纲', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.reload();
  await topicColumn.locator('.handout-entry').nth(2).waitFor();
  assert.deepEqual(await topicColumn.locator('.handout-entry-no').allTextContents(), ['1', '2', '12']);
  await (await lessonMenu('专题第二讲')).getByRole('button', { name: '删除…', exact: true }).click();
  await page.getByRole('dialog', { name: '删除讲义「专题第二讲」' }).getByRole('button', { name: '删除讲义', exact: true }).click();
  await topicColumn.locator('.handout-entry').filter({ hasText: '专题第二讲' }).waitFor({ state: 'detached' });
  assert.deepEqual(await topicColumn.locator('.handout-entry-no').allTextContents(), ['1', '12']);
  step('topic groups also accept arbitrary lesson numbers; deleting an earlier lesson keeps lesson 12 unchanged');
  for (const [name, children, lectures] of [['待删除专题', 0, 2], ['专题大纲', 1, 1], ['专题删除验收', 0, 1]]) {
    await page.getByRole('button', { name: `${name} 目录操作`, exact: true }).click();
    await page.getByRole('group', { name: `${name} 目录操作`, exact: true }).getByRole('button', { name: '删除目录…', exact: true }).click();
    dialog = page.getByRole('dialog', { name: `删除目录「${name}」` });
    assert.match(await dialog.innerText(), new RegExp(`${children} 个下级目录`));
    assert.match(await dialog.innerText(), new RegExp(`${lectures} 份讲义`));
    const deleted = page.waitForResponse(response => response.url().endsWith('/api/handout-courses') && response.request().method() === 'DELETE' && response.ok());
    await dialog.getByRole('button', { name: '删除目录', exact: true }).click();
    await deleted;
    await page.getByRole('button', { name: `${name} 目录操作`, exact: true }).waitFor({ state: 'detached' });
    if (name === '专题大纲') await page.locator('.handout-entry').filter({ hasText: '分类直属讲义' }).waitFor();
  }
  await page.reload();
  await page.getByRole('heading', { name: '函数', exact: true }).waitFor();
  assert.deepEqual((await api('/api/handouts')).handouts.map(item => item.id), [copyId]);
  assert.ok((await api('/api/handouts')).courseNodes.some(node => node.id === 'topic-library'));
  await page.screenshot({ path: join(out, 'directory-delete-topic.png'), fullPage: true });
  step('topic group, selected outline and category deletion remove their lectures and legacy direct lectures; selection returns to the parent and persists after reload');
}

try {
  for (let i = 0; i < 200; i++) {
    if (worker.exitCode !== null) throw Error(workerLog);
    try { if ((await fetch(base + '/api/auth/me')).ok) break; } catch { /* waiting for the isolated worker */ }
    await delay(100);
  }
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  page.setDefaultTimeout(20000);
  page.on('pageerror', e => result.pageErrors.push(String(e)));
  page.on('dialog', dialog => dialog.accept());

  // A real diagram image, drawn by the browser itself.
  await page.goto(base + '/api/auth/me');
  const pngUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 200;
    const c = canvas.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, 320, 200); c.strokeStyle = '#111'; c.lineWidth = 3;
    c.beginPath(); c.moveTo(40, 170); c.lineTo(280, 170); c.lineTo(160, 30); c.closePath(); c.stroke();
    c.fillStyle = '#111'; c.font = 'italic 22px serif'; c.fillText('A', 152, 24); c.fillText('B', 18, 186); c.fillText('C', 288, 186);
    return canvas.toDataURL('image/png');
  });
  const png = Buffer.from(pngUrl.split(',')[1], 'base64');
  await writeFile(join(out, 'diagram.png'), png);
  await writeFile(join(out, 'fixture.docx'), await wordFixture(png));
  if (process.argv.includes('--note-tables')) {
    await verifyNoteTables();
  } else if (process.argv.includes('--notes')) {
    await verifyNoteQueue(pngUrl);
  } else if (process.argv.includes('--courses')) {
    await verifyCourses();
  } else if (process.argv.includes('--temporary')) {
    await verifyTemporaryLibrary();
  } else {

  // Seed: one module with categories in 我的题库, one public question.
  const { module: mine } = await api('/api/modules', { module: { name: '初一数学', subtitle: '' }, scope: 'mine' });
  const category = id => ({ id, name: id === 'cat-eq' ? '一元一次方程' : '有理数', moduleId: mine.id, parentId: mine.id, createdAt: Date.now() });
  await api('/api/categories', { category: category('cat-eq'), scope: 'mine' });
  await api('/api/categories', { category: category('cat-rational'), scope: 'mine' });
  const seed = (id, categoryId, type, stem, extra = {}) => api('/api/questions', { scope: 'mine', question: { id, moduleId: mine.id, categoryId, type, difficulty: '基础', provenance: '来源待核实', stem, options: [], answer: '', analysis: '', source: '', createdAt: Date.now(), updatedAt: Date.now(), ...extra } });
  await seed('seed-1', 'cat-eq', '单选题', '方程 $2x+1=5$ 的解是（　　）', { options: ['$x=1$', '$x=2$', '$x=3$', '$x=4$'], answer: 'B', analysis: '【分析】移项后系数化为 1。\n【解答】$2x=4$，$x=2$，故选 B。' });
  await seed('seed-2', 'cat-eq', '填空题', '若 $\\frac{x}{3}=2$，则 $x=$____。', { answer: '6', analysis: '两边同乘 3。' });
  await seed('seed-3', 'cat-eq', '解答题', '如图，三角形 ABC 的周长为 24，AB=AC，BC=6，求 AB 的长。', { answer: 'AB=9', analysis: '设 AB=x，则 $2x+6=24$，$x=9$。', contentImages: [pngUrl], imageLayout: 'right' });
  await seed('seed-4', 'cat-rational', '单选题', '$-3$ 的相反数是（　　）', { options: ['$3$', '$-3$', '$\\frac{1}{3}$', '$-\\frac{1}{3}$'], answer: 'A', analysis: '相反数只改变符号。' });
  await seed('seed-5', 'cat-eq', '解答题', '解方程：$3(x-1)=2x+5$。', { answer: '$x=8$', analysis: '去括号得 $3x-3=2x+5$，移项得 $x=8$。' });
  const publicModule = (await api('/api/modules', { module: { name: '公共示例', subtitle: '' }, scope: 'public' })).module;
  await api('/api/questions', { scope: 'public', question: { id: 'public-1', moduleId: publicModule.id, categoryId: publicModule.id, type: '填空题', difficulty: '中等', provenance: '来源待核实', stem: '公共题：$|-5|=$____。', options: [], answer: '5', analysis: '负数的绝对值是它的相反数。', source: '', createdAt: Date.now(), updatedAt: Date.now() } });
  step('seeded 我的题库 (5 questions, 2 categories) and 公共题库 (1 question)');

  // ---- 题库 regression: 新建试题 now comes from the shared component ----
  await page.goto(base + '/library?scope=mine');
  await page.locator('.user-chip').filter({ hasText: '本机管理员' }).waitFor();
  // One shared library: its default modules come first, so open the seeded module from the tree.
  await page.locator('.tree button.module-root').filter({ hasText: '初一数学' }).click();
  await page.locator('.question-card').first().waitFor();
  await page.getByRole('button', { name: /新建试题/ }).first().click();
  const modal = page.locator('.question-modal');
  await modal.locator('select').first().selectOption('解答题');
  const stemBox = modal.getByRole('textbox', { name: '题干', exact: true });
  await stemBox.fill('题库回归：解方程 $\\frac{x}{2}+1=3$。');
  await modal.getByLabel('答案', { exact: true }).fill('$x=4$');
  await modal.getByRole('textbox', { name: '解析', exact: true }).fill('两边减 1，再乘 2。');
  await modal.getByRole('button', { name: '确认并保存', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  const bankCard = page.locator('.question-card', { hasText: '题库回归' });
  await bankCard.waitFor();
  assert.ok(await bankCard.locator('.katex').count() > 0, 'formula renders as web math');
  // A new question starts from a screenshot; a typed-in one gets its figures while it is edited.
  // A card's 编辑 shows on hover, as it does for a teacher.
  await bankCard.hover();
  await bankCard.getByRole('button', { name: '编辑', exact: true }).click();
  assert.match(await stemBox.innerText(), /题库回归/);
  await stemBox.fill('题库回归（已编辑）：解方程 $\\frac{x}{2}+1=3$。');
  await modal.locator('input[type=file][multiple]').setInputFiles(join(out, 'diagram.png'));
  await modal.locator('.manual-image-grid img').waitFor();
  await modal.getByRole('button', { name: '确认并保存', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  const editedCard = page.locator('.question-card', { hasText: '题库回归（已编辑）' });
  await editedCard.waitFor();
  assert.equal(await editedCard.locator('img.question-diagram').count(), 1, 'a figure added while editing is kept');
  step('题库 新建试题: a typed question saved, then edited with a figure added');
  // AI 截图录入 reads a dropped screenshot through the shared screenshot path; recognition is stubbed.
  await page.route('**/api/recognize', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ result: {
    type: '解答题', difficulty: '中等', stem: '如图，在 $\\triangle ABC$ 中，$AB=AC$，求 $\\angle B$ 的度数。', options: [], answer: '', analysis: '', source: '', tags: ['等腰三角形'],
    suggested_category_id: null, diagram_bbox: { x: 40, y: 60, width: 900, height: 900 }, diagram_quality: null, confidence: 0.92, warnings: [] } }) }));
  await page.getByRole('button', { name: /新建试题/ }).first().click();
  await modal.getByRole('button', { name: /AI 截图录入/ }).click();
  await modal.locator('.smart-capture').evaluate(async (element, dataUrl) => {
    const file = new File([await (await fetch(dataUrl)).blob()], 'question.png', { type: 'image/png' });
    const transfer = new DataTransfer(); transfer.items.add(file);
    element.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, pngUrl);
  await stemBox.filter({ hasText: '如图' }).waitFor();
  await modal.locator('.diagram-review img').waitFor();
  assert.match(await modal.locator('.source-status b').innerText(), /识别可信度 92%/);
  await modal.getByRole('button', { name: '取消', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  await page.unroute('**/api/recognize');
  step('题库 AI 截图录入: a dropped screenshot goes through the shared path and its diagram is cropped');
  await page.getByRole('button', { name: /新建试题/ }).first().click();
  await modal.getByRole('button', { name: /文件批量录入/ }).click();
  await page.locator('.file-import-modal input[type=file]').setInputFiles(join(out, 'fixture.docx'));
  await page.locator('.file-draft').nth(1).waitFor();
  assert.equal(await page.locator('.file-draft').count(), 2);
  await page.screenshot({ path: join(out, 'bank-file-review.png'), fullPage: true });
  await page.getByRole('button', { name: '保存所选 2 道题', exact: true }).click();
  await page.locator('.file-import-modal').waitFor({ state: 'hidden' });
  const bankAfterImport = await api('/api/library?scope=mine');
  // One shared library: 5 seeded + the one seeded as public + the typed question + 2 imported.
  assert.equal(bankAfterImport.questions.length, 9);
  assert.ok(bankAfterImport.questions.some(q => q.stemDocxXml?.some(x => x.includes('<w:tbl'))), 'Word table structure kept');
  assert.ok(bankAfterImport.questions.some(q => q.type === '多选题' && q.answer === 'BD' && q.options.length === 4), 'prefixed choice question and complete answer saved');
  step('题库 文件批量录入: Word fixture split into 2 questions and saved with table structure');

  // ---- 讲义编撰：每个知识模块 = 知识点 → 例题 → 练习 → 变式 ----
  // 讲义编撰 and 知识图谱 are top-bar entries, not toolbox cards.
  await page.goto(base + '/tools');
  const nav = page.getByRole('navigation', { name: '题库入口' });
  await nav.getByRole('link', { name: '讲义编撰', exact: true }).waitFor();
  assert.deepEqual(await nav.locator('.nav-item').allInnerTexts(), ['题库', '组卷篮', '讲义编撰', '知识图谱', '学生档案', '工具箱']);
  const tools = await page.locator('.tool-card strong').allInnerTexts();
  assert.deepEqual(tools, ['文件转录', '快速排版', '智能组卷', 'AI 配置', '共享办公']);
  assert.ok(!tools.includes('讲义编撰') && !tools.includes('知识图谱'), 'top-bar entries are not toolbox cards');
  await page.locator('.topbar').screenshot({ path: join(out, 'site-header.png') });
  await nav.getByRole('link', { name: '讲义编撰', exact: true }).click();
  await page.waitForURL(/\/tools\/handouts/);
  assert.equal(await nav.locator('.nav-item.active').innerText(), '讲义编撰');
  // A 讲义 starts as a lesson in the course outline: 添加讲次, then 保存并编写讲义 opens the editor.
  await page.getByRole('button', { name: '＋ 添加讲次', exact: true }).first().click();
  const newLesson = page.getByRole('dialog', { name: '新建一讲' });
  await newLesson.getByLabel('本讲标题').fill('一元一次方程');
  await newLesson.getByRole('button', { name: '保存并编写讲义', exact: true }).click();
  await page.waitForURL(/\/tools\/handouts\?id=/);
  const handoutId = new URL(page.url()).searchParams.get('id');
  const saved = () => page.locator('.handout-save', { hasText: '已保存' }).waitFor();
  const modules = page.locator('.handout-module');
  const lane = (moduleIndex, band) => modules.nth(moduleIndex).locator(`.handout-lane.${band}`);
  const labels = locator => locator.locator('.handout-question .question-number').allInnerTexts();
  await modules.first().waitFor();
  assert.equal(await modules.count(), 1, 'a new 讲义 opens with one module');
  assert.deepEqual(await modules.first().locator('.handout-lane-head b').allInnerTexts(), ['知识点', '例题', '练习', '变式']);
  // The editor shows none of the guide lines printed in PDF and Word; each question lane counts in a badge, hollow at 0.
  assert.equal(await page.locator('.handout-lane-hint').count(), 0);
  assert.deepEqual(await modules.first().locator('.handout-lane-head .handout-count').evaluateAll(badges => badges.map(badge => [badge.textContent, badge.classList.contains('zero')])), [['0', true], ['0', true], ['0', true]]);
  await page.screenshot({ path: join(out, 'editor-new.png'), fullPage: true });
  assert.equal(await page.locator('.handout-title').inputValue(), '一元一次方程', 'the editor opens with the lesson title');
  await page.locator('.handout-title').fill('第3讲 一元一次方程');
  await page.locator('.handout-title').press('Tab');
  await saved();
  await page.getByLabel('模块一名称').fill('等式与方程');
  // 知识点 are written the way they read: no ##, ** or $ shows while editing.
  const note = page.getByRole('textbox', { name: '模块一知识点' });
  assert.equal(await note.getAttribute('contenteditable'), 'true');
  assert.equal(await modules.first().locator('.note-empty').getAttribute('data-placeholder'), '列出本模块要掌握的全部内容；可粘贴或拖入截图自动识别');
  await note.click();
  const tool = name => modules.first().getByRole('toolbar', { name: '知识点格式' }).getByRole('button', { name, exact: true });
  await tool('小标题').click();
  await page.keyboard.type('等式的性质');
  await page.keyboard.press('Enter');
  await page.keyboard.type('等式两边同乘 ');
  await tool('公式').click();
  const formula = page.getByRole('dialog', { name: '编辑公式' });
  await formula.getByRole('textbox').fill('\\frac{1}{2}');
  await formula.locator('.katex').waitFor();
  await formula.getByRole('button', { name: '确定', exact: true }).click();
  await page.keyboard.type('，结果仍相等。');
  await page.keyboard.press('Enter');
  await tool('加粗').click();
  await page.keyboard.type('解方程步骤');
  await tool('加粗').click();
  await page.keyboard.type('：去分母、去括号、移项、合并同类项、系数化为 1；**口诀**另记。');
  assert.doesNotMatch(await note.innerText(), /##|\*\*|\$/, 'no markup is ever shown');
  assert.equal(await note.locator('h4').innerText(), '等式的性质');
  assert.deepEqual(await note.locator('strong').allInnerTexts(), ['解方程步骤', '口诀']);
  assert.equal(await note.locator('.katex').count(), 1);
  await page.screenshot({ path: join(out, 'note-editing.png') });
  await tool('完成').click();
  await saved();
  assert.equal((await api(`/api/handouts/${handoutId}`)).handout.items.find(item => item.kind === 'section').note,
    '## 等式的性质\n等式两边同乘 $\\frac{1}{2}$，结果仍相等。\n**解方程步骤**：去分母、去括号、移项、合并同类项、系数化为 1；**口诀**另记。');
  await note.locator('.note-math').click();
  assert.equal(await formula.getByRole('textbox').inputValue(), '\\frac{1}{2}', 'a formula opens with its source');
  await formula.getByRole('textbox').fill('\\frac{1}{3}');
  await page.keyboard.press('Enter');
  // Inline fractions render in display style on the web (lib/math-render.ts), so the annotation carries \displaystyle.
  assert.match(await note.locator('annotation').textContent(), /\\frac\{1\}\{3\}$/);
  await page.keyboard.press('Meta+z');
  assert.equal(await formula.count(), 0);
  assert.match(await note.locator('annotation').textContent(), /\\frac\{1\}\{2\}$/, 'undo brings the formula back');
  await tool('完成').click();
  await page.getByRole('button', { name: '＋ 添加知识模块', exact: true }).click();
  await page.getByLabel('模块二名称').fill('列方程解应用题');
  await page.getByLabel('模块二名称').press('Tab');
  await saved();
  assert.match(await note.innerText(), /等式的性质/);
  step('讲义: new 讲义 shows one module with 知识点/例题/练习/变式 lanes; 知识点 written in place with 小标题/公式/加粗 and typed shorthand, saved as note markup; second module added');

  // Questions are picked in the left 题库选题 pane: a lane's 从题库选题 makes it the target, the pane's module
  // switcher chooses the module, and 加入例题/练习/变式 adds the selection.
  const picker = page.locator('.handout-bank');
  const pickerTarget = async () => `${(await picker.getByLabel('加入模块', { exact: true }).locator('option:checked').innerText()).split(' · ')[0]} · ${(await picker.getByLabel('题目用途', { exact: true }).locator('option:checked').innerText()).replace(/^作为/, '')}`;
  await lane(0, 'example').getByRole('button', { name: '从题库选题', exact: true }).click();
  assert.equal(await pickerTarget(), '模块一 · 例题');
  await choosePickerModule(picker, '初一数学');
  await picker.locator('.picker-item', { hasText: '2x+1=5' }).getByRole('button', { name: '＋ 选择' }).click();
  await picker.locator('.picker-item').filter({ hasText: '三角形 ABC' }).getByRole('button', { name: '＋ 选择' }).click();
  await page.screenshot({ path: join(out, 'picker-add.png') });
  await picker.getByRole('button', { name: '加入例题', exact: true }).click();
  await saved();
  assert.deepEqual(await labels(lane(0, 'example')), ['例1.', '例2.']);
  await lane(0, 'practice').getByRole('button', { name: '从题库选题', exact: true }).click();
  assert.equal(await pickerTarget(), '模块一 · 练习');
  await choosePickerModule(picker, '公共示例');
  await picker.locator('.picker-item', { hasText: '公共题' }).getByRole('button', { name: '＋ 选择' }).click();
  await picker.getByRole('button', { name: '加入练习', exact: true }).click();
  await saved();
  assert.deepEqual(await labels(lane(0, 'practice')), ['1.']);
  step('讲义 从题库选题 per lane: 2 例题 from one module, 1 练习 from another, numbered 例1 例2 / 1');

  await lane(1, 'example').getByRole('button', { name: '录入新题', exact: true }).click();
  await modal.waitFor();
  await modal.locator('select').first().selectOption('填空题');
  await stemBox.fill('讲义内录入：若 $x-7=2$，则 $x=$____。');
  await modal.getByLabel('答案', { exact: true }).fill('9');
  await modal.locator('label.field', { hasText: '知识点标签' }).locator('input').fill('列方程，等量关系');
  await modal.getByRole('button', { name: '确认并保存', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  await saved();
  assert.deepEqual(await labels(lane(1, 'example')), ['例3.'], '例题 number on across modules');
  assert.deepEqual(await lane(1, 'example').locator('.handout-points b').allInnerTexts(), ['列方程', '等量关系']);
  assert.ok((await api('/api/library')).questions.some(q => q.stem.startsWith('讲义内录入')), 'a question entered in the 讲义 is stored in the library');
  await lane(1, 'variant').getByRole('button', { name: '录入新题', exact: true }).click();
  await modal.getByRole('button', { name: /文件批量录入/ }).click();
  await page.locator('.file-import-modal input[type=file]').setInputFiles(join(out, 'fixture.docx'));
  await page.locator('.file-draft').nth(1).waitFor();
  await page.getByRole('button', { name: '保存所选 2 道题', exact: true }).click();
  await page.locator('.file-import-modal').waitFor({ state: 'hidden' });
  await saved();
  assert.deepEqual(await labels(lane(1, 'variant')), ['变式1.', '变式2.']);
  step('讲义 录入新题 per lane: manual entry with 知识点 lands in 模块二 例题 as 例3 with 考点 chips; Word fixture fills 变式1 变式2');

  const triangle = lane(0, 'example').locator('.handout-question').nth(1);
  assert.match(await triangle.innerText(), /周长为 24/);
  await triangle.getByRole('button', { name: '替换', exact: true }).click();
  assert.equal(await picker.locator('.picker-replacing strong').innerText(), '替换 例2 · 选一道题替换');
  await choosePickerModule(picker, '初一数学');
  await page.screenshot({ path: join(out, 'picker-replace.png') });
  await picker.locator('.picker-item', { hasText: '3(x-1)' }).getByRole('button', { name: '换成这道', exact: true }).click();
  await saved();
  assert.match(await lane(0, 'example').locator('.handout-question').nth(1).innerText(), /3\s*\(\s*x/);
  assert.deepEqual(await labels(lane(0, 'example')), ['例1.', '例2.'], 'the replacement keeps its lane and number');
  step('讲义 替换: 例2 swapped in place from the left pane and stays 例2');

  const first = lane(0, 'example').locator('.handout-question').first();
  await first.getByRole('button', { name: '题目更多操作', exact: true }).click();
  assert.deepEqual(await first.locator('.more-panel button').allInnerTexts(), ['改为练习', '改为变式', '编辑原题']);
  assert.equal(await first.getByRole('button', { name: '例1 移出讲义', exact: true }).count(), 1, '移出讲义 is its own red button');
  await first.getByRole('button', { name: '改为练习', exact: true }).click();
  await saved();
  assert.deepEqual(await labels(lane(0, 'example')), ['例1.']);
  assert.deepEqual(await labels(lane(0, 'practice')), ['1.', '2.'], 'a question changing band joins the end of that lane');
  assert.deepEqual(await labels(lane(1, 'example')), ['例2.'], 'later 例题 renumber');
  const practiceText = async () => (await lane(0, 'practice').locator('.handout-question').allInnerTexts()).map((text) => text.replace(/\s+/g, ''));
  const before = await practiceText();
  await lane(0, 'practice').getByRole('button', { name: '拖动练习 1调整顺序', exact: true }).press('ArrowUp');
  assert.deepEqual(await practiceText(), before, 'a lane edge cannot move further');
  await lane(0, 'practice').getByRole('button', { name: '拖动练习 2调整顺序', exact: true }).press('ArrowUp');
  await saved();
  assert.match(await lane(0, 'practice').locator('.handout-question').first().innerText(), /2x\s*\+\s*1\s*=\s*5|2\s*x\s*\+/);
  step('讲义 更多 → 改为练习 moves 例1 to the end of 练习; ↑ on the handle reorders inside the lane only');

  // Drag by the six-dot handle: onto 例1's top half lands before it in 例题, then back to the top of 练习.
  const grip = (band, name) => lane(0, band).getByRole('button', { name: `拖动${name}调整顺序`, exact: true });
  await lane(0, 'example').locator('.handout-question').first().hover();
  await grip('practice', '练习 1').dragTo(lane(0, 'example').locator('.handout-question').first(), { targetPosition: { x: 200, y: 5 } });
  await saved();
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('handout-drag')), false, 'a mouse drag leaves no focus ring on the handle');
  assert.deepEqual(await labels(lane(0, 'example')), ['例1.', '例2.'], 'a dragged question takes the band it lands in');
  assert.match(await lane(0, 'example').locator('.handout-question').first().innerText(), /2x\s*\+\s*1\s*=\s*5|2\s*x\s*\+/);
  assert.deepEqual(await labels(lane(1, 'example')), ['例3.']);
  await grip('example', '例1').dragTo(lane(0, 'practice').locator('.handout-question').first(), { targetPosition: { x: 200, y: 5 } });
  await saved();
  assert.deepEqual(await labels(lane(0, 'practice')), ['1.', '2.']);
  assert.match(await lane(0, 'practice').locator('.handout-question').first().innerText(), /2x\s*\+\s*1\s*=\s*5|2\s*x\s*\+/);
  await page.reload();
  await page.locator('.handout-question').first().waitFor();
  await page.waitForFunction(() => !document.body.innerText.includes('正在读取题目'));
  assert.match(await lane(0, 'practice').locator('.handout-question').first().innerText(), /2x\s*\+\s*1\s*=\s*5|2\s*x\s*\+/, 'drag order persists');
  const offsets = await page.locator('.handout-question').evaluateAll(cards => cards.map(card => {
    const middle = element => { const box = element.getBoundingClientRect(); return box.top + box.height / 2; };
    return Math.abs(middle(card.querySelector('.handout-drag')) - middle(card.querySelector('.question-number')));
  }));
  assert.ok(offsets.length && offsets.every(offset => offset <= 1), `every handle sits on its question number's line: ${offsets}`);
  await lane(0, 'practice').locator('.handout-question').first().hover();
  await lane(0, 'practice').screenshot({ path: join(out, 'drag-handle.png') });
  step('讲义 drag handle moves a question across lanes and back; order persists across reload; the handle sits on the number line');

  const untagged = lane(0, 'practice').locator('.handout-question').first();
  await untagged.getByRole('button', { name: '未标知识点 · 补充', exact: true }).click();
  await modal.waitFor();
  await modal.locator('label.field', { hasText: '知识点标签' }).locator('input').fill('一元一次方程，移项');
  await modal.getByRole('button', { name: '确认并保存', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  await lane(0, 'practice').locator('.handout-question').first().locator('.handout-points b', { hasText: '一元一次方程' }).waitFor();
  assert.ok((await api('/api/library')).questions.find(q => q.id === 'seed-1').tags.includes('移项'), 'tags are saved on the library question');
  step('讲义 考点: an untagged question opens the shared editor from 「未标知识点 · 补充」; its tags become 考点 chips');

  // A module moves from its title row's 更多 menu.
  await modules.nth(1).getByRole('button', { name: '模块更多操作', exact: true }).click();
  await modules.nth(1).locator('.more-panel').getByRole('button', { name: '上移', exact: true }).click();
  await saved();
  assert.equal(await page.getByLabel('模块一名称').inputValue(), '列方程解应用题');
  const snapshot = () => modules.evaluateAll(nodes => nodes.map(node => [
    node.querySelector('.handout-module-head input').value,
    ...[...node.querySelectorAll('.handout-lane:not(.knowledge)')].map(laneNode => `${laneNode.querySelector('.handout-lane-head b').textContent}: ${[...laneNode.querySelectorAll('.handout-question')].map(card => `${card.querySelector('.question-number')?.textContent ?? ''}${(card.querySelector('.stem-body')?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 24)}`).join(' | ')}`),
  ]));
  const orderBefore = await snapshot();
  await page.reload();
  await page.locator('.handout-question').first().waitFor();
  await page.waitForFunction(() => !document.body.innerText.includes('正在读取题目'));
  assert.deepEqual(await snapshot(), orderBefore);
  assert.match(orderBefore[0][1], /^例题: 例1\.讲义内录入/);
  assert.match(orderBefore[1][1], /^例题: 例2\./);
  const stored = (await api(`/api/handouts/${handoutId}`)).handout;
  assert.equal(stored.items.filter(item => item.kind === 'question').length, 6);
  assert.deepEqual(stored.items.filter(item => item.kind === 'section').map(item => item.title), ['列方程解应用题', '等式与方程']);
  assert.deepEqual(stored.items.filter(item => item.kind === 'question').map(item => item.band), ['example', 'variant', 'variant', 'example', 'practice', 'practice']);
  step('讲义 模块上移: modules swap with their lanes; numbering follows; everything persists across reload');
  await page.screenshot({ path: join(out, 'editor-desktop.png'), fullPage: true });

  const legacy = (await api('/api/handouts', { handout: { title: '旧讲义', items: [
    { id: 'old-q1', kind: 'question', scope: 'mine', questionId: 'seed-4' },
    { id: 'old-s1', kind: 'section', title: '旧分节', note: '' },
    { id: 'old-q2', kind: 'question', scope: 'mine', questionId: 'seed-2' },
  ] } })).handout;
  await page.goto(`${base}/tools/handouts?id=${legacy.id}`);
  await page.locator('.handout-question').nth(1).waitFor();
  assert.equal(await modules.count(), 2);
  assert.deepEqual([await labels(lane(0, 'example')), await labels(lane(1, 'example'))], [['例1.'], ['例2.']], 'questions saved before bands open as 例题; loose ones get a first module');
  assert.equal(await page.getByLabel('模块二名称').inputValue(), '旧分节');
  await api(`/api/handouts/${legacy.id}`, {}, 'DELETE');
  step('讲义 legacy: a 讲义 saved before modules opens with every question under 例题');

  // A row of figures, as screenshot recognition writes it: captions are typed in place, Enter leaves the row,
  // a figure can be deleted, and dark pages show the figures on white cards with nothing stray around captions.
  const [leftFigure, rightFigure] = [(await api('/api/handout-images', { image: pngUrl })).url, (await api('/api/handout-images', { image: pngUrl })).url];
  const rowNote = `## 拉窗帘\n![$O$ 可在 $y$ 轴上移动](${leftFigure}) ![$S_①=S_②$](${rightFigure}) $$S_{\\triangle ABO}=S_{\\triangle ABD}$$$$=\\frac{1}{2}|k|$$ 同底等高`;
  const rows = (await api('/api/handouts', { handout: { title: '配图排', items: [{ id: 'row-s', kind: 'section', title: '反比例函数', note: rowNote }] } })).handout;
  await page.goto(`${base}/tools/handouts?id=${rows.id}`);
  const rowEditor = page.getByRole('textbox', { name: '模块一知识点' });
  await rowEditor.locator('.note-figure-row').waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.note-figure-frame > img')].every(img => img.complete && img.naturalWidth > 0));
  assert.equal(await rowEditor.locator('.note-figure').count(), 2);
  assert.match(await rowEditor.locator('.note-figure-side').innerText(), /同底等高/);
  assert.doesNotMatch(await rowEditor.innerText(), /!\[|\$|##/, 'the row shows no markup');
  const firstCaption = rowEditor.locator('figcaption').first();
  const captionBox = await firstCaption.boundingBox();
  await page.mouse.click(captionBox.x + captionBox.width - 2, captionBox.y + captionBox.height / 2);
  await page.keyboard.press('Meta+ArrowRight');
  await page.waitForFunction(() => { const node = getSelection().anchorNode; return (node?.nodeType === 1 ? node : node?.parentElement)?.closest('figcaption'); });
  await page.waitForTimeout(80);
  await page.keyboard.type('（补）');
  await page.keyboard.press('Enter');
  await page.keyboard.type('排后的一行');
  // The caption starts with a formula, and a click on a formula edits it: reach the start from the caption's end.
  const captionStart = await firstCaption.boundingBox();
  await page.mouse.click(captionStart.x + captionStart.width - 2, captionStart.y + captionStart.height / 2);
  await page.keyboard.press('Meta+ArrowLeft');
  // Keys are pressed only after the editor has taken in the caret move, as with a person typing.
  await page.waitForFunction(() => { const node = getSelection().anchorNode; return (node?.nodeType === 1 ? node : node?.parentElement)?.closest('figcaption'); });
  await page.waitForTimeout(80);
  await page.keyboard.press('Backspace');
  await rowEditor.locator('.note-figure-frame > img').nth(1).click();
  await rowEditor.locator('.note-figure.selected').getByRole('button', { name: '删除图片' }).click();
  await page.getByRole('button', { name: '完成', exact: true }).click();
  await saved();
  const rowStored = (await api(`/api/handouts/${rows.id}`)).handout.items[0].note.split('\n');
  assert.equal(rowStored[0], '## 拉窗帘');
  assert.match(rowStored[1], /^!\[\$O\$ 可在 \$y\$ 轴上移动（补）\]\(\/api\/assets\/[0-9a-f-]{36}\)$/, 'caption typed, second figure deleted');
  assert.equal(rowStored[2], '> $$S_{\\triangle ABO}=S_{\\triangle ABD}$$$$=\\frac{1}{2}|k|$$ 同底等高', 'the note beside the row is kept, one line per step');
  assert.equal(rowStored[3], '排后的一行', 'Enter in a caption starts a new line after the row');
  assert.equal(rowStored.length, 4);
  await page.screenshot({ path: join(out, 'figure-row.png'), fullPage: true });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.dataset.style = 'tech'; });
  const strays = await page.evaluate(() => [...document.querySelectorAll('.note-editor img')].filter(img => !img.closest('.note-figure-frame') && img.getBoundingClientRect().width > 2).length);
  assert.equal(strays, 0, 'no caret helper shows up as a stray mark');
  assert.equal(await rowEditor.locator('.note-figure-frame > img').evaluate(img => getComputedStyle(img).backgroundColor), 'rgb(255, 255, 255)', 'figures sit on a white card on dark pages');
  await page.screenshot({ path: join(out, 'figure-row-dark.png'), fullPage: true });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; document.documentElement.dataset.style = 'classic'; });
  await api(`/api/handouts/${rows.id}`, {}, 'DELETE');
  step('讲义 配图排: captions typed in place, Enter leaves the row, Backspace never merges captions, a figure deleted; dark pages show clean white cards');

  await page.goto(`${base}/tools/handouts?id=${handoutId}`);
  await page.locator('.handout-question').first().waitFor();
  await page.waitForFunction(() => !document.body.innerText.includes('正在读取题目'));
  const order = (text, markers, label) => markers.reduce((from, marker) => {
    const index = text.indexOf(marker, from);
    assert.ok(index >= 0, `${label}: missing ${marker} after position ${from}`);
    return index + marker.length;
  }, 0);
  for (const [label, key] of [['学生版', 'none'], ['附答案', 'end'], ['教师版', 'each']]) {
    await page.getByRole('button', { name: '快速排版', exact: true }).click();
    const exportModal = page.locator('.handout-typeset');
    await exportModal.locator('.typeset-note').filter({ hasText: 'PDF 需要在运行 MathPilot 的这台电脑上生成' }).waitFor();
    // The compiled Worker has no local typesetter, exactly like the deployed site.
    assert.equal(await exportModal.getByRole('button', { name: '下载 PDF', exact: true }).isDisabled(), true, 'without a local typesetter PDF stays disabled and Word remains available');
    assert.match(await exportModal.innerText(), /PDF 需要在运行 MathPilot 的这台电脑上生成/);
    await exportModal.locator('label', { hasText: label }).click();
    if (key === 'none') assert.match(await exportModal.innerText(), /例题留课堂笔记区/);
    if (key === 'each') await page.screenshot({ path: join(out, 'export-dialog.png') });
    const download = page.waitForEvent('download', { timeout: 60000 });
    await exportModal.getByRole('button', { name: '其他格式', exact: true }).click();
    await exportModal.getByRole('button', { name: '导出 Word', exact: true }).click();
    const file = join(out, `handout-${key}.docx`);
    await (await download).saveAs(file);
    await exportModal.getByRole('button', { name: '← 讲义编辑', exact: true }).click();
    await exportModal.waitFor({ state: 'hidden' });
    const docx = await inspectDocx(file);
    assert.ok(docx.songti && docx.timesNewRoman, `${key}: Songti SC / Times New Roman fonts`);
    // Simple expressions (x−7=2, |−5|) print as text the way 菁优网 does; structured ones stay native Word math:
    // 1/2 in the 知识点 and the Word fixture's x/2 and √4.
    assert.ok(docx.formulas >= 3, `${key}: native Word formulas`);
    assert.ok(docx.tables >= 2, `${key}: option table and imported Word table`);
    assert.ok(docx.images >= 1, `${key}: figure image`);
    order(docx.text, ['第3讲 一元一次方程', '模块一　列方程解应用题', '例题　跟着老师，看知识点怎么用', '例1．讲义内录入', '考点：列方程、等量关系',
      '变式　换个情境，抓住本质', '变式1．', '变式2．根据下表', '模块二　等式与方程', '知识点　本模块要掌握的内容', '等式的性质', '等式两边同乘', '解方程步骤', '例2．',
      '练习　自己动手，检验掌握', '1．方程', '考点：一元一次方程、移项', '2．公共题'], key);
    if (key === 'none') assert.ok(!docx.text.includes('答案：') && (docx.text.match(/课堂笔记/g) ?? []).length === 2, `${key}: 课堂笔记 under both 例题, no answers`);
    if (key === 'end') order(docx.text, ['2．公共题', '参考答案与试题解析', '例题解析', '例1．答案：9', '例2．答案：', '练习答案', '1．答案：B', '2．答案：5', '变式答案', '变式1．答案：', '变式2．答案：'], key);
    if (key === 'each') {
      assert.ok(!docx.text.includes('参考答案与试题解析') && !docx.text.includes('课堂笔记'), `${key}: no key page, no note areas`);
      order(docx.text, ['例1．讲义内录入', '答案：9', '变式1．'], key);
    }
    result.exports[key] = { formulas: docx.formulas, tables: docx.tables, images: docx.images };
  }
  step('讲义 导出 Word: 不附 / 文末 / 每题后 follow 模块 → 知识点 → 例题 → 练习 → 变式 with 例1/1/变式1, 考点, 课堂笔记 and a grouped key');

  // The shelf lists each 讲义 as a lesson row; copying and deleting sit in that row's 更多 menu.
  const shelfEntry = title => page.locator('.handout-entry').filter({ has: page.locator('strong', { hasText: new RegExp(`^${title}$`) }) });
  await page.goto(base + '/tools/handouts');
  await shelfEntry('第3讲 一元一次方程').waitFor();
  await page.getByRole('button', { name: '第3讲 一元一次方程 更多操作', exact: true }).click();
  await page.getByRole('button', { name: '复制一份', exact: true }).click();
  await page.waitForURL(url => url.searchParams.get('id') && url.searchParams.get('id') !== handoutId);
  assert.equal(await page.locator('.handout-title').inputValue(), '第3讲 一元一次方程（副本）');
  await page.locator('.handout-question').first().waitFor();
  assert.equal(await page.locator('.handout-question').count(), 6);
  assert.deepEqual(await labels(lane(1, 'practice')), ['1.', '2.'], 'the copy keeps every band');
  await page.goto(base + '/tools/handouts');
  await shelfEntry('第3讲 一元一次方程（副本）').waitFor();
  await page.screenshot({ path: join(out, 'list-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: '第3讲 一元一次方程（副本） 更多操作', exact: true }).click();
  await page.getByRole('button', { name: '删除…', exact: true }).click();
  await page.getByRole('dialog', { name: '删除讲义「第3讲 一元一次方程（副本）」' }).getByRole('button', { name: '删除讲义', exact: true }).click();
  await shelfEntry('第3讲 一元一次方程（副本）').waitFor({ state: 'detached' });
  assert.equal((await api('/api/handouts')).handouts.length, 1);
  step('讲义列表: 复制一份 keeps all 6 questions and their bands; 删除 removes it');

  }
  assert.deepEqual(result.pageErrors, []);
  result.ok = true;
  await writeFile(join(out, 'results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  result.failure = String(error?.stack || error);
  if (page) await page.screenshot({ path: join(out, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(join(out, 'results.json'), JSON.stringify(result, null, 2));
  throw error;
} finally {
  if (browser) await browser.close();
  worker.kill('SIGINT');
  await Promise.race([new Promise(r => worker.once('exit', r)), delay(3000)]);
  if (worker.exitCode === null) worker.kill('SIGKILL');
  await writeFile(join(out, 'worker.log'), workerLog);
  await rm(state, { recursive: true, force: true });
}
