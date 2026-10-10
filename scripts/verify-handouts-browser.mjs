import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { AlignmentType, Document, ImageRun, Math as WordMath, MathFraction, MathRun, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import { loopbackFetch as fetch } from '../tests/helpers/loopback-fetch.mjs';
// Run after npm run build. The compiled app, D1 and the browser are real; no AI
// service is configured, so only the manual and Word-structure entry paths run.
// Usage: PLAYWRIGHT_PACKAGE=<package.json beside playwright> CHROMIUM_PATH=<chrome> node scripts/verify-handouts-browser.mjs
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
    p(t('1．方程 '), new WordMath({ children: [new MathFraction({ numerator: [new MathRun('x')], denominator: [new MathRun('2')] }), new MathRun('=3')] }), t(' 的解是（　　）')),
    p(t('A．x=3　　B．x=6　　C．x=5　　D．x=1')),
    p(t('二、解答题')),
    p(t('2．根据下表和图形，列方程求 a 的值。')),
    new Table({ width: { size: 4000, type: WidthType.DXA }, rows: [
      new TableRow({ children: [new TableCell({ children: [p(t('月份'))] }), new TableCell({ children: [p(t('销量'))] })] }),
      new TableRow({ children: [new TableCell({ children: [p(t('一月'))] }), new TableCell({ children: [p(t('a+12'))] })] }),
    ] }),
    new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ type: 'png', data: png, transformation: { width: 160, height: 100 } })] }),
    p(t('参考答案与试题解析')),
    p(t('1．')), p(t('【分析】去分母。')), p(t('【解答】解：x=6，故选：B．')), p(t('【点评】本题考查一元一次方程。')),
    p(t('2．')), p(t('【分析】由表格列方程。')), p(t('【解答】解：a+12=20，a=8．')), p(t('【点评】本题考查列方程。')),
  ] }] });
  return Buffer.from(await Packer.toBuffer(doc));
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
  await page.goto(base + '/?scope=mine');
  await page.locator('.user-chip').filter({ hasText: '本地' }).waitFor();
  await page.locator('.question-card').first().waitFor();
  await page.getByRole('button', { name: /新建试题/ }).first().click();
  const modal = page.locator('.question-modal');
  await modal.locator('select').first().selectOption('解答题');
  await modal.locator('label.field', { hasText: '题干' }).locator('textarea').fill('题库回归：解方程 $\\frac{x}{2}+1=3$。');
  await modal.locator('input[type=file][multiple]').setInputFiles(join(out, 'diagram.png'));
  await modal.locator('.manual-image-grid img').waitFor();
  await modal.getByLabel('答案', { exact: true }).fill('$x=4$');
  await modal.locator('label.field', { hasText: '解析' }).locator('textarea').fill('两边减 1，再乘 2。');
  await modal.getByRole('button', { name: '确认并保存', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  const bankCard = page.locator('.question-card', { hasText: '题库回归' });
  await bankCard.waitFor();
  assert.equal(await bankCard.locator('img.question-diagram').count(), 1, 'manual entry keeps its figure');
  assert.ok(await bankCard.locator('.katex').count() > 0, 'formula renders as web math');
  await bankCard.getByRole('button', { name: '编辑', exact: true }).click();
  assert.match(await modal.locator('label.field', { hasText: '题干' }).locator('textarea').inputValue(), /题库回归/);
  await modal.locator('label.field', { hasText: '题干' }).locator('textarea').fill('题库回归（已编辑）：解方程 $\\frac{x}{2}+1=3$。');
  await modal.getByRole('button', { name: '确认并保存', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  await page.locator('.question-card', { hasText: '题库回归（已编辑）' }).waitFor();
  step('题库 新建试题: manual entry with pasted figure saved, then edited');
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
  await page.waitForFunction(() => (document.querySelector('.question-modal label.field textarea')?.value ?? '').includes('如图'));
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
  assert.equal(bankAfterImport.questions.length, 8);
  assert.ok(bankAfterImport.questions.some(q => q.stemDocxXml?.some(x => x.includes('<w:tbl'))), 'Word table structure kept');
  step('题库 文件批量录入: Word fixture split into 2 questions and saved with table structure');

  // ---- 讲义编撰：每个知识模块 = 知识点 → 例题 → 练习 → 变式 ----
  // 讲义编撰 and 知识图谱 are top-bar entries, not toolbox cards.
  await page.goto(base + '/tools');
  const nav = page.getByRole('navigation', { name: '题库入口' });
  await nav.getByRole('link', { name: '讲义编撰', exact: true }).waitFor();
  assert.deepEqual(await nav.locator('.nav-item').allInnerTexts(), ['题库', '组卷篮', '讲义编撰', '知识图谱', '学生档案', '工具箱']);
  assert.deepEqual(await page.locator('.tool-card strong').allInnerTexts(), ['作业批改', '手写转录', '共享办公']);
  await page.locator('.topbar').screenshot({ path: join(out, 'site-header.png') });
  await nav.getByRole('link', { name: '讲义编撰', exact: true }).click();
  await page.waitForURL('**/tools/handouts');
  assert.equal(await nav.locator('.nav-item.active').innerText(), '讲义编撰');
  await page.getByText('还没有讲义').waitFor();
  await page.getByRole('button', { name: '新建讲义', exact: true }).click();
  await page.waitForURL(/\/tools\/handouts\?id=/);
  const handoutId = new URL(page.url()).searchParams.get('id');
  const saved = () => page.locator('.handout-save', { hasText: '已保存' }).waitFor();
  const modules = page.locator('.handout-module');
  const lane = (moduleIndex, band) => modules.nth(moduleIndex).locator(`.handout-lane.${band}`);
  const labels = locator => locator.locator('.handout-question .question-number').allInnerTexts();
  await modules.first().waitFor();
  assert.equal(await modules.count(), 1, 'a new 讲义 opens with one module');
  assert.deepEqual(await modules.first().locator('.handout-lane-head b').allInnerTexts(), ['知识点', '例题', '练习', '变式']);
  assert.deepEqual(await modules.first().locator('.handout-lane-hint').allInnerTexts(), ['选和上面知识点直接对应的典型题，带学生一起做', '和例题同类的题，学生独立完成', '换情境、换题型，考查同一个思维模型']);
  assert.match(await modules.first().locator('.handout-module-status').innerText(), /知识点 待补\s*例题 0\s*练习 0\s*变式 0/);
  await page.screenshot({ path: join(out, 'editor-new.png'), fullPage: true });
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
  assert.equal(await note.locator('annotation').textContent(), '\\frac{1}{3}');
  await page.keyboard.press('Meta+z');
  assert.equal(await formula.count(), 0);
  assert.equal(await note.locator('annotation').textContent(), '\\frac{1}{2}', 'undo brings the formula back');
  await tool('完成').click();
  await page.getByRole('button', { name: '＋ 添加知识模块', exact: true }).click();
  await page.getByLabel('模块二名称').fill('列方程解应用题');
  await page.getByLabel('模块二名称').press('Tab');
  await saved();
  assert.match(await modules.first().locator('.handout-module-status').innerText(), /知识点 ✓/);
  step('讲义: new 讲义 shows one module with 知识点/例题/练习/变式 lanes; 知识点 written in place with 小标题/公式/加粗 and typed shorthand, saved as note markup; second module added');

  const picker = page.locator('.picker-modal');
  await lane(0, 'example').getByRole('button', { name: '＋ 从题库选题', exact: true }).click();
  await picker.locator('.picker-item').first().waitFor();
  assert.equal(await picker.locator('.eyebrow').innerText(), '加入例题 · 模块一');
  await picker.locator('.picker-item', { hasText: '2x+1=5' }).getByRole('button', { name: '＋ 选择' }).click();
  await picker.locator('.picker-item').filter({ hasText: '三角形 ABC' }).getByRole('button', { name: '＋ 选择' }).click();
  await page.screenshot({ path: join(out, 'picker-add.png') });
  await picker.getByRole('button', { name: '加入讲义', exact: true }).click();
  await picker.waitFor({ state: 'hidden' });
  await saved();
  assert.deepEqual(await labels(lane(0, 'example')), ['例1.', '例2.']);
  await lane(0, 'practice').getByRole('button', { name: '＋ 从题库选题', exact: true }).click();
  assert.equal(await picker.locator('.eyebrow').innerText(), '加入练习 · 模块一');
  await picker.getByRole('tab', { name: '公共题库' }).click();
  await picker.locator('select').first().selectOption({ label: '公共示例' });
  await picker.locator('.picker-item', { hasText: '公共题' }).getByRole('button', { name: '＋ 选择' }).click();
  await picker.getByRole('button', { name: '加入讲义', exact: true }).click();
  await saved();
  assert.deepEqual(await labels(lane(0, 'practice')), ['1.']);
  step('讲义 从题库选题 per lane: 2 例题 from 我的题库, 1 练习 from 公共题库, numbered 例1 例2 / 1');

  await lane(1, 'example').getByRole('button', { name: '＋ 录入新题', exact: true }).click();
  await modal.waitFor();
  assert.equal(await modal.locator('select').nth(3).inputValue(), mine.id, 'entry defaults to the module root of 我的题库');
  await modal.locator('select').first().selectOption('填空题');
  await modal.locator('label.field', { hasText: '题干' }).locator('textarea').fill('讲义内录入：若 $x-7=2$，则 $x=$____。');
  await modal.getByLabel('答案', { exact: true }).fill('9');
  await modal.locator('label.field', { hasText: '知识点标签' }).locator('input').fill('列方程，等量关系');
  await modal.getByRole('button', { name: '确认并保存', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  await saved();
  assert.deepEqual(await labels(lane(1, 'example')), ['例3.'], '例题 number on across modules');
  assert.deepEqual(await lane(1, 'example').locator('.handout-points b').allInnerTexts(), ['列方程', '等量关系']);
  assert.ok((await api('/api/library?scope=mine')).questions.some(q => q.stem.startsWith('讲义内录入')), 'a question entered in the 讲义 is stored in 我的题库');
  await lane(1, 'variant').getByRole('button', { name: '＋ 录入新题', exact: true }).click();
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
  await picker.locator('.picker-item').first().waitFor();
  assert.equal(await picker.locator('.eyebrow').innerText(), '替换 例2');
  assert.equal(await picker.locator('select').nth(1).inputValue(), 'cat-eq', 'replace opens on the replaced question category');
  await page.screenshot({ path: join(out, 'picker-replace.png') });
  await picker.locator('.picker-item', { hasText: '3(x-1)' }).getByRole('button', { name: '换成这道', exact: true }).click();
  await picker.waitFor({ state: 'hidden' });
  await saved();
  assert.match(await lane(0, 'example').locator('.handout-question').nth(1).innerText(), /3\s*\(\s*x/);
  assert.deepEqual(await labels(lane(0, 'example')), ['例1.', '例2.'], 'the replacement keeps its lane and number');
  step('讲义 替换: 例2 swapped in place from the same category and stays 例2');

  const first = lane(0, 'example').locator('.handout-question').first();
  await first.getByRole('button', { name: '更多' }).click();
  assert.deepEqual(await first.locator('.more-panel button').allInnerTexts(), ['改为练习', '改为变式', '编辑原题', '移出讲义']);
  await first.getByRole('button', { name: '改为练习', exact: true }).click();
  await saved();
  assert.deepEqual(await labels(lane(0, 'example')), ['例1.']);
  assert.deepEqual(await labels(lane(0, 'practice')), ['1.', '2.'], 'a question changing band joins the end of that lane');
  assert.deepEqual(await labels(lane(1, 'example')), ['例2.'], 'later 例题 renumber');
  assert.equal(await lane(0, 'practice').getByRole('button', { name: '练习 1 上移' }).isDisabled(), true, 'a lane edge cannot move further');
  await lane(0, 'practice').getByRole('button', { name: '练习 2 上移' }).click();
  await saved();
  assert.match(await lane(0, 'practice').locator('.handout-question').first().innerText(), /2x\s*\+\s*1\s*=\s*5|2\s*x\s*\+/);
  step('讲义 更多 → 改为练习 moves 例1 to the end of 练习; ↑ reorders inside the lane only');

  const untagged = lane(0, 'practice').locator('.handout-question').first();
  await untagged.getByRole('button', { name: '未标知识点 · 补充', exact: true }).click();
  await modal.waitFor();
  await modal.locator('label.field', { hasText: '知识点标签' }).locator('input').fill('一元一次方程，移项');
  await modal.getByRole('button', { name: '确认并保存', exact: true }).click();
  await modal.waitFor({ state: 'hidden' });
  await lane(0, 'practice').locator('.handout-question').first().locator('.handout-points b', { hasText: '一元一次方程' }).waitFor();
  assert.ok((await api('/api/library?scope=mine')).questions.find(q => q.id === 'seed-1').tags.includes('移项'), 'tags are saved on the library question');
  step('讲义 考点: an untagged question opens the shared editor from 「未标知识点 · 补充」; its tags become 考点 chips');

  await page.getByRole('button', { name: '模块二上移' }).click();
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
  const captionStart = await firstCaption.boundingBox();
  await page.mouse.click(captionStart.x + 2, captionStart.y + captionStart.height / 2);
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
  for (const [label, key] of [['不附', 'none'], ['文末', 'end'], ['每题后', 'each']]) {
    await page.getByRole('button', { name: '导出', exact: true }).click();
    const exportModal = page.locator('.export-modal');
    await page.locator('.export-modal .primary-button:not(:disabled)').waitFor();
    // The compiled Worker has no local typesetter, exactly like the deployed site.
    assert.equal(await exportModal.getByRole('button', { name: '生成 PDF', exact: true }).count(), 0, 'without a typesetter the main action is Word');
    assert.match(await exportModal.innerText(), /精排 PDF 需要在本机用「启动知题」运行时生成/);
    await exportModal.locator('label', { hasText: label }).click();
    if (key === 'none') assert.match(await exportModal.innerText(), /例题留课堂笔记区/);
    if (key === 'each') await page.screenshot({ path: join(out, 'export-dialog.png') });
    const download = page.waitForEvent('download', { timeout: 60000 });
    await exportModal.getByRole('button', { name: '生成 Word', exact: true }).click();
    const file = join(out, `handout-${key}.docx`);
    await (await download).saveAs(file);
    await exportModal.waitFor({ state: 'hidden' });
    const docx = await inspectDocx(file);
    assert.ok(docx.songti && docx.timesNewRoman, `${key}: Songti SC / Times New Roman fonts`);
    assert.ok(docx.formulas >= 5, `${key}: native Word formulas`);
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

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.locator('.handout-question').first().waitFor();
  await page.waitForFunction(() => !document.body.innerText.includes('正在读取题目'));
  await page.getByRole('textbox', { name: '模块二知识点' }).locator('p').first().click();
  await page.getByRole('toolbar', { name: '知识点格式' }).waitFor();
  await page.waitForTimeout(300);
  const mobile = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    wrapped: [...document.querySelectorAll('main button')].filter(b => b.offsetParent && (b.scrollWidth > b.clientWidth + 1 || getComputedStyle(b).whiteSpace !== 'nowrap')).map(b => b.innerText),
    small: [...document.querySelectorAll('.handout-actions>button,.handout-actions .more-toggle,.handout-add button,.handout-topbar .primary-button,.handout-lane-head .text-button,.handout-points .text-button,.handout-add-section,.note-toolbar button')].filter(b => b.offsetParent && b.getBoundingClientRect().height < 40).map(b => b.innerText),
  }));
  assert.equal(mobile.overflow, 0, 'no horizontal scroll on phones');
  assert.deepEqual(mobile.wrapped, [], 'button text stays on one line');
  assert.deepEqual(mobile.small, [], 'touch targets stay at least 40px high');
  await page.screenshot({ path: join(out, 'editor-mobile.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '＋ 从题库选题' }).first().click();
  await page.locator('.picker-item').first().waitFor();
  await page.screenshot({ path: join(out, 'picker-mobile.png') });
  await page.locator('.picker-modal .close').click();
  step('讲义 mobile 390px: no overflow, buttons on one line, touch targets ≥ 40px, including the 知识点 toolbar');

  await page.goto(base + '/tools/handouts');
  await page.locator('.handout-list li').first().waitFor();
  await page.screenshot({ path: join(out, 'list-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('.handout-list li').first().getByRole('button', { name: '更多' }).click();
  await page.getByRole('button', { name: '复制一份' }).click();
  await page.waitForURL(url => url.searchParams.get('id') && url.searchParams.get('id') !== handoutId);
  assert.equal(await page.locator('.handout-title').inputValue(), '第3讲 一元一次方程（副本）');
  await page.locator('.handout-question').first().waitFor();
  assert.equal(await page.locator('.handout-question').count(), 6);
  assert.deepEqual(await labels(lane(1, 'practice')), ['1.', '2.'], 'the copy keeps every band');
  await page.goto(base + '/tools/handouts');
  await page.locator('.handout-list li').nth(1).waitFor();
  await page.screenshot({ path: join(out, 'list-desktop.png'), fullPage: true });
  await page.locator('.handout-list li', { hasText: '副本' }).getByRole('button', { name: '更多' }).click();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await page.locator('.handout-list li', { hasText: '副本' }).waitFor({ state: 'detached' });
  assert.equal((await api('/api/handouts')).handouts.length, 1);
  step('讲义列表: 复制一份 keeps all 6 questions and their bands; 删除 removes it');

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
