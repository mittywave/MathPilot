import { copyFile, cp, mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/** Serve PDF.js byte-for-byte from public, outside Vite's page/HMR transform. The CMaps let it draw CID-keyed CJK fonts. */
export async function preparePdfWorker(root = process.cwd()) {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve('pdfjs-dist/package.json');
  const { version } = JSON.parse(await readFile(pkg, 'utf8'));
  const folder = join(root, 'public', 'pdfjs', version);
  await mkdir(folder, { recursive: true });
  await copyFile(join(dirname(pkg), 'build/pdf.worker.min.mjs'), join(folder, 'pdf.worker.min.mjs'));
  await cp(join(dirname(pkg), 'cmaps'), join(folder, 'cmaps'), { recursive: true });
  return `/pdfjs/${version}/pdf.worker.min.mjs`;
}
