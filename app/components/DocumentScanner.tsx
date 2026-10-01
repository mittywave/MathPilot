"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { randomClientId } from "../../lib/client-random-id.mjs";

export type ScannerPoint = { x: number; y: number };
export type ScannedHomeworkPage = {
  id: string; original: Blob; processed: Blob; originalUrl: string; processedUrl: string; width: number; height: number;
  corners: ScannerPoint[]; rotation: number; enhance: boolean; fingerprint: string;
  quality: { score: number; warnings: string[]; blocking: boolean };
};

type WorkerResponse = { id: string; ok: boolean; width?: number; height?: number; data?: ArrayBuffer; corners?: ScannerPoint[]; fingerprint?: string; quality?: ScannedHomeworkPage["quality"]; error?: string };
type Props = { pages: ScannedHomeworkPage[]; onChange(pages: ScannedHomeworkPage[]): void; disabled?: boolean; allowPdf?: boolean; defaultEnhance?:boolean; onBusyChange?(busy:boolean):void; onSourceFile?(file:File):void };

function fileToImageData(file: Blob) {
  return createImageBitmap(file).then((bitmap) => {
    const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true }); if (!context) throw new Error("浏览器无法读取图片");
    context.drawImage(bitmap, 0, 0); bitmap.close(); return context.getImageData(0, 0, canvas.width, canvas.height);
  });
}

function imageDataBlob(data: Uint8ClampedArray, width: number, height: number) {
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d"); if (!context) throw new Error("浏览器无法处理图片");
  context.putImageData(new ImageData(data, width, height), 0, 0);
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("图片压缩失败")), "image/jpeg", .9));
}

function revokePage(page: ScannedHomeworkPage) { URL.revokeObjectURL(page.originalUrl); URL.revokeObjectURL(page.processedUrl); }

export default function DocumentScanner({ pages, onChange, disabled = false, allowPdf = false, defaultEnhance = !allowPdf, onBusyChange, onSourceFile }: Props) {
  const workerRef = useRef<Worker | null>(null); const videoRef = useRef<HTMLVideoElement>(null); const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement>(null); const stageRef = useRef<HTMLDivElement>(null); const pagesRef = useRef(pages);
  const [cameraOpen, setCameraOpen] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState(""); const [dragIndex, setDragIndex] = useState<number | null>(null);
  const selected = pages.find((page) => page.id === selectedId) ?? pages[pages.length - 1] ?? null;

  useEffect(() => () => { streamRef.current?.getTracks().forEach((track) => track.stop()); workerRef.current?.terminate(); }, []);
  useEffect(() => { pagesRef.current = pages; }, [pages]);
  useEffect(() => { onBusyChange?.(busy); }, [busy,onBusyChange]);

  function worker() {
    if (!workerRef.current) workerRef.current = new Worker("/document-scanner-worker.js", { type: "classic" });
    return workerRef.current;
  }

  async function process(original: Blob, options?: { corners?: ScannerPoint[]; rotation?: number; enhance?: boolean }) {
    const image = await fileToImageData(original); const id = randomClientId(); const cvWorker = worker();
    const response = await new Promise<WorkerResponse>((resolve, reject) => {
      const failed = () => { cvWorker.removeEventListener("message", listener); reject(new Error("扫描组件加载失败")); };
      const listener = (event: MessageEvent<WorkerResponse>) => { if (event.data.id !== id) return; cvWorker.removeEventListener("message", listener); cvWorker.removeEventListener("error", failed); resolve(event.data); };
      cvWorker.addEventListener("message", listener); cvWorker.addEventListener("error", failed, { once: true });
      cvWorker.postMessage({ id, width: image.width, height: image.height, data: image.data.buffer,
        corners: options?.corners, rotation: options?.rotation ?? 0, enhance: options?.enhance ?? true }, [image.data.buffer]);
    });
    if (!response.ok || !response.data || !response.width || !response.height || !response.corners || !response.quality) throw new Error(response.error || "扫描校准失败");
    const processed = await imageDataBlob(new Uint8ClampedArray(response.data), response.width, response.height);
    return { processed, width: image.width, height: image.height, corners: response.corners, rotation: options?.rotation ?? 0,
      enhance: options?.enhance ?? true, fingerprint: response.fingerprint ?? "", quality: response.quality };
  }

  async function addBlob(blob: Blob) {
    if (pagesRef.current.length >= 100) { setError("每次提交最多 100 页"); return; }
    setBusy(true); setError("");
    try {
      const result = await process(blob,{enhance:defaultEnhance}); const currentPages = pagesRef.current; const duplicate = currentPages.some((page) => page.fingerprint && page.fingerprint === result.fingerprint);
      const page: ScannedHomeworkPage = { id: randomClientId(), original: blob, processed: result.processed,
        originalUrl: URL.createObjectURL(blob), processedUrl: URL.createObjectURL(result.processed), ...result,
        quality: duplicate ? { ...result.quality, blocking: true, warnings: [...result.quality.warnings, "疑似重复页面，请核对"] } : result.quality };
      const next = [...currentPages, page]; pagesRef.current = next; onChange(next); setSelectedId(page.id);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "照片读取失败"); }
    finally { setBusy(false); }
  }

  async function addFiles(files: FileList | null) {
    for(const file of [...(files??[])]) {
      if(file.type.startsWith("image/")) await addBlob(file);
      else if(allowPdf && (file.type==="application/pdf" || /\.pdf$/i.test(file.name))) {
        setBusy(true); setError("");
        try {
          const {renderImportFile}=await import("../../lib/file-import");
          const rendered=await renderImportFile(file,()=>{});
          for(const page of rendered) await addBlob(await (await fetch(page.image)).blob());
          onSourceFile?.(file);
        } catch(caught) {setError(caught instanceof Error?caught.message:"PDF读取失败");}
        finally {setBusy(false);}
      } else setError(allowPdf?"请选择图片或 PDF 文件":"请选择图片文件");
    }
  }

  async function startCamera() {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 2560 } } });
      streamRef.current = stream; setCameraOpen(true); requestAnimationFrame(() => { if (videoRef.current) { videoRef.current.srcObject = stream; void videoRef.current.play(); } });
    } catch { setError("无法打开摄像头，请检查浏览器权限或改用相册上传"); }
  }

  function stopCamera() { streamRef.current?.getTracks().forEach((track) => track.stop()); streamRef.current = null; setCameraOpen(false); }
  async function capture() {
    const video = videoRef.current; if (!video?.videoWidth) return;
    const canvas = document.createElement("canvas"); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0); const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", .94));
    if (blob) await addBlob(blob);
  }

  async function reprocess(page: ScannedHomeworkPage, overrides: Partial<Pick<ScannedHomeworkPage, "corners" | "rotation" | "enhance">> = {}) {
    setBusy(true); setError("");
    try {
      const result = await process(page.original, { corners: overrides.corners ?? page.corners, rotation: overrides.rotation ?? page.rotation, enhance: overrides.enhance ?? page.enhance });
      URL.revokeObjectURL(page.processedUrl); const next = { ...page, ...result, processedUrl: URL.createObjectURL(result.processed) };
      const updated = pagesRef.current.map((candidate) => candidate.id === page.id ? next : candidate); pagesRef.current = updated; onChange(updated);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "页面重新校准失败"); }
    finally { setBusy(false); }
  }

  function cornerPoint(event: ReactPointerEvent<HTMLDivElement>) {
    const rect = stageRef.current?.getBoundingClientRect(); if (!rect) return { x: 0, y: 0 };
    return { x: Math.max(0, Math.min(selected?.width ?? 1, (event.clientX - rect.left) / rect.width * (selected?.width ?? 1))),
      y: Math.max(0, Math.min(selected?.height ?? 1, (event.clientY - rect.top) / rect.height * (selected?.height ?? 1))) };
  }
  function moveCorner(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragIndex == null || !selected) return; event.preventDefault(); const next = [...selected.corners]; next[dragIndex] = cornerPoint(event);
    const updated = pagesRef.current.map((page) => page.id === selected.id ? { ...page, corners: next } : page); pagesRef.current = updated; onChange(updated);
  }

  function remove(page: ScannedHomeworkPage) { revokePage(page); const next = pagesRef.current.filter((candidate) => candidate.id !== page.id); pagesRef.current = next; onChange(next); setSelectedId(next.at(-1)?.id ?? ""); }
  function move(page: ScannedHomeworkPage, offset: number) { const currentPages = pagesRef.current; const index = currentPages.findIndex((candidate) => candidate.id === page.id); const target = index + offset; if (target < 0 || target >= currentPages.length) return; const next = [...currentPages]; [next[index], next[target]] = [next[target], next[index]]; pagesRef.current = next; onChange(next); }

  return <section className="document-scanner" aria-label="作业扫描器">
    <div className="scanner-actions"><button type="button" onClick={startCamera} disabled={disabled || busy}>打开摄像头</button><button type="button" onClick={() => fileRef.current?.click()} disabled={disabled || busy}>{allowPdf ? "选择图片或 PDF" : "从相册选择"}</button><input ref={fileRef} hidden type="file" accept={allowPdf ? "image/*,application/pdf" : "image/*"} capture={allowPdf ? undefined : "environment"} multiple onChange={(event) => { void addFiles(event.target.files); event.target.value = ""; }} /><span>{busy ? "正在检测纸张并校准…" : `已准备 ${pages.length} 页`}</span></div>
    {error && <p className="scanner-error">{error}</p>}
    {cameraOpen && <div className="camera-sheet"><video ref={videoRef} autoPlay playsInline muted /><div><button type="button" onClick={capture} disabled={busy}>拍摄本页</button><button type="button" onClick={stopCamera}>完成拍摄</button></div></div>}
    {!!pages.length && <div className="scanner-workspace">
      <div className="scanner-pages">{pages.map((page, index) => <div role="button" tabIndex={0} key={page.id} className={selected?.id === page.id ? "active" : ""} onClick={() => setSelectedId(page.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelectedId(page.id); }}><img src={page.processedUrl} alt={`答卷第 ${index + 1} 页`} /><b>第 {index + 1} 页</b><small>{page.quality.blocking ? "需要重拍或校准" : page.quality.warnings.length ? "建议检查" : "清晰"}</small><div><button type="button" onClick={(event) => { event.stopPropagation(); move(page, -1); }}>←</button><button type="button" onClick={(event) => { event.stopPropagation(); move(page, 1); }}>→</button><button type="button" onClick={(event) => { event.stopPropagation(); remove(page); }}>删除</button></div></div>)}</div>
      {selected && <div className="scanner-editor"><div ref={stageRef} className="scanner-editor-stage" onPointerMove={moveCorner} onPointerUp={() => { if (dragIndex != null) void reprocess(selected); setDragIndex(null); }} onPointerCancel={() => setDragIndex(null)}><img src={selected.originalUrl} alt="待校准作业原图" /><svg viewBox={`0 0 ${selected.width} ${selected.height}`} preserveAspectRatio="none"><polygon points={selected.corners.map((point) => `${point.x},${point.y}`).join(" ")} />{selected.corners.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r={Math.max(selected.width, selected.height) * .018} onPointerDown={(event) => { event.preventDefault(); setDragIndex(index); (event.currentTarget as SVGCircleElement).setPointerCapture(event.pointerId); }} />)}</svg></div>
        <div className="scanner-editor-tools"><button type="button" onClick={() => reprocess(selected, { rotation: (selected.rotation + 90) % 360 })}>旋转 90°</button><label><input type="checkbox" checked={selected.enhance} onChange={(event) => reprocess(selected, { enhance: event.target.checked })} />黑白增强</label><button type="button" onClick={() => reprocess(selected)}>应用四角校准</button></div>
        {selected.quality.warnings.length ? <ul>{selected.quality.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : <p className="scanner-ok">纸张完整，清晰度检查通过</p>}
      </div>}
    </div>}
  </section>;
}
