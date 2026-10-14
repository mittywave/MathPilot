"use client";

/* eslint-disable @next/next/no-html-link-for-pages -- vinext beta currently breaks next/link RSC prefetch on these client-only pages. */

import { useEffect, useState } from "react";
import { SiteHeader } from "../../components/SiteHeader";
import { homeworkApi } from "../../../lib/homework-api-client";
import type { AuthUser, HomeworkSubmission } from "../../../lib/types";

const SUBMISSION_STATUS: Record<string, string> = {
  draft: "待上传", submitted: "已提交", processing: "批改中", review_required: "旧版待复核",
  ready: "旧版待发布", published: "结果已发布", failed: "处理失败",
};

export default function HomeworkTeacherPage() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [records, setRecords] = useState<HomeworkSubmission[]>([]);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const me = await homeworkApi.me(); setUser(me.user);
      if (me.user) setRecords((await homeworkApi.submissions()).submissions);
    })().catch((error) => setNotice(error instanceof Error ? error.message : "作业记录读取失败")).finally(() => setLoading(false));
  }, []);

  if (!loading && !user) return <><SiteHeader active="tools" user={null} /><main className="homework-loading"><h1>请先登录教师账号</h1><a href="/">返回题库登录</a></main></>;

  return <><SiteHeader active="tools" user={user} loading={loading} /><main className="homework-shell">
    {notice && <div className="homework-notice" role="status">{notice}<button onClick={() => setNotice("")} aria-label="关闭提示">×</button></div>}
    <section className="completed-homework-entry"><div><h1>作业批改</h1><p>上传学生已完成的作业，Agent 自动批改；可选择写入错题本、生成错题报告或整合到学生画像。</p></div><a className="primary" href="/tools/homework/upload">上传作业并批改</a></section>
    {loading ? <p className="homework-records-empty">正在读取作业记录…</p> : records.length ? <details className="homework-panel completed-records" open><summary>已上传作业记录（{records.length}）</summary><div>{records.map(record=><a className="completed-record" key={record.id} href={`/tools/homework/submissions/${record.id}`}><span><b>{record.studentName} · {record.assignmentTitle}</b><small>{new Date(record.createdAt).toLocaleString("zh-CN")}</small></span><span>{SUBMISSION_STATUS[record.status]}{record.gradingSummary && <small>{record.gradingSummary.marks?.percentage != null && `得分 ${record.gradingSummary.marks.score}/${record.gradingSummary.marks.maxScore} · `}对 {record.gradingSummary.correct} · 错 {record.gradingSummary.partial + record.gradingSummary.incorrect} · 待处理 {record.gradingSummary.unresolved}</small>}</span></a>)}</div></details> : <p className="homework-records-empty">还没有上传过作业。</p>}
  </main></>;
}
