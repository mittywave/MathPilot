// Every PDF the app reads (录入, 作业批改, 手写转录, the 快速排版 preview) is opened here.
// scripts/prepare-pdf-worker.mjs serves PDF.js byte for byte from public: a ?url worker would still be transformed in
// development, which injects page-only HMR (window is undefined) into it. PDF.js also loads data on demand: the CMaps
// for Chinese fonts, the standard fonts for text whose font is not embedded, the JPEG 2000 / JBIG2 decoders for
// scanned pages and the ICC profiles. Without them such text and scans render as blank pages.
export async function openPdf(data: Uint8Array) {
  const pdfjs = await import("pdfjs-dist");
  const base = `/pdfjs/${pdfjs.version}/`;
  pdfjs.GlobalWorkerOptions.workerSrc = `${base}pdf.worker.min.mjs`;
  return pdfjs.getDocument({ data, cMapUrl: `${base}cmaps/`, cMapPacked: true, standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/`, iccUrl: `${base}iccs/` });
}
