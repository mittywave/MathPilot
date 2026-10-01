"use client";

import { useState } from "react";
import type { WrongQuestionEntry } from "../../lib/types";
import { MathText } from "./MathText";

export function WrongQuestionEvidence({ entry }: { entry: WrongQuestionEntry }) {
  const [open, setOpen] = useState(false);
  if (entry.sourceKind !== "assignment") return null;
  return <details className="wrong-grading-evidence" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>作业批改记录</summary>
    <div><b>学生原答</b><p><MathText text={entry.studentAnswer || (entry.feedback?.includes("漏答") ? "空白（未作答）" : "未记录作答文字，请查看原卷")} /></p>
      {entry.feedback && <><b>批改反馈</b><p><MathText text={entry.feedback} /></p></>}
      {open && entry.answerCropAssetId &&
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`/api/homework-assets/${entry.answerCropAssetId}`} alt="学生原卷中的作答" loading="lazy" />}
      <div className="wrong-evidence-links">
        {entry.submissionId && <a href={`/homework/submissions/${entry.submissionId}`}>查看整份批改</a>}
        {entry.question.originalImage && <a href={entry.question.originalImage} target="_blank" rel="noreferrer">查看原卷页面</a>}
      </div>
    </div>
  </details>;
}
