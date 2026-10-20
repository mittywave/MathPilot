"use client";

import { useEffect, useRef, useState } from "react";
import { analyzeStudentProfile, fetchStudentProfile } from "../../lib/api-client";
import { MathText } from "./MathText";
import type { KnowledgeTally, StudentAbilityAnalysis, StudentAbilityEvidence, StudentProfileSummary, StudentSummary } from "../../lib/types";

const PERIODS: Array<[number, string]> = [[0, "全部"], [30, "近 30 天"], [90, "近 90 天"]];
const DAY = 86_400_000;
const day = (time: number) => new Date(time).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
const total = (tally: Pick<KnowledgeTally, "correct" | "partial" | "incorrect">) => tally.correct + tally.partial + tally.incorrect;
const rate = (tally: Pick<KnowledgeTally, "correct" | "partial" | "incorrect">) => total(tally) ? tally.correct / total(tally) : 0;

function Tally({ tally }: { tally: Pick<KnowledgeTally, "correct" | "partial" | "incorrect"> }) {
  const all = total(tally);
  return <span className="profile-tally">
    <i className="bar">{(["correct", "partial", "incorrect"] as const).map((key) => tally[key] > 0 && <em key={key} className={key} style={{ width: `${tally[key] / all * 100}%` }} />)}</i>
    <small>{tally.correct}/{all}<b>{Math.round(rate(tally) * 100)}%</b></small>
  </span>;
}

/** 客观: the knowledge points graded homework touched, by domain and topic, weakest first; and each question type. */
function KnowledgePanel({ profile }: { profile: StudentProfileSummary }) {
  const [open, setOpen] = useState<string[]>([]);
  const points = profile.knowledge.filter((item) => item.level === "point");
  const topics = profile.knowledge.filter((item) => item.level === "topic").sort((a, b) => rate(a) - rate(b) || total(b) - total(a));
  const domains = profile.knowledge.filter((item) => item.level === "domain");
  const answered = profile.types.reduce((sum, item) => sum + total(item), 0);
  const correct = profile.types.reduce((sum, item) => sum + item.correct, 0);
  if (!profile.knowledge.length && !answered) return <div className="student-panel-empty"><b>还没有批改结果</b><p>布置的作业批改后会自动计入；直接上传的作业，在批改详情页打开“计入定档”。</p></div>;
  return <>
    <p className="profile-headline"><b>{answered}</b> 道题 · 正确率 <b>{answered ? Math.round(correct / answered * 100) : 0}%</b></p>
    {!!profile.types.length && <ul className="profile-types">{profile.types.map((item) => <li key={item.type}><span>{item.type.replace("单选题", "选择题")}</span><Tally tally={item} /></li>)}</ul>}
    {(domains.length ? domains : [{ key: "", label: "知识点" } as KnowledgeTally]).map((domain) => {
      const inDomain = topics.filter((topic) => !domain.key || topic.parentKey === domain.key);
      if (!inDomain.length) return null;
      return <section key={domain.key || "all"} className="profile-domain">
        <h4>{domain.label}</h4>
        <ul>{inDomain.map((topic) => {
          const children = points.filter((point) => point.parentKey === topic.key).sort((a, b) => rate(a) - rate(b) || total(b) - total(a));
          const expanded = open.includes(topic.key);
          return <li key={topic.key}>
            <button type="button" className="profile-topic" aria-expanded={children.length ? expanded : undefined} disabled={!children.length}
              onClick={() => setOpen((current) => expanded ? current.filter((key) => key !== topic.key) : [...current, topic.key])}>
              <span>{children.length ? <i className="profile-arrow" aria-hidden="true">{expanded ? "▾" : "▸"}</i> : null}{topic.label}</span><Tally tally={topic} />
            </button>
            {expanded && <ul className="profile-points">{children.map((point) => <li key={point.key}><span>{point.label}</span><Tally tally={point} /></li>)}</ul>}
          </li>;
        })}</ul>
      </section>;
    })}
  </>;
}

/** Shared by the live profile and immutable report snapshots; every quote opens its original grading record. */
export function AbilityAnalysis({ analysis, evidence }: { analysis: StudentAbilityAnalysis; evidence: StudentAbilityEvidence[] }) {
  const sources = new Map(evidence.map((item) => [item.id, item]));
  return <div className="ability-analysis">
    {analysis.summary && <p className="ability-overview"><MathText text={analysis.summary} /></p>}
    <ol className="ability-insights">{analysis.insights.map((insight, index) => <li key={index}>
      <h4>{insight.title}<span className={`ability-state ${insight.status}`}>{insight.status === "observed" ? "作答中可见" : "待验证推断"}</span></h4>
      <p><b>题目要求</b><MathText text={insight.demand} /></p>
      <p><b>能力分析</b><MathText text={insight.diagnosis} /></p>
      <details className="ability-evidence"><summary>作答依据 · {insight.evidence.length} 条</summary>
        {insight.evidence.map((ref, i) => { const source = sources.get(ref.id); return source && <div key={`${ref.id}-${i}`}>
          <a href={`/tools/homework/submissions/${encodeURIComponent(source.submissionId)}`} target="_blank" rel="noreferrer">{source.title} · 第 {source.questionNumber} 题 ↗</a>
          <small>{day(source.submittedAt)} · 第 {source.version} 次上传 · {source.verdict === "correct" ? "正确" : source.verdict === "partial" ? "部分正确" : "错误"}</small>
          <blockquote><MathText text={ref.quote} /></blockquote>
          <p><b>原题</b><MathText text={source.stem} /></p>
          {source.options?.map((option, index) => <p key={index}><MathText text={`${String.fromCharCode(65 + index)}. ${option}`} /></p>)}
          <p><b>学生作答</b><MathText text={source.studentAnswer || "未记录作答过程"} /></p>
        </div>; })}
      </details>
      <p className="ability-next"><b>怎样验证与练习</b><MathText text={insight.nextStep} /></p>
    </li>)}</ol>
    {!!analysis.limitations.length && <div className="ability-limits"><b>判断边界</b><ul>{analysis.limitations.map((line, index) => <li key={index}><MathText text={line} /></li>)}</ul></div>}
  </div>;
}

export function StudentProfile({ student }: { student: StudentSummary }) {
  const [period, setPeriod] = useState(0);
  const [retry, setRetry] = useState(0);
  const forceNext = useRef(false);
  const [loaded, setLoaded] = useState<{ key: string; profile: StudentProfileSummary | null; error: string } | null>(null);
  const [reading, setReading] = useState<{ key: string; analysis: StudentAbilityAnalysis | null; evidence: StudentAbilityEvidence[]; notice: string; busy: boolean } | null>(null);
  const key = `${student.id}|${period}|${retry}`;
  useEffect(() => {
    let current = true, running = false, previousEvidence = "", force = forceNext.current;
    forceNext.current = false;
    const controller = new AbortController();
    const since = period ? Date.now() - period * DAY : null;
    async function refresh() {
      if (running || document.visibilityState === "hidden") return;
      running = true;
      try {
        const { profile } = await fetchStudentProfile(student.id, since, controller.signal);
        if (!current) return;
        setLoaded({ key, profile, error: "" });
        const signature = JSON.stringify([profile.abilityEvidence, profile.abilityEvidenceTotal]);
        if (signature === previousEvidence) return;
        previousEvidence = signature;
        if (!profile.abilityEvidence.length) {
          setReading({ key, analysis: null, evidence: [], notice: "这段时间还没有可用于能力分析的已确认作答。作业批改并计入定档后会自动分析。", busy: false });
          return;
        }
        setReading({ key, analysis: null, evidence: profile.abilityEvidence, notice: "", busy: true });
        try {
          const result = await analyzeStudentProfile(student.id, since, controller.signal, force);
          force = false;
          if (current) {
            setLoaded({ key, profile: { ...profile, abilityEvidence: result.abilityEvidence, abilityEvidenceTotal: result.abilityEvidenceTotal }, error: "" });
            previousEvidence = JSON.stringify([result.abilityEvidence, result.abilityEvidenceTotal]);
            setReading({ key, analysis: result.analysis, evidence: result.abilityEvidence, notice: result.notice, busy: false });
          }
        } catch (reason) {
          if (current) setReading({ key, analysis: null, evidence: profile.abilityEvidence, notice: reason instanceof Error ? reason.message : "能力分析失败", busy: false });
        }
      } catch (reason) {
        if (current) setLoaded({ key, profile: null, error: reason instanceof Error ? reason.message : "定档读取失败" });
      } finally { running = false; }
    }
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    const timer = window.setInterval(onFocus, 30_000);
    return () => { current = false; controller.abort(); window.clearInterval(timer); window.removeEventListener("focus", onFocus); document.removeEventListener("visibilitychange", onFocus); };
  }, [key, student.id, period, retry]);
  const profile = loaded?.key === key ? loaded.profile : null;
  const error = loaded?.key === key ? loaded.error : "";
  const ability = reading?.key === key ? reading : null;

  return <section className="student-profile" aria-label={`${student.name}的定档`}>
    <header className="student-panel-head">
      <div className="profile-periods" role="group" aria-label="时间范围">{PERIODS.map(([days, label]) => <button key={days} type="button" className={period === days ? "active" : ""} aria-pressed={period === days} onClick={() => setPeriod(days)}>{label}</button>)}</div>
      <a className="student-panel-action" href={`/knowledge-graph?student=${encodeURIComponent(student.id)}`}>在知识图谱里看</a>
    </header>
    {error ? <div className="student-panel-empty" role="alert">{error}<button type="button" className="secondary" onClick={() => setRetry((value) => value + 1)}>重试</button></div> : !profile ? <div className="wrong-book-loading"><i></i><span>正在读取定档…</span></div> : <div className="profile-columns">
      <article className="profile-card"><h3>知识点<small>来自作业批改</small></h3><KnowledgePanel profile={profile} /></article>
      <article className="profile-card" aria-label="能力分析" aria-busy={ability?.busy ?? true}>
        <header className="ability-heading"><h3>能力分析<small>AI · 依据错题与作答过程</small></h3>
          {!!profile.abilityEvidence.length && <button type="button" className="secondary" disabled={!ability || ability.busy} onClick={() => { forceNext.current = true; setRetry((value) => value + 1); }}>重新分析</button>}
        </header>
        {!!profile.abilityEvidence.length && <p className="ability-coverage">依据 {profile.abilityEvidence.length} 条已确认作答，涉及 {new Set(profile.abilityEvidence.map((item) => item.assignmentQuestionId)).size} 道题{profile.abilityEvidenceTotal > profile.abilityEvidence.length ? `（本时段共 ${profile.abilityEvidenceTotal} 条，取近期错题与正确作答对照）` : ""}。能力维度由具体作答决定。</p>}
        {!ability || ability.busy ? <div className="wrong-book-loading" role="status"><i></i><span>正在联系题目要求与作答过程分析能力…</span></div>
          : ability.analysis ? <AbilityAnalysis analysis={ability.analysis} evidence={ability.evidence} />
          : <p className="ability-notice" role="status">{ability.notice}</p>}
      </article>
    </div>}
  </section>;
}
