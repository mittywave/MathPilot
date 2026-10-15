"use client";

/* eslint-disable @next/next/no-html-link-for-pages -- vinext beta currently breaks next/link RSC prefetch on these client-only pages. */

import { useEffect, useState } from "react";
import { useToast } from "../../components/Toast";
import { SiteHeader } from "../../components/SiteHeader";
import { homeworkApi } from "../../../lib/homework-api-client";
import { titleWithoutStudent } from "../../../lib/homework-grading-rules.mjs";
import type { AuthUser, HomeworkSubmission } from "../../../lib/types";

const SUBMISSION_STATUS: Record<string, string> = {
  draft: "待上传", submitted: "已提交", processing: "批改中", review_required: "旧版待复核",
  ready: "旧版待发布", published: "结果已发布", failed: "处理失败",
};

export default function HomeworkTeacherPage() {
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  const [records, setRecords] = useState<HomeworkSubmission[]>([]);
  const [toastNode, show] = useToast();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const me = await homeworkApi.me(); setUser(me.user);
      if (me.user) setRecords((await homeworkApi.submissions()).submissions);
    })().catch((error) => { setUser((current) => current ?? null); show({ text: error instanceof Error ? error.message : "作业记录读取失败", tone: "error" }); }).finally(() => setLoading(false));
  }, [show]);

  return <><SiteHeader active="tools" user={user ?? null} loading={user === undefined}
    trail={[{ label: "工具箱", href: "/tools" }, { label: "作业批改" }]}
    trailActions={user && <a className="primary-button" href="/tools/homework/upload">上传作业并批改</a>} /><main className="homework-shell">
    {toastNode}
    {!loading && !user ? <div className="homework-loading"><p>请先登录教师账号。</p><a href="/">返回题库登录</a></div> : loading ? <p className="homework-records-empty">正在读取作业记录…</p> : records.length ? <div className="completed-records">
      <div className="completed-record-head" aria-hidden="true"><span>状态</span><span>学生</span><span>作业</span><span>结果</span><span>上传时间</span></div>
      {records.map(record => { const summary = record.gradingSummary; const total = summary ? summary.correct + summary.partial + summary.incorrect + summary.unresolved : 0; return <a className="completed-record" key={record.id} href={`/tools/homework/submissions/${record.id}`}>
        <span className={`review-status ${record.status}`}>{SUBMISSION_STATUS[record.status]}</span>
        <span>{record.studentName}</span><b>{titleWithoutStudent(record.assignmentTitle, record.studentName)}</b>
        <span>{summary ? <><span>对 {summary.correct} · 错 {summary.partial + summary.incorrect} · 待处理 {summary.unresolved}</span><span className="completed-record-progress" aria-hidden="true"><i style={{width:`${total ? summary.correct / total * 100 : 0}%`}} /></span>{summary.marks?.percentage != null && <small>得分 {summary.marks.score}/{summary.marks.maxScore}</small>}</> : <small>暂无批改结果</small>}</span>
        <time dateTime={new Date(record.createdAt).toISOString()}>{new Date(record.createdAt).toLocaleString("zh-CN")}</time>
      </a>; })}
    </div> : <p className="homework-records-empty">还没有上传过作业。</p>}
  </main></>;
}
