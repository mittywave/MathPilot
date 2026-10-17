"use client";

import { useRef, useState } from "react";
import type { HomeworkPage } from "./HomeworkPagePicker";
import { homeworkApi, uploadHomeworkAsset } from "../../lib/homework-api-client";
import { readStudioFiles } from "../../lib/answer-studio-images";
import type { HomeworkCurriculum, HomeworkOutputs, HomeworkSubmission } from "../../lib/types";

export const CURRICULA: Array<[HomeworkCurriculum, string]> = [["school", "校内数学"], ["international", "IGCSE / A Level"]];
const CURRICULUM_KEY = "homework-curriculum";
export const GRADING_STATUSES = ["submitted", "processing"];

/** 上传学生已完成的作业并开始批改；工具箱“作业批改”和学生错题本“新建错题”共用这一条上传路径。 */
export function useHomeworkUpload() {
  // The course a teacher grades is usually the same from one upload to the next.
  const [curriculum, setCurriculum] = useState<HomeworkCurriculum>(() => { try { return localStorage.getItem(CURRICULUM_KEY) === "international" ? "international" : "school"; } catch { return "school"; } });
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [draft, setDraft] = useState<HomeworkSubmission | null>(null);
  // Assignment pages append: resume after the last successful page if an upload fails partway through.
  const savedMaterials = useRef({ question: 0, answer: 0 });

  function chooseCurriculum(value: HomeworkCurriculum) { setCurriculum(value); try { localStorage.setItem(CURRICULUM_KEY, value); } catch { /* storage unavailable */ } }

  async function start(input: { studentId: string; title: string; outputs: HomeworkOutputs; pages: HomeworkPage[]; documents: File[]; references: File[]; originals?: File[]; curriculum?: HomeworkCurriculum }) {
    setBusy(true); setMessage("正在保存学生作业原件…");
    try {
      // Validate and split PDFs before creating a draft, so invalid selections can still be replaced.
      const materials = await Promise.all(([["question", "学校作业原件", input.originals ?? []], ["answer", "参考答案", input.references]] as const).map(async ([role, label, files]) => {
        const pages = (await Promise.all(files.map(async (file) => {
          if (file.type.startsWith("image/")) return [{ blob: file as Blob, fileName: file.name }];
          if (file.type !== "application/pdf" && !/\.pdf$/i.test(file.name)) throw new Error(`${label}请选择图片或 PDF 文件`);
          return Promise.all((await readStudioFiles([file], role, "", () => {})).map(async (page, index) => ({ blob: await (await fetch(page.image)).blob(), fileName: `${file.name}-第${index + 1}页.jpg` })));
        }))).flat();
        if (pages.length > 30) throw new Error(`${label}最多30页`);
        return { role, label, pages };
      }));
      const submission = draft ?? (await homeworkApi.createSubmission(input.studentId, input.title.trim(), input.outputs, input.curriculum ?? curriculum)).submission; setDraft(submission);
      for (const file of input.documents) await uploadHomeworkAsset({ blob: file, fileName: file.name, role: "submission_document", submissionId: submission.id });
      const saved = [];
      for (const [index, page] of input.pages.entries()) {
        const asset = await uploadHomeworkAsset({ blob: page.blob, fileName: `作业第${index + 1}页.jpg`, role: "submission_original", submissionId: submission.id });
        saved.push({ assetId: asset.id }); setMessage(`正在上传作业 ${index + 1}/${input.pages.length} 页…`);
      }
      for (const { role, label, pages } of materials) {
        for (let index = savedMaterials.current[role]; index < pages.length; index++) {
          setMessage(`正在上传${label} ${index + 1}/${pages.length} 页…`);
          await uploadHomeworkAsset({ ...pages[index], role, assignmentId: submission.assignmentId });
          savedMaterials.current[role] = index + 1;
        }
      }
      await homeworkApi.updateSubmission(submission.id, { action: "save-pages", pages: saved });
      const submitted = (await homeworkApi.updateSubmission(submission.id, { action: "submit" })).submission;
      setMessage(""); return submitted;
    } catch (error) { setMessage(error instanceof Error ? error.message : "上传失败，请重试"); setBusy(false); return null; }
  }

  return { curriculum, chooseCurriculum, busy, message, draft, start };
}
