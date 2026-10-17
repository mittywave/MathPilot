"use client";

import { type DragEvent, useEffect, useRef, useState } from "react";
import { randomClientId } from "../../lib/client-random-id.mjs";

export type HomeworkPage = { id: string; blob: Blob; url: string };
/** label: what the entry asks for while no page is chosen yet (by default the student's homework). */
type Props = { pages: HomeworkPage[]; onChange(pages: HomeworkPage[]): void; disabled?: boolean; limit?: number; onBusyChange?(busy: boolean): void; onSourceFile?(file: File): void; label?: string };

const MAX_EDGE = 2400;

// Pages are graded as photographed; re-encoding only bounds the size and turns phone formats into JPEG.
async function pageJpeg(source: Blob) {
  const bitmap = await createImageBitmap(source);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas"); canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext("2d"); if (!context) throw new Error("浏览器无法处理图片");
  context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("图片压缩失败")), "image/jpeg", .9));
}

export async function homeworkPage(source: Blob): Promise<HomeworkPage> {
  const blob = await pageJpeg(source); return { id: randomClientId(), blob, url: URL.createObjectURL(blob) };
}

export function releaseHomeworkPages(pages: HomeworkPage[]) { for (const page of pages) URL.revokeObjectURL(page.url); }

const isPageFile = (file: File) => file.type.startsWith("image/") || file.type === "application/pdf" || /\.pdf$/i.test(file.name);

// Pages come in the way questions are entered (录入题目): pasted (⌘V), dragged in, or chosen from a folder by clicking the
// entry. Photos and PDFs may come several at a time; a PDF becomes one page per sheet.
export default function HomeworkPagePicker({ pages, onChange, disabled = false, limit = 30, onBusyChange, onSourceFile, label = "粘贴或拖入学生的作业" }: Props) {
  const fileRef = useRef<HTMLInputElement>(null); const pagesRef = useRef(pages); const entryRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [dragging, setDragging] = useState(false);
  // Files arriving while others are still being read wait their turn, so pages keep the order they came in.
  const queue = useRef(Promise.resolve());
  useEffect(() => { pagesRef.current = pages; }, [pages]);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  function commit(next: HomeworkPage[]) { pagesRef.current = next; onChange(next); }
  async function add(blob: Blob) {
    if (pagesRef.current.length >= limit) throw new Error(`最多 ${limit} 页`);
    commit([...pagesRef.current, await homeworkPage(blob)]);
  }
  async function readFiles(files: File[]) {
    setBusy(true); setError("");
    try {
      for (const file of files) {
        if (file.type.startsWith("image/")) await add(file);
        else if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
          const { readStudioFiles } = await import("../../lib/answer-studio-images");
          for (const page of await readStudioFiles([file], "question", "", () => {})) await add(await (await fetch(page.image)).blob());
          onSourceFile?.(file);
        } else throw new Error("请选择图片或 PDF 文件");
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "文件读取失败"); }
    finally { setBusy(false); }
  }
  const readRef = useRef(readFiles);
  useEffect(() => { readRef.current = readFiles; });
  const addFiles = (files: File[]) => { if (files.length) queue.current = queue.current.then(() => readRef.current(files)); };

  // Paste into the focused upload area; outside one, the first visible picker is the default.
  // One paste must never add a page to both the student's work and the blank question paper.
  useEffect(() => {
    if (disabled) return;
    const paste = (event: ClipboardEvent) => {
      if (event.defaultPrevented) return;
      const files = [...(event.clipboardData?.files ?? [])].filter(isPageFile);
      const entry = entryRef.current;
      if (!files.length || !entry || entry.closest("details:not([open])") || !entry.getClientRects().length) return;
      const target = event.target instanceof Element ? event.target : null;
      const focused = target?.closest(".homework-pages") ?? target?.closest("details[open]")?.querySelector(".homework-pages");
      if (focused && focused !== entry.closest(".homework-pages")) return;
      event.preventDefault();
      queue.current = queue.current.then(() => readRef.current(files));
    };
    document.addEventListener("paste", paste);
    return () => document.removeEventListener("paste", paste);
  }, [disabled]);

  function remove(page: HomeworkPage) { URL.revokeObjectURL(page.url); commit(pagesRef.current.filter((candidate) => candidate.id !== page.id)); }
  function move(page: HomeworkPage, offset: number) {
    const next = [...pagesRef.current]; const index = next.findIndex((candidate) => candidate.id === page.id); const target = index + offset;
    if (target < 0 || target >= next.length) return; [next[index], next[target]] = [next[target], next[index]]; commit(next);
  }
  const carriesFiles = (event: DragEvent) => [...event.dataTransfer.types].includes("Files");
  const full = pages.length >= limit;

  return <section className="homework-pages" aria-label={label}
    onDragOver={(event) => { if (!carriesFiles(event)) return; event.preventDefault(); if (!disabled && !full) setDragging(true); }}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
    onDrop={(event) => { event.preventDefault(); setDragging(false); if (!disabled) addFiles([...event.dataTransfer.files]); }}>
    <input ref={fileRef} hidden type="file" accept="image/*,application/pdf" multiple={limit > 1} onChange={(event) => { addFiles([...(event.target.files ?? [])]); event.target.value = ""; }} />
    <button ref={entryRef} type="button" className={`drop-entry${pages.length ? " compact" : ""}${dragging ? " dragging" : ""}`} disabled={disabled || busy || full} onClick={() => fileRef.current?.click()}>
      <kbd>⌘V</kbd>
      {busy ? <span><b>正在读取…</b><small>PDF 会按页拆开</small></span>
        : full ? <span><b>已放入 {pages.length} 页</b><small>最多 {limit} 页，删掉一页后可以再添加</small></span>
        : pages.length ? <span><b>继续粘贴、拖入，或点击从文件夹添加</b><small>已准备 {pages.length} 页，最多 {limit} 页</small></span>
        : <span><b>{label}</b><small>直接粘贴截图或复制的文件，或把照片、PDF 拖到这里；也可以点击从文件夹选择</small><em>{limit > 1 ? `可以一次放入多张，最多 ${limit} 页` : "只需要一页"}</em></span>}
    </button>
    {error && <p className="homework-pages-error">{error}</p>}
    {!!pages.length && <ol className="homework-pages-list">{pages.map((page, index) => <li key={page.id}>
      <img src={page.url} alt={`作业第 ${index + 1} 页`} /><b>第 {index + 1} 页</b>
      <div><button type="button" onClick={() => move(page, -1)} disabled={disabled || index === 0} aria-label={`第 ${index + 1} 页前移`}>←</button><button type="button" onClick={() => move(page, 1)} disabled={disabled || index === pages.length - 1} aria-label={`第 ${index + 1} 页后移`}>→</button><button type="button" onClick={() => remove(page)} disabled={disabled}>删除</button></div>
    </li>)}</ol>}
  </section>;
}
