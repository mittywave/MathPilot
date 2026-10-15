import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import JSZip from 'jszip';

// Run against an isolated dev database, with LOCAL_ADMIN_MODE=true, never port 3001.
// BASKET_VERIFY_URL=http://127.0.0.1:3002 PLAYWRIGHT_PACKAGE=<bundled package.json> node scripts/verify-basket-browser.mjs
const base = process.env.BASKET_VERIFY_URL;
const target = new URL(base || 'http://invalid');
assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname) && target.port && target.port !== '3001', 'supply a separate loopback test server');
const require = createRequire(process.env.PLAYWRIGHT_PACKAGE || import.meta.url);
const { chromium } = require('playwright');
const out = resolve('artifacts/basket-verification');
await mkdir(out, { recursive: true });
const result = { steps: [], pageErrors: [], downloads: {} };
const step = (text) => { result.steps.push(text); console.log('✓', text); };
const api = async (path, body, method = body ? 'POST' : 'GET') => {
  const response = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json', Origin: base } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(data)}`);
  return data;
};
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
page.setDefaultTimeout(30000);
page.on('pageerror', (error) => result.pageErrors.push(String(error)));
const outline = page.getByLabel('试卷结构', { exact: true });
const headings = () => page.locator('.basket-section-heading');
const titleInput = () => page.locator('.basket-title input');
const ready = () => page.getByRole('status').filter({ hasText: '已保存在本机' }).waitFor();
const choose = async (code) => {
  await page.locator('.search input').fill(code);
  const card = page.locator('.question-card').filter({ has: page.locator('.meta span', { hasText: `ID ${code}` }) });
  await card.locator('.check').click();
};
const basket = async () => { await page.locator('.topbar').getByRole('button', { name: /组卷篮/ }).click(); await outline.waitFor(); };
const library = () => page.locator('.topbar').getByRole('button', { name: '题库', exact: true }).click();
const exportFile = async (button, name) => {
  const pending = page.waitForEvent('download', { timeout: 240000 });
  await button.click();
  await (await pending).saveAs(join(out, name));
  result.downloads[name] = (await readFile(join(out, name))).length;
};
const stored = (owner, value) => page.evaluate(([owner, value]) => new Promise((resolve, reject) => {
  const open = indexedDB.open('mathpilot-paper-basket', 1);
  open.onerror = () => reject(open.error);
  open.onsuccess = () => {
    const db = open.result, tx = db.transaction('drafts', value ? 'readwrite' : 'readonly');
    const request = value ? tx.objectStore('drafts').put(value, owner) : tx.objectStore('drafts').get(owner);
    tx.oncomplete = () => { db.close(); resolve(value ? null : request.result); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  };
}), [owner, value]);
try {
  assert.equal((await api('/api/auth/me')).user.local, true);
  await page.goto(base);
  const figure = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const c = canvas.getContext('2d'); c.fillStyle = '#fff'; c.fillRect(0, 0, 320, 180); c.strokeStyle = '#222'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(40, 140); c.lineTo(260, 140); c.lineTo(40, 30); c.closePath(); c.stroke();
    c.font = '20px serif'; c.fillStyle = '#222'; c.fillText('A', 20, 30); c.fillText('B', 20, 164); c.fillText('C', 268, 145);
    return canvas.toDataURL('image/png');
  });
  const { module } = await api('/api/modules', { module: { name: `结构组卷验收 ${Date.now()}`, subtitle: '' } });
  const types = ['单选题', '多选题', '填空题', '判断题', '解答题', '解答题'];
  const questions = [];
  for (let index = 0; index < 52; index++) {
    const n = index + 1;
    const question = { id: `basket-fixture-${module.id}-${n}`, moduleId: module.id, categoryId: module.id, type: types[index % types.length], difficulty: '基础',
      stem: n === 1 ? '计算 $\\frac{1}{2}+\\frac{1}{3}$ 的结果是（　　）' : n === 6 ? '根据表格和直角三角形，求面积并说明理由。' : `验收题 ${n}：计算 $${n}+2$。`,
      options: index % 6 === 0 ? ['$\\frac{5}{6}$', '$1$', '$2$', '$3$'] : index % 6 === 1 ? ['A', 'B', 'C', 'D'] : [],
      answer: n === 1 ? '$\\frac{5}{6}$' : index % 6 === 1 ? 'AB' : String(n + 2), analysis: n === 1 ? '先通分。\n$=\\frac{3}{6}+\\frac{2}{6}$\n$=\\frac{5}{6}$' : `计算可得 $${n}+2=${n + 2}$。`, source: '', tags: [], createdAt: Date.now(), updatedAt: Date.now(),
      ...(n === 6 ? { contentImages: [figure], imageLayout: 'below', stemDocxXml: ['<w:p><w:r><w:t>6．根据表格和直角三角形，求面积并说明理由。</w:t></w:r></w:p>', '<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="2500"/><w:gridCol w:w="2500"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="2500" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>底边</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="2500" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>高</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>8 cm</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>4 cm</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'] } : {}) };
    questions.push((await api('/api/questions', { question })).question);
  }
  await page.reload(); await basket(); await ready(); await library();
  for (const question of questions.slice(0, 6)) await choose(question.code);
  await basket();
  await titleInput().fill('结构化组卷验收');
  assert.deepEqual(await outline.locator('.basket-outline-locate').allTextContents(), ['1', '2', '3', '4', '5', '6'], 'the compact outline shows only global question numbers');
  assert.equal(await outline.locator('.katex').count(), 0, 'question stems and equations stay in the right-hand cards');
  // A true gap drop must insert between its neighbours, not append to the section.
  const fourth = outline.locator(`[data-question-id="${questions[3].id}"]`);
  const secondBox = await outline.getByRole('button', { name: '定位第 2 题', exact: true }).boundingBox();
  const sourceBox = await fourth.boundingBox();
  await page.mouse.move(sourceBox.x + 16, sourceBox.y + 16);
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + 24, sourceBox.y + 16, { steps: 3 });
  await page.mouse.move(secondBox.x + secondBox.width + 2, secondBox.y + 16, { steps: 8 });
  await outline.locator('.insert-before').waitFor();
  assert.equal(await outline.locator('.insert-before [data-question-id]').getAttribute('data-question-id'), questions[2].id);
  await page.screenshot({ path: join(out, 'insertion-preview.png'), fullPage: false });
  await page.mouse.up(); await ready();
  assert.deepEqual((await stored('local-admin')).structure.unassignedIds, [questions[0].id, questions[1].id, questions[3].id, questions[2].id, questions[4].id, questions[5].id]);
  assert.equal(await outline.locator('.is-moved [data-question-id]').getAttribute('data-question-id'), questions[3].id);
  assert.match(await page.locator('.app-toast').innerText(), /原第 4 题.*第 3 位/);
  await page.screenshot({ path: join(out, 'insertion-result.png'), fullPage: false });
  // The right half of a tile places after it, including forward movement.
  await fourth.dragTo(outline.locator(`[data-question-id="${questions[2].id}"]`), { targetPosition: { x: 28, y: 16 } });
  await ready();
  assert.deepEqual((await stored('local-admin')).structure.unassignedIds, questions.slice(0, 6).map((question) => question.id));
  step('native gap insertion previews the exact slot, confirms/highlights the moved question, and right-half drops insert after a tile');
  await outline.getByRole('button', { name: '按题型分类', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.basket-section-heading').length === 5);
  assert.deepEqual(await headings().allTextContents(), ['一、单选题1 题', '二、多选题1 题', '三、填空题1 题', '四、判断题1 题', '五、解答题2 题']);
  await page.getByRole('textbox', { name: '大标题 1', exact: true }).fill('选择与基础');
  await page.getByRole('combobox', { name: '第 3 题移动到', exact: true }).selectOption({ label: '选择与基础' });
  assert.equal(await page.getByRole('button', { name: '上移第 3 题', exact: true }).isDisabled(), true, 'the next section starts with its own disabled up button');
  await outline.getByRole('button', { name: '＋ 大标题', exact: true }).click();
  await page.getByRole('textbox', { name: '大标题 6', exact: true }).fill('综合应用');
  await page.getByRole('combobox', { name: '第 6 题移动到', exact: true }).selectOption({ label: '综合应用' });
  await ready();
  step('classification, inline title editing, cross-section dropdown, empty section and within-section move boundaries');

  // Keep source and target visible in the independently scrolling outline.
  // Real HTML drag-and-drop, via the same handles the user operates.
  for (const name of ['多选题', '填空题', '判断题']) await outline.getByRole('button', { name: `折叠${name}`, exact: true }).click();
  await outline.getByRole('button', { name: '定位第 2 题', exact: true }).dragTo(outline.locator('.basket-outline-section').nth(4).locator('header'));
  await page.waitForFunction(() => document.querySelectorAll('.basket-outline-section')[4].querySelectorAll('.basket-outline-question').length === 2);
  for (const name of ['选择与基础', '解答题', '综合应用']) await outline.getByRole('button', { name: `折叠${name}`, exact: true }).click();
  await outline.getByRole('button', { name: '拖动大标题 综合应用', exact: true }).dragTo(outline.locator('.basket-outline-section').first().locator('header'));
  await page.waitForFunction(() => document.querySelector('input[aria-label="大标题 1"]')?.value === '综合应用');
  await outline.getByRole('button', { name: '展开综合应用', exact: true }).click();
  await outline.getByRole('button', { name: '折叠综合应用', exact: true }).click();
  await outline.getByRole('button', { name: '展开综合应用', exact: true }).click();
  await ready();
  await page.reload(); await outline.waitFor(); await ready();
  assert.equal(await titleInput().inputValue(), '结构化组卷验收');
  assert.equal(await page.getByRole('textbox', { name: '大标题 1', exact: true }).inputValue(), '综合应用');
  assert.equal(await page.locator('.basket-outline-question').count(), 6);
  step('native drag across groups and group ordering, collapse/expand, full draft restored after refresh');

  await library(); await choose(questions[6].code); await basket();
  assert.match(await headings().last().innerText(), /其他题目/);
  await outline.getByRole('button', { name: '大标题 1 操作', exact: true }).click();
  await outline.getByRole('button', { name: '删除标题，题目移回未分组', exact: true }).click();
  assert.equal(await page.locator('.basket-outline-question').count(), 7);
  await outline.getByRole('button', { name: '按题型分类', exact: true }).click();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: '大标题 1', exact: true }).inputValue(), '选择与基础');
  step('new selections stay unassigned, deleting a heading retains questions, classification overwrite can be cancelled');

  // Verify the entire large outline can locate a card beyond the initial 40.
  await library();
  for (const question of questions.slice(7)) await choose(question.code);
  await basket();
  const finalRow = outline.locator('.basket-outline-question').last();
  await finalRow.locator('.basket-outline-locate').click();
  await page.waitForFunction(() => document.activeElement?.id === document.querySelector('.question-list .question-card:last-child')?.id);
  assert.equal(await page.locator('.question-list .question-card').count(), 52);
  assert.equal(await page.locator('.question-list .question-number').last().innerText(), '52.');
  step('52-question directory locates and focuses the final card beyond lazy pagination');

  // Keep six representative questions through the real remove controls for readable export evidence.
  const keep = new Set(questions.slice(0, 6).map((question) => question.id));
  for (const question of questions.filter((question) => !keep.has(question.id))) {
    const row = outline.locator('.basket-outline-question').filter({ has: page.locator(`[data-question-id="${question.id}"]`) });
    await row.locator('.basket-outline-locate').click();
    await page.locator(`[id="basket-question-${question.id}"]`).getByRole('button', { name: /^移除第/ }).click();
  }
  await page.getByRole('textbox', { name: '大标题 1', exact: true }).fill('选择与基础');
  for (const width of [1280, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no horizontal overflow');
    const box = await page.getByRole('button', { name: '生成 Word', exact: true }).boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= 1000, 'export action stays visible');
    await page.screenshot({ path: join(out, `basket-${width}.png`), fullPage: false });
  }
  await exportFile(page.getByRole('button', { name: '生成 Word', exact: true }), 'structured-basket.docx');
  const zip = await JSZip.loadAsync(await readFile(join(out, 'structured-basket.docx')));
  const xml = await zip.file('word/document.xml').async('string');
  const fonts = await zip.file('word/fontTable.xml').async('string');
  assert.match(fonts, /Songti SC/); assert.match(fonts, /Times New Roman/);
  assert.match(xml, /<m:f>/); assert.match(xml, /<w:tbl>/); assert.match(xml, /<w:drawing>/);
  assert.equal((xml.match(/一、选择与基础/g) ?? []).length, 2, 'body and answer headings match');
  assert.match(xml, /6．答案：/);
  step('1280/1440 desktop layout and real Word download with editable fractions, source table, picture and grouped answer key');

  await page.getByRole('button', { name: '快速排版', exact: true }).click();
  await page.getByRole('button', { name: '下载 PDF', exact: true }).waitFor();
  await page.locator('.typeset-download:not(:disabled)').waitFor({ timeout: 240000 });
  await exportFile(page.getByRole('button', { name: '下载 PDF', exact: true }), 'structured-basket.pdf');
  const pdf = (await readFile(join(out, 'structured-basket.pdf'))).toString('base64');
  const inspected = await page.evaluate(async (encoded) => {
    const { openPdf } = await import('/lib/pdfjs.ts');
    const doc = await (await openPdf(Uint8Array.from(atob(encoded), (letter) => letter.charCodeAt(0)))).promise;
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) pages.push((await (await doc.getPage(n)).getTextContent()).items.map((item) => item.str).join(' '));
    const anchors = await Promise.all(Array.from({ length: 6 }, (_, i) => doc.getDestination(`q${i + 1}`)));
    return { pages, anchors: anchors.map(Boolean) };
  }, pdf);
  assert.ok(inspected.anchors.every(Boolean), 'all six global PDF anchors exist');
  assert.equal(inspected.pages.filter((text) => text.includes('一、选择与基础')).length, 2);
  assert.match(inspected.pages.join(' '), /其他题目/);
  await writeFile(join(out, 'pdf-text.json'), JSON.stringify(inspected, null, 2));
  await page.getByRole('button', { name: '布置给学生', exact: true }).click();
  assert.equal(await page.getByText('交作业日期', { exact: true }).count(), 1);
  assert.doesNotMatch(await page.locator('.assign-summary').innerText(), /分.*天/);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.screenshot({ path: join(out, 'typeset-sections.png'), fullPage: false });
  await page.locator('.typeset-region-hit').first().click();
  await page.locator('.typeset-popover input[type="number"]').fill('8');
  await page.waitForFunction(() => document.querySelector('.typeset-own')?.textContent.includes('8 mm'));
  await page.getByRole('button', { name: '← 组卷篮', exact: true }).click();
  await ready();
  step('real PDF typesetting; sectioned paper remains one homework with one due date');

  // Renaming and regrouping the last item keep the exact same ordered IDs.
  // A later change of order must clear per-question spacing, which is index based.
  const spacing = await stored('local-admin');
  assert.equal(spacing.typeset.settings.ownRoom['0'], 8);
  await outline.getByRole('button', { name: '＋ 大标题', exact: true }).click();
  await page.getByRole('textbox', { name: '大标题 6', exact: true }).fill('卷末应用');
  await page.getByRole('combobox', { name: '第 6 题移动到', exact: true }).selectOption({ label: '卷末应用' });
  await page.getByRole('button', { name: '快速排版', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.typeset-own')?.textContent.includes('8 mm'));
  await page.reload();
  await outline.waitFor(); await ready();
  assert.equal((await stored('local-admin')).typeset.settings.ownRoom['0'], 8, 'settings saved while overlay is open survive refresh');
  await page.getByRole('combobox', { name: '第 2 题移动到', exact: true }).selectOption({ label: '选择与基础' });
  await page.getByRole('button', { name: '上移第 2 题', exact: true }).click();
  await page.getByRole('button', { name: '快速排版', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.typeset-rooms li').length > 0);
  assert.equal(await page.locator('.typeset-own').count(), 0, 'changed question order clears the indexed spacing');
  await page.getByRole('button', { name: '← 组卷篮', exact: true }).click();
  await ready();
  step('per-question spacing survives regrouping without reordering and overlay refresh; a changed order clears it');

  // Exercise a real failed IndexedDB write without replacing UI state.
  await page.evaluate(() => { const actualOpen = indexedDB.open.bind(indexedDB); window.__basketActualOpen = actualOpen; indexedDB.open = () => { throw new DOMException('test quota', 'QuotaExceededError'); }; });
  await titleInput().fill('保存失败仍可导出的试卷');
  await page.getByRole('status').filter({ hasText: '本机保存失败' }).waitFor();
  assert.equal(await page.locator('.basket-outline-question').count(), 6);
  assert.equal(await page.getByRole('button', { name: '生成 Word', exact: true }).isEnabled(), true);
  await page.evaluate(() => { indexedDB.open = window.__basketActualOpen; });
  await titleInput().fill('结构化组卷验收'); await ready();
  step('failed local save is visible, retains the live structure, and recovers on the next edit');

  // Identity response fixtures isolate the browser draft feature from the local-admin shortcut.
  // The library and every export above use the actual local server and database.
  await page.route('**/api/auth/me', (route) => route.fulfill({ json: { user: { id: 'basket-test-other-owner', email: 'other@local.invalid', role: 'member' } } }));
  await page.reload(); await outline.waitFor(); await ready();
  assert.equal(await page.locator('.basket-outline-question').count(), 0);
  await titleInput().fill('另一个账号的草稿'); await ready();
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await page.getByRole('button', { name: /登录.*注册/ }).waitFor();
  assert.equal((await stored('local-admin')).title, '结构化组卷验收', 'sign out does not erase the first account draft');
  await page.unroute('**/api/auth/me');
  await page.goto(base + '/?view=selected'); await outline.waitFor(); await ready();
  assert.equal(await titleInput().inputValue(), '结构化组卷验收');
  assert.equal(await page.locator('.basket-outline-question').count(), 6);
  assert.equal((await stored('basket-test-other-owner')).title, '另一个账号的草稿');
  step('account identity fixture: separate drafts, sign out clears memory, returning owner recovers the original structure');

  // A selected wrong-book snapshot can be restored before its student is opened.
  const previous = await stored('local-admin');
  const withSnapshot = structuredClone(previous);
  const snapshot = { ...questions[0], id: 'wrong-snapshot-fixture', code: undefined, stem: '错题快照验收', contentImages: [figure] };
  withSnapshot.snapshots.push(snapshot);
  withSnapshot.structure.unassignedIds.push(snapshot.id, 'deleted-library-reference');
  await stored('local-admin', withSnapshot);
  await page.reload(); await outline.waitFor(); await ready();
  assert.equal(await page.locator('.basket-outline-question').count(), 7);
  assert.match(await page.locator('.app-toast').innerText(), /1 道已失效/);
  await outline.locator('[data-question-id="wrong-snapshot-fixture"]').click();
  await page.waitForFunction(() => document.querySelector('[id="basket-question-wrong-snapshot-fixture"] img')?.complete);
  await page.locator('[id="basket-question-wrong-snapshot-fixture"]').getByRole('button', { name: '移除第 7 题', exact: true }).click();
  await ready();
  assert.equal((await stored('local-admin')).snapshots.length, 0);
  step('wrong-book snapshot fixture retains its picture across reload; missing references are reported and removed snapshots are released');

  await page.locator('.basket-toolbar').getByRole('button', { name: '组卷更多操作', exact: true }).click();
  await page.getByRole('button', { name: '清空组卷篮', exact: true }).click();
  await ready(); await page.reload(); await outline.waitFor(); await ready();
  assert.equal(await page.locator('.basket-outline-question').count(), 0);
  assert.equal(await page.getByRole('textbox', { name: /^大标题 / }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '生成 Word', exact: true }).isDisabled(), true);
  step('clear removes questions and section headings and remains empty after refresh');

  const cleared = await stored('local-admin');
  await stored('local-admin', { version: 999, unreadable: true });
  await page.reload(); await outline.waitFor();
  await page.getByRole('status').filter({ hasText: '本机草稿不可用' }).waitFor();
  await outline.getByRole('button', { name: '＋ 大标题', exact: true }).click();
  assert.deepEqual(await stored('local-admin'), { version: 999, unreadable: true }, 'a failed read never auto-overwrites the existing record');
  await stored('local-admin', cleared);
  await page.reload(); await outline.waitFor(); await ready();
  step('unreadable local draft stays untouched while in-memory editing remains available');

  const { record } = await api('/api/typeset-records', { title: `分天排版回归 ${Date.now()}`, plan: { groups: [
    { title: '第 1 天', theme: '热身', items: questions.slice(0, 2).map(({ id }) => ({ id })) },
    { title: '第 2 天', theme: '巩固', items: questions.slice(2, 4).map(({ id }) => ({ id })) },
  ] } });
  await page.goto(base + '/tools/typeset');
  await page.locator('.typeset-history-open', { hasText: record.title }).click();
  await page.locator('.typeset-download:not(:disabled)').waitFor({ timeout: 240000 });
  await exportFile(page.getByRole('button', { name: '下载 PDF', exact: true }), 'days-regression.pdf');
  const daysEncoded = (await readFile(join(out, 'days-regression.pdf'))).toString('base64');
  const anchorPages = await page.evaluate(async (encoded) => {
    const { openPdf } = await import('/lib/pdfjs.ts');
    const doc = await (await openPdf(Uint8Array.from(atob(encoded), (letter) => letter.charCodeAt(0)))).promise;
    return Promise.all(Array.from({ length: 4 }, async (_, index) => doc.getPageIndex((await doc.getDestination(`q${index + 1}`))[0])));
  }, daysEncoded);
  assert.deepEqual(anchorPages, [0, 0, 1, 1], 'day two still starts on its own page');
  await page.getByRole('button', { name: '布置给学生', exact: true }).click();
  assert.equal(await page.getByText('第 1 天', { exact: true }).count(), 1);
  assert.match(await page.locator('.assign-summary').innerText(), /分 2 天.*每天一份/);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  step('existing smart-paper history still typesets separate days and assigns two consecutive due dates');
  assert.deepEqual(result.pageErrors, []);
} catch (error) {
  result.error = String(error);
  await page.screenshot({ path: join(out, 'failure.png'), fullPage: false }).catch(() => {});
  throw error;
} finally {
  await writeFile(join(out, 'result.json'), JSON.stringify(result, null, 2));
  await browser.close();
}
