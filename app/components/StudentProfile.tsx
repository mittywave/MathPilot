"use client";

import { useEffect, useState } from "react";
import { PaperMoreMenu } from "./PaperMoreMenu";
import { createObservation, deleteObservation, fetchStudentProfile, updateObservation } from "../../lib/api-client";
import { ABILITY_DIMENSIONS, abilityNoteLabel, abilityStateLabel } from "../../lib/student-profile-contract";
import type { KnowledgeTally, StudentObservation, StudentProfileSummary, StudentSummary } from "../../lib/types";

const PERIODS: Array<[number, string]> = [[0, "全部"], [30, "近 30 天"], [90, "近 90 天"]];
const DAY = 86_400_000;
const day = (time: number) => new Date(time).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
// <input type="date"> speaks local dates; a lesson is stored at local noon so it never slips a day.
const dateValue = (time: number) => { const date = new Date(time); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };
const dateTime = (value: string) => { const [year, month, date] = value.split("-").map(Number); return new Date(year, month - 1, date, 12).getTime(); };
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
  if (!profile.knowledge.length && !answered) return <div className="student-panel-empty"><b>还没有批改结果</b><p>布置的作业批改后会自动累计到这里；直接上传批改的作业，上传时勾选“整合到学生画像”才计入。</p></div>;
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

/** 主观 at a glance: each of the five abilities with how often the teacher called it a strength or a weakness. */
function AbilitySummary({ observations }: { observations: StudentObservation[] }) {
  return <ul className="ability-summary">{ABILITY_DIMENSIONS.map((dimension) => {
    const notes = observations.flatMap((item) => item.abilities.filter((note) => note.key === dimension.key).map((note) => ({ ...note, at: item.observedAt })));
    const weak = notes.filter((note) => note.polarity === "weakness").length, strong = notes.length - weak;
    const tone = !notes.length ? "none" : weak > strong ? "weakness" : strong > weak ? "strength" : "mixed";
    const latest = notes[0];
    return <li key={dimension.key} className={tone} title={dimension.hint}>
      <b>{dimension.label}</b>
      <span className="ability-state">{tone === "none" ? "没提到" : tone === "mixed" ? "有起伏" : abilityStateLabel(dimension.key, tone)}</span>
      <small>{tone === "mixed" ? `短板 ${weak} · 优势 ${strong}` : notes.length ? `${notes.length} 次` : ""}</small>
      {latest && <p className="ability-quote"><q>{latest.evidence}</q><em>{day(latest.at)}</em></p>}
    </li>;
  })}</ul>;
}

function ObservationItem({ studentId, observation, onChange, onRemove }: { studentId: string; observation: StudentObservation; onChange: (next: StudentObservation, notice: string) => void; onRemove: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(observation.text);
  const [busy, setBusy] = useState(false);
  async function change(update: Parameters<typeof updateObservation>[2]) {
    setBusy(true);
    try { const result = await updateObservation(studentId, observation.id, update); onChange(result.observation, result.notice); setEditing(false); }
    catch (reason) { onChange(observation, reason instanceof Error ? reason.message : "保存失败"); }
    finally { setBusy(false); }
  }
  return <li className="observation" aria-busy={busy}>
    <header><b>{day(observation.observedAt)}</b>{busy && <small>正在读取…</small>}
      <PaperMoreMenu label="这条反馈的操作">
        <button type="button" onClick={() => { setDraft(observation.text); setEditing(true); }}>修改</button>
        <button type="button" onClick={() => void change({ extract: true })}>重新提取</button>
        <button type="button" className="danger-text" onClick={() => { if (window.confirm("删除这条课后反馈？")) onRemove(); }}>删除</button>
      </PaperMoreMenu>
    </header>
    {editing ? <div className="observation-edit">
      <textarea rows={3} value={draft} disabled={busy} onChange={(event) => setDraft(event.target.value)} aria-label="修改反馈原话" />
      <div><button type="button" className="secondary" disabled={busy} onClick={() => setEditing(false)}>取消</button><button type="button" className="primary-button" disabled={busy || !draft.trim()} onClick={() => void change({ text: draft })}>保存并重新提取</button></div>
    </div> : <p>{observation.text}</p>}
    {observation.extractedAt == null ? <p className="observation-pending">还没读出关键词。<button type="button" disabled={busy} onClick={() => void change({ extract: true })}>重新提取</button></p>
      : <div className="observation-tags">
        {observation.abilities.map((note) => <span key={`${note.key}-${note.polarity}`} className={`ability-chip ${note.polarity}`} title={`“${note.evidence}”`}>
          {abilityNoteLabel(note)}
          <button type="button" aria-label={`去掉“${abilityNoteLabel(note)}”`} disabled={busy} onClick={() => void change({ abilities: observation.abilities.filter((item) => item !== note) })}>×</button>
        </span>)}
        {observation.keywords.map((keyword) => <span key={keyword} className="keyword-chip">{keyword}
          <button type="button" aria-label={`去掉关键词“${keyword}”`} disabled={busy} onClick={() => void change({ keywords: observation.keywords.filter((item) => item !== keyword) })}>×</button>
        </span>)}
        {!observation.abilities.length && !observation.keywords.length && <small>这段话里没有读出能力判断。</small>}
      </div>}
  </li>;
}

/** 学生档案 · 定档: what graded homework shows (客观) beside what the teacher said after each lesson (主观). */
export function StudentProfile({ student }: { student: StudentSummary }) {
  const [period, setPeriod] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; profile: StudentProfileSummary | null; error: string } | null>(null);
  const [words, setWords] = useState("");
  const [today] = useState(() => dateValue(Date.now()));
  const [when, setWhen] = useState(today);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const key = `${student.id}|${period}`;
  useEffect(() => {
    let current = true;
    fetchStudentProfile(student.id, period ? Date.now() - period * DAY : null)
      .then((result) => { if (current) setLoaded({ key, profile: result.profile, error: "" }); })
      .catch((reason) => { if (current) setLoaded({ key, profile: null, error: reason instanceof Error ? reason.message : "定档读取失败" }); });
    return () => { current = false; };
  }, [key, student.id, period]);
  const profile = loaded?.key === key ? loaded.profile : null;
  const error = loaded?.key === key ? loaded.error : "";
  const setObservations = (change: (items: StudentObservation[]) => StudentObservation[]) => setLoaded((current) => current?.profile ? { ...current, profile: { ...current.profile, observations: change(current.profile.observations) } } : current);

  async function save() {
    if (!words.trim() || saving) return;
    setSaving(true); setNotice("");
    try {
      const result = await createObservation(student.id, { text: words.trim(), observedAt: dateTime(when) });
      setObservations((items) => [result.observation, ...items].sort((a, b) => b.observedAt - a.observedAt || b.createdAt - a.createdAt));
      setWords(""); setNotice(result.notice ? `原话已保存，关键词没读出来：${result.notice}` : "");
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : "保存失败"); }
    finally { setSaving(false); }
  }

  return <section className="student-profile" aria-label={`${student.name}的定档`}>
    <header className="student-panel-head">
      <div className="profile-periods" role="group" aria-label="时间范围">{PERIODS.map(([days, label]) => <button key={days} type="button" className={period === days ? "active" : ""} aria-pressed={period === days} onClick={() => setPeriod(days)}>{label}</button>)}</div>
      <a className="student-panel-action" href={`/knowledge-graph?student=${encodeURIComponent(student.id)}`} target="_blank" rel="noreferrer">在知识图谱里看</a>
    </header>
    {error ? <p className="student-panel-empty" role="alert">{error}</p> : !profile ? <div className="wrong-book-loading"><i></i><span>正在读取定档…</span></div> : <div className="profile-columns">
      <article className="profile-card"><h3>知识点<small>客观 · 来自作业批改</small></h3><KnowledgePanel profile={profile} /></article>
      <article className="profile-card"><h3>能力<small>主观 · 来自课后反馈</small></h3>
        <AbilitySummary observations={profile.observations} />
        <div className="observation-compose">
          <label className="observation-date">上课日期<input type="date" value={when} max={today} onChange={(event) => setWhen(event.target.value || today)} /></label>
          <textarea rows={4} value={words} disabled={saving} onChange={(event) => setWords(event.target.value)} aria-label="课后反馈"
            placeholder="说说这节课的情况，例如：今天讲配方法，计算还是粗心，符号老出错；不过逆向思维不错，能从结论倒推条件。" />
          <div><small>可以直接说：Mac 按两下 fn 键听写，Windows 按 Win + H。AI 会把原话对到五项能力，并标出优势或短板。</small>
            <button type="button" className="primary-button" disabled={saving || !words.trim()} onClick={() => void save()}>{saving ? "正在读取…" : "保存"}</button></div>
          {notice && <p className="observation-notice" role="status">{notice}</p>}
        </div>
        {profile.observations.length ? <ol className="observation-list">{profile.observations.map((observation) => <ObservationItem key={observation.id} studentId={student.id} observation={observation}
          onChange={(next, message) => { setObservations((items) => items.map((item) => item.id === next.id ? next : item)); setNotice(message ? `关键词没读出来：${message}` : ""); }}
          onRemove={() => void deleteObservation(student.id, observation.id).then(() => setObservations((items) => items.filter((item) => item.id !== observation.id))).catch((reason) => setNotice(reason instanceof Error ? reason.message : "删除失败"))} />)}</ol>
          : <p className="observation-empty">还没有课后反馈。</p>}
      </article>
    </div>}
  </section>;
}
