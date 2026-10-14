"use client";

import { useState } from "react";
import { homeworkQuestionLabel } from "../../lib/homework-grading-rules.mjs";
import type { AssignedHomework, HomeworkDay, HomeworkSubmission } from "../../lib/types";

type Result = AssignedHomework["questions"][number]["result"];
const STATE: Record<string, string> = { correct: "对", partial: "部分对", incorrect: "错", pending: "待处理", missing: "未交" };
function resultState(result: Result) {
  if (!result) return "missing";
  return result.requiresReview || result.verdict === "unreadable" || result.verdict === "review_required" ? "pending" : result.verdict;
}
const plain = (text: string) => text.replace(/\$+/g, "").replace(/\s+/g, " ").trim().slice(0, 60);
const day = (time: number) => new Date(time).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });

/** A date on the teacher's calendar, YYYY-MM-DD: today, or the day a moment fell on. */
export function calendarDay(time = Date.now()) {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
/** The date some days after a YYYY-MM-DD date. */
export function laterDay(date: string, count: number) {
  const [year, month, day] = date.split("-").map(Number);
  return calendarDay(new Date(year, month - 1, day + count, 12).getTime());
}
/** 10/14 for 2026-10-14. */
export const shortDate = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

export type DayState = "done" | "partial" | "today" | "late" | "upcoming";
/** Where a day stands today: all or part of it handed in, due today, past its date with nothing back (没交), or still to come. */
export function dayState(day: HomeworkDay, today: string): DayState {
  if (day.done >= day.size) return "done";
  if (day.done > 0) return "partial";
  return day.date === today ? "today" : day.date < today ? "late" : "upcoming";
}
/** What a day says beside its date: 当天交 · 对 6/10, 10/16 交了 8/10 · 对 5, 今天交, 没交 — nothing while it is still to come. */
export function dayNote(day: HomeworkDay, state: DayState) {
  if (state === "today") return "今天交";
  if (state === "late") return "没交";
  if (state === "upcoming") return "";
  const handed = day.handedInAt == null ? day.date : calendarDay(day.handedInAt);
  const when = handed === day.date ? "当天交" : `${shortDate(handed)} 交`;
  return [state === "partial" ? `${when}了 ${day.done}/${day.size}` : when, state === "partial" ? `对 ${day.correct}` : `对 ${day.correct}/${day.size}`, day.pending ? `待处理 ${day.pending}` : ""].filter(Boolean).join(" · ");
}

/**
 * An assigned homework as a whole: every question of the sheet, day by day, with its latest result over all uploads
 * (未交 until an upload finds it), the date each day is due and when it came back, the uploads so far, and the next
 * step — upload more, or open the waiting upload. 改日期 moves 第 1 天, and every later day with it.
 */
export function AssignedHomeworkSheet({ submission, busy, onFocus, onContinue, onReschedule }: {
  submission: HomeworkSubmission & { assigned: AssignedHomework }; busy: boolean; onFocus: (assignmentQuestionId: string) => void; onContinue: () => void;
  onReschedule: (start: string) => Promise<boolean>;
}) {
  const { assigned } = submission;
  // The first day being picked while 改日期 is open.
  const [moving, setMoving] = useState<string | null>(null);
  const counts = assigned.questions.reduce<Record<string, number>>((all, item) => { const state = resultState(item.result); all[state] = (all[state] ?? 0) + 1; return all; }, {});
  const handedIn = assigned.questions.length - (counts.missing ?? 0);
  const latest = assigned.uploads.at(-1);
  const today = calendarDay();
  const days = assigned.days.map((item, index) => {
    const from = assigned.days.slice(0, index).reduce((sum, entry) => sum + entry.size, 0);
    return { ...item, state: dayState(item, today), items: assigned.questions.slice(from, from + item.size) };
  });
  const first = days[0], last = days[days.length - 1], several = days.length > 1;
  return <section className="assigned-sheet" aria-label="整份作业">
    <header>
      <div><h2>整份作业</h2><p>{assigned.questions.length} 道题 · 已交 {handedIn}{handedIn ? ` · 对 ${counts.correct ?? 0} · 错 ${(counts.incorrect ?? 0) + (counts.partial ?? 0)}` : ""}{counts.pending ? ` · 待处理 ${counts.pending}` : ""}{counts.missing ? ` · 未交 ${counts.missing}` : ""}</p>
        {first && (moving === null ? <p className={`assigned-schedule${several ? "" : ` ${first.state}`}`}>
          <span>{several ? `${shortDate(first.date)} – ${shortDate(last.date)}，每天一份` : `交作业日期 ${shortDate(first.date)}${first.state === "today" ? " · 今天" : first.state === "late" ? " · 没交" : ""}`}</span>
          <button type="button" disabled={busy} onClick={() => setMoving(first.date)}>改日期</button>
        </p> : <form className="assigned-schedule" onSubmit={(event) => { event.preventDefault(); void onReschedule(moving).then((done) => { if (done) setMoving(null); }); }}>
          <label>{several ? "第 1 天" : "交作业日期"}<input type="date" value={moving} required disabled={busy} onChange={(event) => setMoving(event.target.value)} /></label>
          <button type="submit" className="primary" disabled={busy || !moving || moving === first.date}>保存</button>
          <button type="button" disabled={busy} onClick={() => setMoving(null)}>取消</button>
        </form>)}
      </div>
      {latest && latest.status === "draft" && latest.id !== submission.id ? <a className="primary" href={`/tools/homework/submissions/${encodeURIComponent(latest.id)}`}>去上传</a>
        : latest?.status === "published" ? <button className={counts.missing ? "primary" : ""} disabled={busy} onClick={onContinue} title={counts.missing ? "上传学生后来交的部分" : "学生订正或重做后再批改一次"}>{counts.missing ? "继续上传" : "再上传一次"}</button> : null}
    </header>
    {days.map((group, index) => {
      const note = dayNote(group, group.state);
      return <div className={`assigned-day ${group.state}`} key={index}>
        {several && <div className="assigned-day-head"><b title={group.title}>{group.title}</b><small>{shortDate(group.date)}{note ? ` · ${note}` : ""}</small></div>}
        <ol>{group.items.map((item) => {
          const state = resultState(item.result); const here = item.result?.submissionId === submission.id;
          const label = `${homeworkQuestionLabel(item.number)} · ${STATE[state]}`;
          const number = item.number.replace(/^D\d+-/, "");
          return <li key={item.id} className={state} title={`${label}\n${plain(item.question.stem ?? "")}`}>
            {here ? <button type="button" aria-label={label} onClick={() => onFocus(item.id)}>{number}</button>
              : item.result ? <a aria-label={`${label}（在第 ${assigned.uploads.find((upload) => upload.id === item.result!.submissionId)?.version ?? "?"} 次上传里）`} href={`/tools/homework/submissions/${encodeURIComponent(item.result.submissionId)}`}>{number}</a>
              : <span aria-label={label}>{number}</span>}
          </li>;
        })}</ol>
      </div>;
    })}
    {assigned.uploads.length > 1 && <nav className="assigned-uploads" aria-label="上传记录">{assigned.uploads.map((upload) => upload.id === submission.id
      ? <b key={upload.id}>第 {upload.version} 次上传 · {day(upload.submittedAt ?? upload.createdAt)}{upload.pageCount ? ` · ${upload.pageCount} 页` : ""}</b>
      : <a key={upload.id} href={`/tools/homework/submissions/${encodeURIComponent(upload.id)}`}>第 {upload.version} 次上传 · {day(upload.submittedAt ?? upload.createdAt)}{upload.pageCount ? ` · ${upload.pageCount} 页` : upload.status === "draft" ? " · 待上传" : ""}</a>)}</nav>}
  </section>;
}
