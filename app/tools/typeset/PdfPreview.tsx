"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";

// The typeset PDF drawn page by page, so the reader keeps their place when a new version replaces the old one.
// The class puts a PDF destination q1, q2… at each question number; from them every question gets a clickable area.
type Region = { index: number; top: number; bottom: number };
type Layout = { task: PDFDocumentLoadingTask; doc: PDFDocumentProxy; pages: { width: number; height: number; regions: Region[] }[] };

const MM = 72 / 25.4;
// The destination sits on the number's baseline; the question starts a few millimetres above it.
const ABOVE_BASELINE = 5.5 * MM;
const BOTTOM_MARGIN = 22 * MM;

async function readLayout(pdf: Blob, count: number): Promise<Layout> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = `/pdfjs/${pdfjs.version}/pdf.worker.min.mjs`;
  // The class's sans and math fonts are CID-keyed; PDF.js needs the CMaps to draw them.
  const task = pdfjs.getDocument({ data: new Uint8Array(await pdf.arrayBuffer()), cMapUrl: `/pdfjs/${pdfjs.version}/cmaps/`, cMapPacked: true });
  const doc = await task.promise;
  const pages: Layout["pages"] = [];
  for (let number = 1; number <= doc.numPages; number += 1) {
    const { width, height } = (await doc.getPage(number)).getViewport({ scale: 1 });
    pages.push({ width, height, regions: [] });
  }
  const anchors: { index: number; page: number; top: number }[] = [];
  for (let index = 0; index < count; index += 1) {
    const dest = await doc.getDestination(`q${index + 1}`).catch(() => null);
    if (!dest?.[0] || typeof dest[3] !== "number") continue;
    const page = await doc.getPageIndex(dest[0]);
    anchors.push({ index, page, top: Math.max(0, pages[page].height - dest[3] - ABOVE_BASELINE) });
  }
  anchors.forEach((anchor, position) => {
    const next = anchors[position + 1];
    const { height } = pages[anchor.page];
    const bottom = next?.page === anchor.page ? next.top : height - BOTTOM_MARGIN;
    pages[anchor.page].regions.push({ index: anchor.index, top: anchor.top / height, bottom: Math.max(anchor.top + 1, bottom) / height });
  });
  return { task, doc, pages };
}

function PdfPage({ layout, number, width, children }: { layout: Layout; number: number; width: number; children: ReactNode }) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawn = useRef<{ layout: Layout; width: number } | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = holder.current; if (!element) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "600px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Drawn off screen first, then copied over the previous version, so the page never flashes white.
  useEffect(() => {
    if (!visible || !width || drawn.current?.layout === layout && drawn.current.width === width) return;
    let live = true;
    void (async () => {
      const page = await layout.doc.getPage(number);
      const scale = width / page.getViewport({ scale: 1 }).width * Math.min(2, window.devicePixelRatio || 1);
      const viewport = page.getViewport({ scale });
      const buffer = document.createElement("canvas"); buffer.width = Math.ceil(viewport.width); buffer.height = Math.ceil(viewport.height);
      await page.render({ canvas: buffer, canvasContext: buffer.getContext("2d")!, viewport }).promise;
      const target = canvas.current;
      if (!live || !target) return;
      target.width = buffer.width; target.height = buffer.height;
      target.getContext("2d")!.drawImage(buffer, 0, 0);
      drawn.current = { layout, width };
    })().catch(() => undefined);
    return () => { live = false; };
  }, [layout, number, width, visible]);
  const { width: pageWidth, height } = layout.pages[number - 1];
  return <div ref={holder} className="typeset-page" style={{ width, aspectRatio: `${pageWidth} / ${height}` }}>
    <canvas ref={canvas} aria-label={`第 ${number} 页`} />
    {children}
  </div>;
}

export function PdfPreview({ pdf, count, picked, onPick, label, popover }: {
  pdf: Blob; count: number; picked: number | null; onPick: (index: number | null) => void;
  label: (index: number) => string; popover: ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    let live = true;
    void readLayout(pdf, count).then((next) => { if (live) setLayout(next); else void next.task.destroy(); }).catch(() => undefined);
    return () => { live = false; };
  }, [pdf, count]);
  useEffect(() => () => { void layout?.task.destroy(); }, [layout]);
  useEffect(() => {
    const element = scroller.current; if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(Math.min(900, entry.contentRect.width - 40))));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // A question picked from the list beside the preview is brought into view.
  const shown = useRef<number | null>(null);
  useEffect(() => {
    if (picked === shown.current) return;
    const region = scroller.current?.querySelector(`[data-question="${picked}"]`);
    if (picked !== null && !region) return;
    shown.current = picked;
    region?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [picked, layout]);
  useEffect(() => {
    if (picked === null) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") onPick(null); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [picked, onPick]);
  return <div ref={scroller} className="typeset-pages">
    {layout?.pages.map((page, position) => <PdfPage key={position} layout={layout} number={position + 1} width={width}>
      {page.regions.map((region) => <div key={region.index} data-question={region.index} className={`typeset-region${picked === region.index ? " picked" : ""}`}
        style={{ top: `${region.top * 100}%`, height: `${(region.bottom - region.top) * 100}%` }}>
        <button type="button" className="typeset-region-hit" aria-label={`调整第 ${region.index + 1} 题的留白`} aria-expanded={picked === region.index}
          onClick={() => onPick(picked === region.index ? null : region.index)}><span>{label(region.index)}</span></button>
        {picked === region.index && popover}
      </div>)}
    </PdfPage>)}
  </div>;
}
