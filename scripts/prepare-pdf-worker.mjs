import { copyFile, cp, mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** Serve PDF.js byte-for-byte from public, outside Vite's page/HMR transform, with the data it loads on demand (see lib/pdfjs.ts). */
export async function preparePdfWorker(root = process.cwd()) {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('pdfjs-dist/package.json');
  const { version } = JSON.parse(await readFile(pkg, 'utf8'));
  const folder = join(root, 'public', 'pdfjs', version);
  await mkdir(folder, { recursive: true });
  await copyFile(join(dirname(pkg), 'build/pdf.worker.min.mjs'), join(folder, 'pdf.worker.min.mjs'));
  for (const data of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) await cp(join(dirname(pkg), data), join(folder, data), { recursive: true });
  return `/pdfjs/${version}/pdf.worker.min.mjs`;
}
