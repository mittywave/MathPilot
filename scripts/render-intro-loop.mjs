import { createReadStream, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';

// Renders scripts/intro-loop-demos.html into public/intro/loop/<step>-<mode>.mp4, the demos on the 01 闭环 cards.
// PLAYWRIGHT_PACKAGE=<package.json beside playwright> CHROMIUM_PATH=<Chrome> FFMPEG=<ffmpeg> node scripts/render-intro-loop.mjs [step …]
//   --modes light,dark   which appearances (both by default)
//   --frames 1.5,4,9     PNG stills at these seconds instead of videos, into --out
//   --out <dir>          where the files go (public/intro/loop by default)
//   --serve              only serve the page and print its address, for previewing in a browser
// Each frame is drawn by seeking the page's timeline, never by waiting, so a slow machine renders the same video.
const SCENES = ['intake', 'paper', 'handout', 'assign', 'grading', 'profile', 'report'];
const FPS = 30;
const [W, H, SCALE] = [725, 500, 2];

const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i < 0 ? null : args.splice(i, 2)[1]; };
const serveOnly = args.includes('--serve') && args.splice(args.indexOf('--serve'), 1);
const modes = (option('--modes') ?? 'light,dark').split(',');
const frames = option('--frames')?.split(',').map(Number);
const out = resolve(option('--out') ?? 'public/intro/loop');
const scenes = args.length ? args : SCENES;
for (const name of scenes) if (!SCENES.includes(name)) throw new Error(`no such step: ${name}`);

// The page reads KaTeX from node_modules and the wordmark from SiteHeader.tsx, so it is served from the repo.
const root = resolve('.');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml' };
const server = createServer((request, response) => {
  const path = resolve(root, `.${decodeURIComponent(new URL(request.url, 'http://x').pathname)}`);
  if (request.method !== 'GET' || (path !== root && !path.startsWith(root + sep))) return response.writeHead(404).end();
  try { if (!statSync(path).isFile()) throw new Error('not a file'); } catch { return response.writeHead(404).end(); }
  response.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'text/plain; charset=utf-8' });
  createReadStream(path).pipe(response);
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const page0 = `http://127.0.0.1:${server.address().port}/scripts/intro-loop-demos.html`;
if (serveOnly) {
  console.log(`${page0}?scene=intake&mode=light`);
  await new Promise(() => {});
}

const require = createRequire(process.env.PLAYWRIGHT_PACKAGE || import.meta.url);
const { chromium } = require('playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE, locale: 'zh-CN' });
await mkdir(out, { recursive: true });

function encoder(file) {
  if (!process.env.FFMPEG) throw new Error('set FFMPEG to an ffmpeg binary');
  // RGB frames into BT.709 limited-range YUV, tagged as such, so browsers show the colours the page has
  const ffmpeg = spawn(process.env.FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-tune', 'animation', '-crf', '28',
    '-profile:v', 'high', '-g', String(FPS * 2), '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-movflags', '+faststart', '-an', file], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((ok, fail) => ffmpeg.on('close', (code) => (code ? fail(new Error(`ffmpeg exited ${code} for ${file}`)) : ok())));
  return { write: (png) => new Promise((ok) => (ffmpeg.stdin.write(png) ? ok() : ffmpeg.stdin.once('drain', ok))), end: () => { ffmpeg.stdin.end(); return done; } };
}

for (const name of scenes) {
  for (const mode of modes) {
    const page = await context.newPage();
    page.on('pageerror', (error) => console.error(`[${name}/${mode}]`, error.message));
    page.on('console', (message) => { if (message.type() === 'error') console.error(`[${name}/${mode}]`, message.text()); });
    await page.goto(`${page0}?scene=${name}&mode=${mode}&render`);
    await page.evaluate(() => window.ready);
    const { duration } = await page.evaluate(() => window.scene);
    const shoot = async (t) => {
      await page.evaluate((at) => new Promise((done) => { window.seek(at); requestAnimationFrame(() => done()); }), t);
      return page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: W, height: H } });
    };
    const started = Date.now();
    if (frames) {
      for (const t of frames) await writeFile(join(out, `${name}-${mode}-${t.toFixed(2)}.png`), await shoot(t));
    } else {
      const file = join(out, `${name}-${mode}.mp4`);
      const video = encoder(file);
      const total = Math.round(duration * FPS);
      for (let i = 0; i < total; i++) await video.write(await shoot(i / FPS));
      await video.end();
      console.log(`${file}  ${total} frames, ${(statSync(file).size / 1024).toFixed(0)} KB, ${((Date.now() - started) / 1000).toFixed(0)} s`);
    }
    await page.close();
  }
}
await browser.close();
server.close();
