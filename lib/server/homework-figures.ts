import jpeg from "jpeg-js";
import type { AuthUser } from "../types";
import type { CompletedQuestion } from "../completed-homework-contract";
import { boundedMap } from "../completed-homework-coverage";
import { cutHomeworkFigure, figureLocatorPrompt, figureLocatorSchema, normalizeFigureLocator, withLocatedFigures, type HomeworkFigure } from "../homework-figures";
import { homeworkAssetBytes, storeHomeworkAsset } from "./homework-assets";
import { callHomeworkModel, parseHomeworkModelText } from "./homework-model";
import { homeworkDb } from "./homework";

type FigureOwner = { ownerUserId: string; submissionId: string; assignmentId: string };
type PageImage = { dataUrl: string; pixels: { data: Uint8ClampedArray; width: number; height: number } | null };

const LOCATOR_CONCURRENCY = 3;

function responseError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { "Content-Type": "application/json" } });
}

// One read serves both the model (data URL) and the cutter (decoded pixels).
async function readPage(assetId: string): Promise<PageImage> {
  const asset = await homeworkAssetBytes(assetId);
  if (!asset) throw new Error("作业图片不存在");
  const bytes = new Uint8Array(asset.bytes); let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  let pixels: PageImage["pixels"] = null;
  if (asset.contentType === "image/jpeg") {
    // Calibrated pages are at most 2400px long; the cap keeps a stray oversized page within Worker memory.
    const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 12 });
    pixels = { data: new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength), width: decoded.width, height: decoded.height };
  }
  return { dataUrl: `data:${asset.contentType};base64,${btoa(binary)}`, pixels };
}

async function storeFigure(page: PageImage, figure: HomeworkFigure, questionNumber: string, owner: FigureOwner): Promise<HomeworkFigure | null> {
  if (figure.assetId) return figure;
  if (!page.pixels) return null;
  const cut = cutHomeworkFigure(page.pixels, figure.bbox);
  if (!cut) return null;
  const encoded = jpeg.encode({ data: cut.data, width: cut.width, height: cut.height }, 90).data;
  const asset = await storeHomeworkAsset({
    ownerUserId: owner.ownerUserId, bytes: encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer,
    // Like answer crops, figures are cut from the student's page by the pipeline and can never be uploaded.
    contentType: "image/jpeg", originalName: `第${questionNumber}题配图.jpg`, role: "answer_crop",
    submissionId: owner.submissionId, assignmentId: owner.assignmentId,
  });
  return { ...figure, assetId: asset.id, width: cut.width, height: cut.height };
}

/**
 * Cuts the figures one page extraction located and stores each as an image. A figure without ink is dropped;
 * if the page cannot be cut at all, its figures stay unlocated so they can be filled in later.
 */
export async function storeExtractedFigures(pageNumber: number, processedAssetId: string, questions: CompletedQuestion[], owner: FigureOwner) {
  if (!questions.some((question) => question.figures?.some((figure) => figure.page === pageNumber && !figure.assetId))) return questions;
  try {
    const page = await readPage(processedAssetId);
    if (!page.pixels) throw new Error("校准图无法解码");
    return await Promise.all(questions.map(async (question) => {
      if (!question.figures) return question;
      const figures = await Promise.all(question.figures.map((figure) => figure.page === pageNumber ? storeFigure(page, figure, question.question_number, owner) : figure));
      return { ...question, figures: figures.filter((figure): figure is HomeworkFigure => Boolean(figure)) };
    }));
  } catch (error) {
    console.error("作业配图裁剪失败", error);
    return questions.map((question) => question.figures?.some((figure) => figure.page === pageNumber) ? { ...question, figures: undefined } : question);
  }
}

type PendingRow = { id: string; question_number: string; stem: string; options_json: string; input_evidence_json: string };

/**
 * Homework read before figures were located: each page is shown to the model with its transcribed questions,
 * the figures are cut, and any figure description the old transcription wrote into a stem is moved out of it.
 */
export async function attachMissingFigures(submissionId: string, user: AuthUser) {
  const db = homeworkDb();
  const row = await db.prepare(`SELECT s.id,s.status,s.assignment_id,a.owner_user_id,a.input_mode FROM homework_submissions s JOIN homework_assignments a ON a.id=s.assignment_id
    WHERE s.id=? AND a.owner_user_id=?`).bind(submissionId, user.id).first<{ id: string; status: string; assignment_id: string; owner_user_id: string; input_mode: string }>();
  if (!row) throw responseError("提交记录不存在", 404);
  if (row.input_mode !== "completed_homework") throw responseError("此操作仅用于直接上传的作业", 400);
  if (!["published", "ready"].includes(row.status)) throw responseError("请等待本次批改完成", 409);
  const owner = { ownerUserId: row.owner_user_id, submissionId, assignmentId: row.assignment_id };
  const pageRows = await db.prepare("SELECT page_order,processed_asset_id FROM submission_pages WHERE submission_id=? ORDER BY page_order").bind(submissionId).all<{ page_order: number; processed_asset_id: string }>();
  const pages = pageRows.results as Array<{ page_order: number; processed_asset_id: string }>;
  const rows = (await db.prepare("SELECT id,question_number,stem,options_json,input_evidence_json FROM assignment_questions WHERE assignment_id=? ORDER BY sort_order").bind(row.assignment_id).all<PendingRow>()).results as PendingRow[];
  const pending = rows.map((question) => ({ row: question, evidence: JSON.parse(question.input_evidence_json || "{}") as CompletedQuestion }))
    .filter(({ evidence }) => evidence.figures === undefined && Array.isArray(evidence.page_numbers) && evidence.page_numbers.every((page) => page >= 1 && page <= pages.length));
  const byPage = new Map<number, typeof pending>();
  for (const question of pending) for (const page of question.evidence.page_numbers) byPage.set(page, [...(byPage.get(page) ?? []), question]);

  const located = new Map<string, Map<number, { figures: HomeworkFigure[]; addedTexts: string[] }>>();
  let updated = 0;
  // A question is written once every page it spans has been searched, so an interrupted run loses nothing finished.
  async function finish(question: (typeof pending)[number]) {
    const saved = withLocatedFigures({ stem: question.row.stem, options: JSON.parse(question.row.options_json || "[]") as string[] }, question.evidence, [...located.get(question.row.id)!.values()]);
    await db.prepare("UPDATE assignment_questions SET stem=?,options_json=?,input_evidence_json=?,updated_at=? WHERE id=? AND assignment_id=?")
      .bind(saved.stem, JSON.stringify(saved.options), JSON.stringify(saved.evidence), Date.now(), question.row.id, owner.assignmentId).run();
    updated += 1;
  }
  await boundedMap([...byPage.entries()].sort((a, b) => a[0] - b[0]), LOCATOR_CONCURRENCY, async ([pageNumber, questions]) => {
    try {
      const page = await readPage(pages[pageNumber - 1].processed_asset_id);
      const result = await callHomeworkModel({ images: [page.dataUrl], prompt: figureLocatorPrompt(pageNumber, questions.map(({ row: question }) => ({
        questionNumber: question.question_number, stem: question.stem, options: JSON.parse(question.options_json || "[]") as string[],
      }))), schema: figureLocatorSchema, schemaName: "completed_homework_figures" });
      if (!result.text) throw new Error(result.error || "配图定位没有返回结果");
      const answers = normalizeFigureLocator(parseHomeworkModelText(result.text), pageNumber, questions.map(({ row: question }) => question.question_number));
      for (const [index, answer] of answers.entries()) {
        const question = questions[index];
        const figures = (await Promise.all(answer.figures.map((figure) => storeFigure(page, figure, answer.questionNumber, owner)))).filter((figure): figure is HomeworkFigure => Boolean(figure));
        const parts = located.get(question.row.id) ?? new Map(); parts.set(pageNumber, { figures, addedTexts: answer.addedTexts }); located.set(question.row.id, parts);
        if (question.evidence.page_numbers.every((page) => parts.has(page))) await finish(question);
      }
    // A failed page leaves its questions pending; running the action again retries only those.
    } catch (error) { console.error("作业配图定位失败", pageNumber, error); }
  });
  if (updated && row.status === "published") {
    const { readTeacherSubmission } = await import("./homework");
    await (await import("./homework-outputs")).applySubmissionOutputs(await readTeacherSubmission(submissionId, user), user);
  }
}
