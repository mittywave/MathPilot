"use client";

import { useState } from "react";
import type { HomeworkPage } from "./HomeworkPagePicker";
import { homeworkApi, uploadHomeworkAsset } from "../../lib/homework-api-client";
import { renderImportFile } from "../../lib/file-import";
import type { HomeworkCurriculum, HomeworkOutputs, HomeworkSubmission } from "../../lib/types";

export const CURRICULA: Array<[HomeworkCurriculum, string]> = [["school", "校内数学"], ["international", "IGCSE / A Level"]];
const CURRICULUM_KEY = "homework-curriculum";
export const GRADING_STATUSES = ["submitted", "processing"];

/** 上传学生已完成的作业并开始批改；工具箱“作业批改”和学生错题本“新建错题”共用这一条上传路径。 */
export function useHomeworkUpload() {
  // The course a teacher grades is usually the same from one upload to the next.
  const [curriculum, setCurriculum] = useState<HomeworkCurriculum>(() => { try { return localStorage.getItem(CURRICULUM_KEY) === "international" ? "international" : "school"; } catch { return "school"; } });
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [draft, setDraft] = useState<HomeworkSubmission | null>(null);
  // Reference pages append to the homework, so a retried upload must not send them twice.
  const [referencesSaved, setReferencesSaved] = useState(false);

  function chooseCurriculum(value: HomeworkCurriculum) { setCurriculum(value); try { localStorage.setItem(CURRICULUM_KEY, value); } catch { /* storage unavailable */ } }

  async function start(input: { studentId: string; title: string; outputs: HomeworkOutputs; pages: HomeworkPage[]; documents: File[]; references: File[]; curriculum?: HomeworkCurriculum }) {
    setBusy(true); setMessage("正在保存学生作业原件…");
    try {
      const submission = draft ?? (await homeworkApi.createSubmission(input.studentId, input.title.trim(), input.outputs, input.curriculum ?? curriculum)).submission; setDraft(submission);
      for (const file of input.documents) await uploadHomeworkAsset({ blob: file, fileName: file.name, role: "submission_document", submissionId: submission.id });
      const saved = [];
      for (const [index, page] of input.pages.entries()) {
        const asset = await uploadHomeworkAsset({ blob: page.blob, fileName: `作业第${index + 1}页.jpg`, role: "submission_original", submissionId: submission.id });
        saved.push({ assetId: asset.id }); setMessage(`正在上传作业 ${index + 1}/${input.pages.length} 页…`);
      }
      if (!referencesSaved) {
        const images = (await Promise.all(input.references.map(async (file) => file.type.startsWith("image/") ? [file] : Promise.all((await renderImportFile(file, () => {})).map(async (page) => (await fetch(page.image)).blob()))))).flat();
        if (images.length > 30) throw new Error("参考答案最多30页");
        for (const [index, blob] of images.entries()) await uploadHomeworkAsset({ blob, fileName: `参考答案第${index + 1}页`, role: "answer", assignmentId: submission.assignmentId });
        setReferencesSaved(true);
      }
      await homeworkApi.updateSubmission(submission.id, { action: "save-pages", pages: saved });
      const submitted = (await homeworkApi.updateSubmission(submission.id, { action: "submit" })).submission;
      setMessage(""); return submitted;
    } catch (error) { setMessage(error instanceof Error ? error.message : "上传失败，请重试"); setBusy(false); return null; }
  }

  return { curriculum, chooseCurriculum, busy, message, draft, referencesSaved, start };
}
