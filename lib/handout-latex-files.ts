import JSZip from "jszip";
import handoutClass from "../latex/mitty-handout.cls?raw";
import { buildHandoutLatex, type HandoutLatexInput } from "./handout-latex";
import { questionImages } from "./question-layout";
import { questionImageForPrint } from "./vector-diagram-renderer";
import { noteImageSources } from "./handout-note.mjs";
import { HANDOUT_BANDS } from "./handout-rules.mjs";
import type { Question } from "./types";

// Browser side of the LaTeX export: gathers figures, writes the project, talks to the local typesetter.
const MAIN = "handout.tex";
const ROUTE = "/__mitty/latex/";

export type LatexProject = { main: string; files: Record<string, Uint8Array>; missingFigures: number };
export type LatexStatus = { available: boolean; installed: boolean };

async function figureBytes(source: string) {
  const response = await fetch(source);
  if (!response.ok) throw new Error(`配图读取失败（HTTP ${response.status}）`);
  const blob = await response.blob();
  if (blob.type === "image/png" || blob.type === "image/jpeg") return { bytes: new Uint8Array(await blob.arrayBuffer()), extension: blob.type === "image/png" ? "png" : "jpg" };
  // TeX reads PNG and JPEG only; WebP, GIF and the rest are redrawn as PNG.
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image(); image.src = url; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d"); if (!context) throw new Error("配图转换失败");
    context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("配图转换失败")), "image/png"));
    return { bytes: new Uint8Array(await png.arrayBuffer()), extension: "png" };
  } finally { URL.revokeObjectURL(url); }
}

export async function buildHandoutLatexProject(input: HandoutLatexInput): Promise<LatexProject> {
  const encoder = new TextEncoder();
  const files: Record<string, Uint8Array> = {};
  const names = new Map<string, string>();
  // Word-imported pictures print where the document had them, so the stem's and (with answers) the analysis's are fetched too.
  const questionFigures = (question: Question) => [...questionImages(question), ...Object.values(question.stemDocxAssets ?? {}), ...(input.answers === "none" ? [] : Object.values(question.analysisDocxAssets ?? {}))];
  const figureQuestions = new Map(("questions" in input ? input.questions : input.modules.flatMap((module) => HANDOUT_BANDS.flatMap((band) => module.bands[band])))
    .filter((question) => question.diagramImage).map((question) => [question.diagramImage!, question]));
  const sources = [...new Set("questions" in input ? input.questions.flatMap(questionFigures)
    : input.modules.flatMap((module) => [...noteImageSources(module.note), ...HANDOUT_BANDS.flatMap((band) => module.bands[band].flatMap(questionFigures))]))];
  let missingFigures = 0;
  for (const [index, source] of sources.entries()) {
    try {
      const figure = await figureBytes(await questionImageForPrint(figureQuestions.get(source), source));
      const name = `figures/fig-${index + 1}.${figure.extension}`;
      files[name] = figure.bytes; names.set(source, name);
    } catch { missingFigures += 1; }
  }
  files[MAIN] = encoder.encode(buildHandoutLatex(input, (source) => names.get(source) ?? null));
  files["mitty-handout.cls"] = encoder.encode(handoutClass);
  return { main: MAIN, files, missingFigures };
}

export async function latexSourceZip(project: LatexProject) {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(project.files)) zip.file(name, data);
  return zip.generateAsync({ type: "blob", mimeType: "application/zip" });
}

// Deployed sites have no local typesetter; the route simply does not exist there.
export async function latexCompilerStatus(): Promise<LatexStatus> {
  try {
    const response = await fetch(`${ROUTE}status`);
    if (!response.ok || !response.headers.get("Content-Type")?.includes("application/json")) return { available: false, installed: false };
    const payload = await response.json() as Partial<LatexStatus>;
    return { available: payload.available === true, installed: payload.installed === true };
  } catch { return { available: false, installed: false }; }
}

function base64(data: Uint8Array) {
  let binary = "";
  for (let index = 0; index < data.length; index += 0x8000) binary += String.fromCharCode(...data.subarray(index, index + 0x8000));
  return btoa(binary);
}

// Any LaTeX project (讲义, 批改报告) goes through the same local typesetter.
export async function compileLatexPdf(project: LatexProject): Promise<{ pdf: Blob; issues: number }> {
  const files = Object.fromEntries(Object.entries(project.files).map(([name, data]) => [name, base64(data)]));
  const response = await fetch(`${ROUTE}compile`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ main: project.main, files }) });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(payload.error || `排版失败（${response.status}）`);
  }
  return { pdf: await response.blob(), issues: Number(response.headers.get("X-Latex-Issues") ?? 0) || 0 };
}
