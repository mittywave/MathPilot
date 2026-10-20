import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

// Records the demos on the 01 闭环 cards: the real app, driven step by step, into public/intro/loop/<step>-<mode>.mp4
// and its first frame, the card's cover, beside it as .jpg.
// Run it against a scratch copy of the data with its students renamed and its AI switched off, never the live server:
// every model answer is replayed from a capture taken once on that copy, and the waits for them are cut out.
//   REC_ASSETS=<dir with question.png, hw/*.jpg, capture/*.json> PLAYWRIGHT_PACKAGE=<package.json beside playwright>
//   CHROMIUM_PATH=<Chrome> FFMPEG=<ffmpeg> [BASE=http://127.0.0.1:3031] node scripts/record-intro-loop.mjs [step …]
//   --modes light,dark   which appearances (both by default)
//   --work <dir>         where the raw frames go (REC_ASSETS/work by default)
// intake saves a question, paper saves a plan that assign then hands out, and profile saves a note: restore the copy
// between runs. paper must run before assign.
const SCENES = ['intake', 'paper', 'handout', 'assign', 'grading', 'profile', 'report'];
const FPS = 30;
const [W, H, SCALE] = [1160, 800, 2]; // the card's 1.45, at twice the pixels
const OUT = [1450, 1000];

const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i < 0 ? null : args.splice(i, 2)[1]; };
const modes = (option('--modes') ?? 'light,dark').split(',');
const ASSETS = resolve(process.env.REC_ASSETS ?? '.');
const WORK = resolve(option('--work') ?? join(ASSETS, 'work'));
const scenes = args.length ? args : SCENES;
for (const name of scenes) if (!SCENES.includes(name)) throw new Error(`no such step: ${name}`);
const BASE = process.env.BASE ?? 'http://127.0.0.1:3031';
const out = resolve('public/intro/loop');
if (!process.env.FFMPEG) throw new Error('set FFMPEG to an ffmpeg binary');
const { chromium } = createRequire(process.env.PLAYWRIGHT_PACKAGE || import.meta.url)('playwright');

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// A drawn pointer (the headless window has none), a ripple where it presses, and key caps for shortcuts.
const POINTER = `(() => {
  if (window.__rec) return; window.__rec = true;
  let pos = [${W / 2}, ${H / 2}];
  try { pos = JSON.parse(sessionStorage.getItem('__rec_pointer')) || pos; } catch {}
  const css = document.createElement('style');
  css.textContent = \`
    #__rec_pointer { position:fixed; left:0; top:0; z-index:2147483647; pointer-events:none; filter:drop-shadow(0 1.5px 2px rgba(0,0,0,.28)); }
    .__rec_ripple { position:fixed; z-index:2147483646; pointer-events:none; width:40px; height:40px; margin:-20px 0 0 -20px; border-radius:50%;
      background:rgba(62,94,76,.22); border:2px solid rgba(62,94,76,.6); animation:__rec_ripple .55s cubic-bezier(.2,.7,.3,1) forwards; }
    @keyframes __rec_ripple { from { transform:scale(.25); opacity:1; } to { transform:scale(1.3); opacity:0; } }
    #__rec_keys { position:fixed; left:50%; bottom:90px; transform:translateX(-50%); z-index:2147483646; pointer-events:none; display:flex; gap:8px;
      opacity:0; transition:opacity .25s, transform .25s; }
    #__rec_keys.on { opacity:1; transform:translateX(-50%) translateY(-6px); }
    #__rec_keys kbd { font:600 24px/1 -apple-system, "PingFang SC", sans-serif; color:#fff; background:rgba(20,32,27,.84); border-radius:12px;
      padding:13px 17px; min-width:52px; text-align:center; box-shadow:0 8px 24px rgba(0,0,0,.25); }
  \`;
  const pointer = document.createElement('div'); pointer.id = '__rec_pointer';
  pointer.innerHTML = '<svg width="22" height="28" viewBox="0 0 24 30"><path d="M2.5 1.8 L2.5 22.8 L7.6 17.9 L11.3 26.6 L15.1 25 L11.4 16.6 L18.6 16.6 Z" fill="#141a17" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/></svg>';
  const keys = document.createElement('div'); keys.id = '__rec_keys';
  const place = () => { pointer.style.transform = 'translate(' + (pos[0] - 2.5) + 'px,' + (pos[1] - 1.8) + 'px)'; };
  const mount = () => { if (!document.documentElement) return; for (const n of [css, pointer, keys]) if (!n.isConnected) document.documentElement.appendChild(n); place(); };
  mount(); document.addEventListener('DOMContentLoaded', mount); setInterval(mount, 500);
  addEventListener('mousemove', (e) => { pos = [e.clientX, e.clientY]; place(); try { sessionStorage.setItem('__rec_pointer', JSON.stringify(pos)); } catch {} }, { capture: true, passive: true });
  addEventListener('mousedown', (e) => { const r = document.createElement('div'); r.className = '__rec_ripple'; r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px';
    document.documentElement.appendChild(r); setTimeout(() => r.remove(), 700); }, { capture: true, passive: true });
  window.__recKeys = (labels, ms) => { keys.innerHTML = labels.map((k) => '<kbd>' + k + '</kbd>').join(''); keys.classList.add('on');
    clearTimeout(window.__recKeysTimer); window.__recKeysTimer = setTimeout(() => keys.classList.remove('on'), ms); };
})();`;

class Take {
  constructor(name, mode) { this.name = name; this.mode = mode; this.dir = join(WORK, `${name}-${mode}`); this.cuts = []; this.frames = []; this.mouse = [W / 2, H / 2]; }
  async open() {
    // The screencast grabs the window surface, so the window is sized and scaled exactly like the viewport.
    this.browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
      args: [`--window-size=${W},${H}`, `--force-device-scale-factor=${SCALE}`, '--hide-scrollbars'] });
    this.context = await this.browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', acceptDownloads: true });
    const appearance = this.mode === 'dark' ? 'tech' : 'light';
    await this.context.addInitScript((value) => { try { localStorage.setItem('mitty-appearance', value); } catch { /* storage off: the page stays light */ } }, appearance);
    await this.context.addInitScript(POINTER);
    // Nothing that would reach a model gets through; the answers that matter are replayed.
    await this.context.route(/\/api\/(optimize|reconstruct-diagram|recognize-note)(\?|$)/, (route) => route.abort());
    this.page = await this.context.newPage();
    this.page.on('pageerror', (e) => console.log(`[${this.name}] pageerror`, e.message));
  }
  async goto(path, settle = 1200) {
    await this.page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
    await this.page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await sleep(settle);
  }
  // Replays a model answer captured on the copy, after `delay` (cut out of the clip by the step that waits for it).
  async replay(pattern, prefix, delay = 1500) {
    const dir = join(ASSETS, 'capture');
    const saved = JSON.parse(readFileSync(join(dir, readdirSync(dir).filter((f) => f.startsWith(prefix)).sort()[0]), 'utf8'));
    await this.page.route(pattern, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await sleep(delay);
      await route.fulfill({ status: saved.status, contentType: 'application/json', body: JSON.stringify(saved.response) });
    });
    return saved;
  }
  async park(x, y) { await this.page.mouse.move(x, y); this.mouse = [x, y]; }

  async start() {
    rmSync(this.dir, { recursive: true, force: true }); mkdirSync(join(this.dir, 'frames'), { recursive: true });
    this.cdp = await this.context.newCDPSession(this.page);
    let n = 0;
    this.cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
      const file = `f${String(n++).padStart(6, '0')}.jpg`;
      writeFileSync(join(this.dir, 'frames', file), Buffer.from(data, 'base64'));
      this.frames.push({ file, t: metadata.timestamp });
      try { await this.cdp.send('Page.screencastFrameAck', { sessionId }); } catch { /* the session closed */ }
    });
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W * SCALE, maxHeight: H * SCALE, everyNthFrame: 1 });
    await this.page.evaluate(() => { document.documentElement.style.outline = '0 solid transparent'; requestAnimationFrame(() => { document.documentElement.style.outline = ''; }); });
    await sleep(400);
    this.t0 = this.frames.length ? this.frames[0].t : Date.now() / 1000;
  }
  // What the screen shows while `work` runs (a model, a page load, a typeset) is left out of the clip.
  async cut(work, { head = 0.35, tail = 0.15 } = {}) {
    const a = Date.now() / 1000 + head; await work(); const b = Date.now() / 1000 - tail;
    if (b > a) this.cuts.push([a, b]);
  }
  async stop(tail = 0.8) {
    await sleep(tail * 1000);
    const end = Date.now() / 1000;
    await this.cdp.send('Page.stopScreencast');
    await sleep(200);
    await this.browser.close();
    this.encode(end);
  }
  encode(end) {
    const frames = this.frames.filter((f) => f.t <= end);
    const cuts = [...this.cuts].sort((x, y) => x[0] - y[0]);
    const removed = cuts.reduce((sum, [a, b]) => sum + (b - a), 0);
    const count = Math.round((end - this.t0 - removed) * FPS);
    const sourceAt = (tau) => { let t = this.t0 + tau; for (const [a, b] of cuts) if (t >= a) t += b - a; return t; };
    // A steady 30 fps: each output frame shows the newest screencast frame at its moment.
    const list = [];
    for (let i = 0, k = 0; i < count; i++) {
      const at = sourceAt(i / FPS);
      while (k + 1 < frames.length && frames[k + 1].t <= at) k++;
      if (list.at(-1)?.file === frames[k].file) list.at(-1).n++; else list.push({ file: frames[k].file, n: 1 });
    }
    const lines = ['ffconcat version 1.0', ...list.flatMap((item) => [`file 'frames/${item.file}'`, `duration ${(item.n / FPS).toFixed(6)}`]), `file 'frames/${list.at(-1).file}'`];
    writeFileSync(join(this.dir, 'list.ffconcat'), lines.join('\n'));
    mkdirSync(out, { recursive: true });
    const file = join(out, `${this.name}-${this.mode}.mp4`);
    // JPEG frames to RGB, then BT.709 limited-range YUV, tagged as such, so browsers show the app's own colours.
    execFileSync(process.env.FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(this.dir, 'list.ffconcat'),
      '-vf', `fps=${FPS},scale=${OUT[0]}:${OUT[1]}:flags=lanczos,format=rgb24,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p`, '-frames:v', String(count),
      '-c:v', 'libx264', '-preset', 'slow', '-tune', 'animation', '-crf', '27', '-profile:v', 'high', '-g', String(FPS * 2),
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv', '-movflags', '+faststart', '-an', file]);
    // its first frame is the card's cover until it plays
    execFileSync(process.env.FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-frames:v', '1', '-q:v', '4', file.replace(/\.mp4$/, '.jpg')]);
    console.log(`${file}  ${(count / FPS).toFixed(1)} s, ${(frames.length / ((end - this.t0) || 1)).toFixed(0)} fps captured, ${(statSync(file).size / 1024).toFixed(0)} KB`);
  }

  async box(target) {
    if (Array.isArray(target)) return { x: target[0], y: target[1], width: 0, height: 0 };
    const loc = typeof target === 'string' ? this.page.locator(target).first() : target;
    await loc.waitFor({ state: 'visible', timeout: 20000 });
    await loc.scrollIntoViewIfNeeded();
    return loc.boundingBox();
  }
  // An eased move along a slight arc, timed by the clock so a slow page doesn't stretch it.
  async move(target, ms = 650, { dx = 0.5, dy = 0.5 } = {}) {
    const b = await this.box(target);
    const [x, y] = [b.x + b.width * dx, b.y + b.height * dy];
    const [x0, y0] = this.mouse;
    const bend = Math.min(50, Math.hypot(x - x0, y - y0) * 0.08);
    const begin = Date.now();
    for (;;) {
      const t = Math.min(1, (Date.now() - begin) / ms), p = ease(t);
      await this.page.mouse.move(x0 + (x - x0) * p, y0 + (y - y0) * p - Math.sin(Math.PI * p) * bend);
      if (t >= 1) break;
      await sleep(10);
    }
    this.mouse = [x, y];
  }
  async click(target, { ms = 600, after = 300, dx, dy } = {}) {
    await this.move(target, ms, { dx, dy });
    await sleep(120);
    await this.page.mouse.down(); await sleep(70); await this.page.mouse.up();
    await sleep(after);
  }
  async hover(target, ms = 600, hold = 500, opts) { await this.move(target, ms, opts); await sleep(hold); }
  async type(text, cps = 14) {
    for (const ch of text) { await this.page.keyboard.type(ch); await sleep((1000 / cps) * (/[，。、；：,.\s]/.test(ch) ? 2 : 1) * (0.75 + Math.random() * 0.5)); }
  }
  async keys(labels, ms = 1100) { await this.page.evaluate(([l, m]) => window.__recKeys?.(l, m), [labels, ms]); }
  // Eased scroll of whatever scrolls `target` (the page when null), to a top or by a delta.
  async scroll(target, { to = null, by = null, ms = 1000 } = {}) {
    const handle = target ? await this.page.locator(target).first().elementHandle() : null;
    await this.page.evaluate(async ([el, to, by, ms]) => {
      let box = document.scrollingElement;
      for (let n = el; n && n !== document.body; n = n.parentElement) if (/(auto|scroll)/.test(getComputedStyle(n).overflowY) && n.scrollHeight > n.clientHeight + 2) { box = n; break; }
      const from = box.scrollTop, goal = Math.max(0, Math.min(box.scrollHeight - box.clientHeight, to ?? from + by));
      const start = performance.now(), ez = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
      await new Promise((done) => { const step = (now) => { const p = Math.min(1, (now - start) / ms); box.scrollTop = from + (goal - from) * ez(p); if (p < 1) requestAnimationFrame(step); else done(); }; requestAnimationFrame(step); });
    }, [handle, to, by, ms]);
  }
  // Drops files on an element as a drag from the Finder would, or pastes them into it with ⌘V.
  async give(selector, files, how) {
    const list = files.map(({ path, type }) => ({ name: path.split('/').pop(), type, data: readFileSync(path).toString('base64') }));
    await this.page.evaluate(async ([selector, list, how]) => {
      const target = document.querySelector(selector);
      const data = new DataTransfer();
      for (const f of list) data.items.add(new File([Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
      if (how === 'paste') { target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); return; }
      target.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
      await new Promise((done) => setTimeout(done, 400));
      target.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    }, [selector, list, how]);
  }
}

const MIA = 'f9f627a2-6b64-4f22-aa1c-9423c095e715';
const GRADED = 'a2374508-a98f-48fa-9230-60b6168d4d93';
const role = (s, kind, name) => s.page.getByRole(kind, { name }).first();

const STEPS = {
  // 入库: paste a screenshot, the recognized question, save it into the library.
  async intake(s) {
    await s.replay(/\/api\/recognize(\?|$)/, 'recognize-');
    await s.goto('/library', 1500);
    await s.park(760, 300);
    await s.start();
    await sleep(500);
    await s.click(role(s, 'button', /新建试题/), { after: 600 });
    await s.move([620, 330], 500);
    await s.keys(['⌘', 'V']);
    await sleep(200);
    await s.cut(async () => {
      await s.give('section.question-modal', [{ path: join(ASSETS, 'question.png'), type: 'image/png' }], 'paste');
      await s.page.getByText(/识别可信度/).waitFor({ timeout: 20000 });
      await sleep(300);
    }, { head: 0.7 });
    await s.hover([760, 300], 600, 900);
    await s.scroll('section.question-modal', { by: 900, ms: 1300 });
    await s.click(role(s, 'button', '确认并保存'), { after: 1600 });
    await s.stop();
  },

  // 组卷: one sentence about the practice wanted, the plan from the student's archive, typeset.
  async paper(s) {
    const saved = await s.replay(/\/api\/smart-paper(\?|$)/, 'smart-paper-');
    await s.goto(`/tools/smart-paper?student=${MIA}`, 1500);
    await s.park(700, 300);
    await s.start();
    await sleep(400);
    await s.click(s.page.locator('textarea').first(), { after: 200 });
    await s.type(saved.request.request, 30);
    await sleep(250);
    await s.click(role(s, 'button', /生成方案/), { after: 100 });
    await s.cut(async () => { await s.page.locator('.smart-paper-day').first().waitFor({ timeout: 20000 }); await sleep(300); }, { head: 0.5 });
    await s.move([820, 420], 700);
    await s.scroll('.smart-paper-day', { by: 300, ms: 1200 });
    await sleep(500);
    await s.cut(async () => {
      await s.click(role(s, 'button', /^排版$/), { after: 200 });
      await s.page.getByRole('button', { name: '下载 PDF' }).waitFor({ timeout: 40000 });
      await s.page.waitForFunction(() => document.querySelectorAll('canvas').length > 0, null, { timeout: 40000 });
      await s.page.getByText('正在排版').first().waitFor({ state: 'hidden', timeout: 40000 }).catch(() => {});
      await sleep(800);
    }, { head: 0.6 });
    await s.hover(role(s, 'button', '下载 PDF'), 700, 1400);
    await s.stop();
  },

  // 讲义: a lesson, a question picked from the library into it, the three sheets.
  async handout(s) {
    await s.goto('/tools/handouts', 1500);
    await s.page.getByText('正负数的五则运算').first().click();
    await s.page.locator('.handout-draft').waitFor({ timeout: 20000 });
    await s.goto(new URL(s.page.url()).pathname + new URL(s.page.url()).search, 1500);
    await s.park(700, 300);
    await s.start();
    await sleep(400);
    await s.click(s.page.locator('.handout-draft').getByText('从题库选题').first(), { after: 700 });
    await s.click(s.page.getByRole('button', { name: /选择/ }).first(), { after: 500 });
    await sleep(600);
    await s.move([760, 450], 700);
    await s.scroll('.handout-draft', { by: 260, ms: 1200 });
    await sleep(1200);
    await s.stop();
  },

  // 布置: the plan 组卷 made, handed out to the student from the archive.
  async assign(s) {
    await s.goto(`/library?view=wrong-book&studentId=${MIA}&tab=homework`, 1500);
    await s.park(800, 300);
    await s.start();
    await sleep(400);
    await s.click(role(s, 'button', '布置作业'), { after: 700 });
    await s.cut(async () => {
      await s.click(s.page.locator('.assign-plans button').first(), { after: 0 });
      await s.page.getByRole('dialog', { name: '布置给学生' }).waitFor({ timeout: 20000 });
      await sleep(300);
    }, { head: 0.4 });
    await s.hover(s.page.getByRole('dialog', { name: '布置给学生' }).locator('label.on').first(), 600, 500);
    await s.click(s.page.getByRole('dialog', { name: '布置给学生' }).getByRole('button', { name: /^布置/ }), { after: 300 });
    await s.page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
    await s.hover(s.page.locator('.student-homework li').first(), 700, 1500, { dx: 0.3 });
    await s.stop();
  },

  // 批改: the student's photos dropped in, then the graded paper with its marks and reasons.
  async grading(s) {
    await s.goto(`/tools/homework/upload?studentId=${MIA}`, 1500);
    await s.park(800, 500);
    await s.start();
    await sleep(400);
    await s.move(s.page.getByText('粘贴或拖入学生的作业'), 700);
    const dir = join(ASSETS, 'hw');
    await s.give('section.homework-pages', readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort().map((f) => ({ path: join(dir, f), type: 'image/jpeg' })), 'drop');
    await s.page.locator('.homework-pages-list li').nth(2).waitFor({ timeout: 15000 });
    await sleep(600);
    await s.hover(role(s, 'button', '开始自动批改'), 700, 500);
    await s.page.mouse.down(); await sleep(70); await s.page.mouse.up();
    await s.cut(async () => { await s.goto(`/tools/homework/submissions/${GRADED}`, 1500); }, { head: 0.3 });
    await s.move([700, 450], 600);
    await s.scroll(null, { by: 380, ms: 1500 });
    await s.hover(s.page.getByText('错误原因').first(), 700, 1500);
    await s.stop();
  },

  // 定档: automatic ability analysis with traceable graded answers.
  async profile(s) {
    await s.replay(/\/api\/students\/[^/]+\/profile(\?|$)/, `students_${MIA}_profile-`, 1200);
    await s.goto(`/library?view=wrong-book&studentId=${MIA}&tab=profile`, 1500);
    await s.park(700, 300);
    await s.start();
    await sleep(500);
    await s.hover(s.page.locator('.profile-card').first(), 700, 600, { dy: 0.4 });
    await s.cut(async () => {
      await s.page.locator('.ability-insights li').first().waitFor({ timeout: 20000 });
    }, { head: 0.5 });
    await s.click(s.page.locator('.ability-evidence summary').first(), { after: 800 });
    await s.scroll(null, { by: 260, ms: 1200 });
    await s.stop();
  },

  // 学情: a month's report written from homework and ability evidence.
  async report(s) {
    await s.replay(/\/api\/students\/[^/]+\/reports(\?|$)/, `students_${MIA}_reports-`, 1500);
    await s.goto(`/library?view=wrong-book&studentId=${MIA}&tab=report`, 1500);
    await s.park(700, 300);
    await s.start();
    await sleep(500);
    await s.click(role(s, 'button', '生成学情报告'), { after: 100 });
    await s.cut(async () => { await s.page.getByRole('button', { name: '下载 PDF' }).first().waitFor({ timeout: 20000 }); await sleep(300); }, { head: 0.5 });
    await s.move([640, 450], 700);
    await s.scroll(null, { by: 420, ms: 2000 });
    await sleep(900);
    await s.hover(role(s, 'button', '下载 PDF'), 700, 1200);
    await s.stop();
  },
};

for (const name of scenes) {
  for (const mode of modes) {
    const take = new Take(name, mode);
    await take.open();
    try { await STEPS[name](take); }
    catch (error) {
      console.error(`[${name}/${mode}] failed:`, error.message);
      await take.page.screenshot({ path: join(WORK, `fail-${name}-${mode}.png`) }).catch(() => {});
      await take.browser.close();
    }
  }
}
