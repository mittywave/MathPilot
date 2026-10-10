"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { randomClientId } from "../../lib/client-random-id.mjs";

export type HomeworkPage = { id: string; blob: Blob; url: string };
/** empty: content of a drop zone shown while no page is chosen yet; the 新建错题 dialog styles it. */
type Props = { pages: HomeworkPage[]; onChange(pages: HomeworkPage[]): void; disabled?: boolean; limit?: number; onBusyChange?(busy: boolean): void; onSourceFile?(file: File): void; empty?: ReactNode };

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

export default function HomeworkPagePicker({ pages, onChange, disabled = false, limit = 30, onBusyChange, onSourceFile, empty }: Props) {
  const fileRef = useRef<HTMLInputElement>(null); const pagesRef = useRef(pages);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  useEffect(() => { pagesRef.current = pages; }, [pages]);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  function commit(next: HomeworkPage[]) { pagesRef.current = next; onChange(next); }
  async function add(blob: Blob) {
    if (pagesRef.current.length >= limit) throw new Error(`最多 ${limit} 页`);
    commit([...pagesRef.current, await homeworkPage(blob)]);
  }
  async function addFiles(files: File[]) {
    setBusy(true); setError("");
    try {
      for (const file of files) {
        if (file.type.startsWith("image/")) await add(file);
        else if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
          const { renderImportFile } = await import("../../lib/file-import");
          for (const page of await renderImportFile(file, () => {})) await add(await (await fetch(page.image)).blob());
          onSourceFile?.(file);
        } else throw new Error("请选择图片或 PDF 文件");
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : "文件读取失败"); }
    finally { setBusy(false); }
  }
  function remove(page: HomeworkPage) { URL.revokeObjectURL(page.url); commit(pagesRef.current.filter((candidate) => candidate.id !== page.id)); }
  function move(page: HomeworkPage, offset: number) {
    const next = [...pagesRef.current]; const index = next.findIndex((candidate) => candidate.id === page.id); const target = index + offset;
    if (target < 0 || target >= next.length) return; [next[index], next[target]] = [next[target], next[index]]; commit(next);
  }

  return <section className="homework-pages" aria-label="作业页面" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (!disabled && !busy) void addFiles([...event.dataTransfer.files]); }}>
    <input ref={fileRef} hidden type="file" accept="image/*,application/pdf" multiple onChange={(event) => { void addFiles([...(event.target.files ?? [])]); event.target.value = ""; }} />
    {empty && !pages.length ? <button type="button" className="file-dropzone" onClick={() => fileRef.current?.click()} disabled={disabled || busy}>{busy ? <strong>正在读取…</strong> : empty}</button>
      : <div className="homework-pages-actions"><button type="button" onClick={() => fileRef.current?.click()} disabled={disabled || busy}>选择照片或 PDF</button><span>{busy ? "正在读取…" : `已准备 ${pages.length} 页`}</span></div>}
    {error && <p className="homework-pages-error">{error}</p>}
    {!!pages.length && <ol className="homework-pages-list">{pages.map((page, index) => <li key={page.id}>
      <img src={page.url} alt={`作业第 ${index + 1} 页`} /><b>第 {index + 1} 页</b>
      <div><button type="button" onClick={() => move(page, -1)} disabled={disabled || index === 0} aria-label={`第 ${index + 1} 页前移`}>←</button><button type="button" onClick={() => move(page, 1)} disabled={disabled || index === pages.length - 1} aria-label={`第 ${index + 1} 页后移`}>→</button><button type="button" onClick={() => remove(page)} disabled={disabled}>删除</button></div>
    </li>)}</ol>}
  </section>;
}
