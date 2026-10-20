"use client";
import { lazy, Suspense, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SiteHeader } from "../../components/SiteHeader";
import { PaperMoreMenu } from "../../components/PaperMoreMenu";
import { QuestionBody } from "../../components/QuestionBody";
import { MathText } from "../../components/MathText";
import { authorizeDownload, createSmartPaperRecord, fetchLibrary, fetchMe, fetchStudents, fetchTypesetRecords, generateSmartPaper, updateTypesetRecord } from "../../../lib/api-client";
import { categoryDescendants, categoryPath } from "../../../lib/library-tree";
import { focusFeatures, normalizeSmartPaperPlan, planDays, planQuestionIds, questionComplexity, questionFeatures } from "../../../lib/smart-paper-contract";
import type { AuthUser, LibraryData, Question, SmartPaperGroup, SmartPaperPlan, StudentSummary, TypesetSettings } from "../../../lib/types";
import "../tools.css";
import "./smart-paper.css";

// 智能组卷: the teacher says what to practise (optionally for one student); the agent reads the student's archive and picks
// questions from the library by day. The teacher checks the plan — swaps, removes, adds or asks for changes in a sentence —
// then 排版 saves it to the 快速排版 history and opens 快速排版 on it, one day per page.
const Typesetter = lazy(() => import("../typeset/Typesetter"));
const EXAMPLE = "给这位同学出一份 5 天的计算打卡练习，内容是有理数的混合运算，每天大概 10 道题，侧重去括号、乘法分配律和通分约分";
const STAGES: Array<[number, string]> = [[0, "正在读学生档案…"], [3000, "正在理解需求…"], [12000, "正在从题库挑题…"], [45000, "题目较多，还在挑选…"]];

function SmartIcon({ name }: { name: "spark" }) {
  const paths = {
    spark: <><path d="M12 3.5 13.8 9l5.7 1.8-5.7 1.8L12 18.2l-1.8-5.6-5.7-1.8L10.2 9Z" /><path d="M18.5 3.5v3M17 5h3M5.5 17v3M4 18.5h3" /></>,
  } as const;
  return <svg className="tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}

// Keep each question's rationale on its existing focus tag. A native popover escapes the scrolling plan's clipping.
function FocusReason({ focus, reason }: { focus: string; reason: string }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    if (!open || !anchor.current || !tip.current) return;
    const panel = tip.current;
    const bounds = anchor.current.getBoundingClientRect();
    const below = window.innerHeight - bounds.bottom - 16;
    const above = bounds.top - 16;
    panel.style.maxHeight = `${Math.max(80, Math.min(360, Math.max(below, above)))}px`;
    panel.showPopover();
    const size = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(16, Math.min(bounds.left, window.innerWidth - size.width - 16))}px`;
    panel.style.top = `${below >= size.height || below >= above ? bounds.bottom - 1 : Math.max(16, bounds.top - size.height + 1)}px`;
    const dismiss = (event: Event) => {
      if (event.type === "scroll" && panel.contains(event.target as Node)) return;
      setOpen(false);
    };
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      panel.hidePopover();
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [open]);

  if (!reason) return focus ? <em>{focus}</em> : null;
  const label = focus || (reason.startsWith("针对历史错因") ? "针对历史错因" : reason.startsWith("一般巩固") ? "一般巩固" : "选题说明");
  return <div className="smart-paper-reason" ref={anchor} onMouseEnter={() => setOpen(true)}
    onMouseLeave={(event) => { if (!event.currentTarget.contains(document.activeElement)) setOpen(false); }}
    onFocus={() => setOpen(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget) && !event.currentTarget.matches(":hover")) setOpen(false); }}>
    <button type="button" className="smart-paper-focus" aria-label={`${label}，查看选题说明`} aria-describedby={open ? id : undefined} onClick={() => setOpen(true)}>{label}</button>
    {open && <span ref={tip} id={id} className="smart-paper-reason-detail" role="tooltip" popover="auto" onToggle={(event) => { if (event.newState === "closed") setOpen(false); }}>
      {reason.split(/(《[^》]+》第[^：]+题（第\d+次上传）：)/u).map((part, index) => index % 2 ? part : <MathText key={index} text={part} />)}
    </span>}
  </div>;
}

export default function SmartPaper() {
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  const [library, setLibrary] = useState<LibraryData | null>(null);
  const [students, setStudents] = useState<StudentSummary[]>([]);
  const [studentId, setStudentId] = useState("");
  const [fromStudent, setFromStudent] = useState(false);
  const [request, setRequest] = useState("");
  const [instruction, setInstruction] = useState("");
  const [plan, setPlan] = useState<SmartPaperPlan | null>(null);
  const [exclude, setExclude] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [recordId, setRecordId] = useState<string | null>(null);
  const [settings, setSettings] = useState<Partial<TypesetSettings>>({ answers: "none" });
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [typesetting, setTypesetting] = useState(false);
  const [ready, setReady] = useState(false);
  const [draftStatus, setDraftStatus] = useState("");
  const [savedStatus, setSavedStatus] = useState("");

  // Signed in only. ?student= preselects a student (from 学生档案); ?record= reopens a plan from the 快速排版 history.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    void fetchMe().then(async ({ user: me }) => {
      setUser(me);
      if (!me) return;
      const [studentList, data] = await Promise.all([fetchStudents(), fetchLibrary()]);
      setStudents(studentList.students); setLibrary(data);
      const wanted = params.get("student");
      if (wanted && studentList.students.some((student) => student.id === wanted)) { setStudentId(wanted); setFromStudent(true); }
      const recordParam = params.get("record");
      try {
        const key = `smart-paper:${me.id}:${recordParam ? `record:${recordParam}` : wanted ? `student:${wanted}` : "current"}`;
        const draft = JSON.parse(localStorage.getItem(key) || "null");
        if (draft?.version === 1 && typeof draft.request === "string" && typeof draft.title === "string" && typeof draft.instruction === "string" && typeof draft.studentId === "string" && Array.isArray(draft.exclude) && draft.exclude.every((id: unknown) => typeof id === "string")) {
          const restored = normalizeSmartPaperPlan(draft.plan) ?? (draft.plan && Array.isArray(draft.plan.groups) && draft.plan.groups.length <= 14 && draft.plan.groups.every((group: SmartPaperGroup) => typeof group.title === "string" && typeof group.theme === "string" && Array.isArray(group.items) && group.items.length === 0) && Array.isArray(draft.plan.brief?.categoryIds) && Array.isArray(draft.plan.brief?.questionTypes) && Array.isArray(draft.plan.brief?.focus) && Array.isArray(draft.plan.findings) ? draft.plan as SmartPaperPlan : null);
          if (draft.plan && !restored) throw new Error("草稿方案无效");
          setPlan(restored); setTitle(draft.title); setRequest(draft.request); setInstruction(draft.instruction);
          setStudentId(draft.studentId); setExclude(draft.exclude);
          setRecordId(typeof draft.recordId === "string" ? draft.recordId : null);
          setSettings(draft.settings ?? { answers: "none" });
          setReady(true); return;
        }
      } catch { setError("本机草稿无法读取，请从已保存方案恢复。"); }
      if (!recordParam) { setReady(true); return; }
      const record = (await fetchTypesetRecords()).records.find((item) => item.id === recordParam && item.plan);
      if (!record?.plan) { setError("没有找到这份智能组卷记录"); return; }
      setPlan(record.plan); setTitle(record.title); setRecordId(record.id); setSettings(record.settings);
      setRequest(record.plan.request); setStudentId(record.studentId ?? "");
      setReady(true);
    }).catch((reason) => { setUser(current => current ?? null); setError(reason instanceof Error ? reason.message : "读取失败"); });
  }, []);

  // Keep edits on this browser even before the first explicit server save. Hydrate first so empty state never overwrites a draft.
  useEffect(() => {
    if (!ready || !user) return;
    try {
      const draft = JSON.stringify({ version: 1, studentId, request, instruction, plan, exclude, title, recordId, settings });
      localStorage.setItem(`smart-paper:${user.id}:current`, draft);
      if (studentId) localStorage.setItem(`smart-paper:${user.id}:student:${studentId}`, draft);
      if (recordId) localStorage.setItem(`smart-paper:${user.id}:record:${recordId}`, draft);
      queueMicrotask(() => setDraftStatus("已自动保存在本机"));
    } catch { queueMicrotask(() => setDraftStatus("本机自动保存失败，请点击“保存方案”后再退出")); }
  }, [ready, user, studentId, request, instruction, plan, exclude, title, recordId, settings]);

  const byId = useMemo(() => new Map((library?.questions ?? []).map((question) => [question.id, question])), [library]);
  const student = students.find((item) => item.id === studentId) ?? null;
  // Questions in the plan's range the teacher may swap in: not already in the plan and not met by this student.
  const pool = useMemo(() => {
    if (!plan || !library) return [];
    const scope = new Set(plan.brief.categoryIds.flatMap((id) => categoryDescendants(library.categories, id)));
    const taken = new Set([...planQuestionIds(plan), ...exclude]);
    return library.questions.filter((question) => scope.has(question.categoryId) && !taken.has(question.id) && (!plan.brief.questionTypes.length || plan.brief.questionTypes.includes(question.type)));
  }, [plan, library, exclude]);
  const total = plan ? planQuestionIds(plan).length : 0;

  async function ask(body: Parameters<typeof generateSmartPaper>[0]) {
    setError(""); const started = Date.now();
    const stage = () => setBusy([...STAGES].reverse().find(([after]) => Date.now() - started >= after)?.[1] ?? STAGES[0][1]);
    stage(); const timer = setInterval(stage, 1000);
    try {
      const result = await generateSmartPaper(body);
      setPlan(result.plan); setExclude(result.exclude);
      if (!body.current || !title.trim()) setTitle(result.plan.brief.title);
      if (!body.current) { setRecordId(null); setSavedStatus(""); window.history.replaceState(null, "", window.location.pathname); }
      if (body.current) setInstruction("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "智能组卷失败"); }
    finally { clearInterval(timer); setBusy(""); }
  }
  const generate = () => { if (request.trim()) void ask({ request: request.trim(), studentId: studentId || undefined }); };
  const revise = () => { if (plan && instruction.trim()) void ask({ request: plan.request || request.trim(), studentId: studentId || undefined, current: plan, instruction: instruction.trim() }); };

  const editDay = (dayIndex: number, change: (items: SmartPaperGroup["items"]) => SmartPaperGroup["items"]) => setPlan((current) => current && {
    ...current, groups: current.groups.map((group, index) => (index === dayIndex ? { ...group, items: change(group.items) } : group)),
  });
  // The best spare question for a focus and a weight of working: one that shows the focus, closest in 繁度.
  function bestSpare(focus: string, level: number, fallbackFeatures: string[]) {
    const wanted = focusFeatures({ label: focus }).length ? focusFeatures({ label: focus }) : fallbackFeatures;
    const matching = pool.filter((question) => questionFeatures(question.stem).some((feature) => wanted.includes(feature)));
    return (matching.length ? matching : pool).reduce<Question | null>((best, question) => (!best || Math.abs(questionComplexity(question.stem) - level) < Math.abs(questionComplexity(best.stem) - level) ? question : best), null);
  }
  function swap(dayIndex: number, itemIndex: number) {
    const item = plan?.groups[dayIndex].items[itemIndex]; const question = item && byId.get(item.id);
    if (!item || !question) return;
    const spare = bestSpare(item.focus, questionComplexity(question.stem), questionFeatures(question.stem));
    if (!spare) { setError("范围内没有可换的题了"); return; }
    editDay(dayIndex, (items) => items.map((entry, index) => (index === itemIndex ? { id: spare.id, focus: item.focus, reason: studentId ? "一般巩固（老师换题）：侧重点、繁度相近，未核对具体历史错因" : "老师换题：同一侧重点、繁度相近" } : entry)));
  }
  function add(dayIndex: number) {
    const day = plan?.groups[dayIndex]; if (!day) return;
    const questions = day.items.flatMap((item) => byId.get(item.id) ?? []);
    const focus = [...day.items.reduce((counts, item) => counts.set(item.focus, (counts.get(item.focus) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1])[0]?.[0] ?? plan.brief.focus[0]?.label ?? "";
    const level = questions.length ? questions.reduce((sum, question) => sum + questionComplexity(question.stem), 0) / questions.length : 2;
    const spare = bestSpare(focus, level, []);
    if (!spare) { setError("范围内没有可加的题了"); return; }
    editDay(dayIndex, (items) => [...items, { id: spare.id, focus, reason: studentId ? "一般巩固（老师加题）：未核对具体历史错因" : "老师加题" }]);
  }
  const move = (dayIndex: number, itemIndex: number, step: -1 | 1) => editDay(dayIndex, (items) => {
    const next = [...items]; const target = itemIndex + step;
    if (target < 0 || target >= next.length) return items;
    [next[itemIndex], next[target]] = [next[target], next[itemIndex]]; return next;
  });
  const remove = (dayIndex: number, itemIndex: number) => editDay(dayIndex, (items) => items.filter((_, index) => index !== itemIndex));

  // 排版: the plan is saved (a new record, or the one it came from) and 快速排版 opens on it, one day per page.
  async function typeset(openTypesetter = true) {
    if (!plan || !total) return;
    setError(""); setBusy("正在保存方案…");
    try {
      if (openTypesetter) await authorizeDownload(planQuestionIds(plan));
      const current = { ...plan, studentId: studentId || null };
      const name = title.trim() || plan.brief.title || "智能组卷";
      const saved = recordId ? (await updateTypesetRecord(recordId, { title: name, plan: current })).record : (await createSmartPaperRecord({ title: name, plan: current, settings })).record;
      setRecordId(saved.id); setSettings(saved.settings); setTitle(saved.title);
      window.history.replaceState(null, "", `?record=${encodeURIComponent(saved.id)}`);
      setSavedStatus(`上次保存方案：${new Date().toLocaleTimeString()}，可从快速排版历史重新打开；后续修改需再次保存`);
      setTypesetting(openTypesetter);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); }
    finally { setBusy(""); }
  }

  if (typesetting && plan && recordId) {
    const days = planDays(plan, byId);
    return <Suspense fallback={<div className="smart-paper-loading"><i className="smart-paper-spinner" />正在打开快速排版…</div>}>
      <Typesetter basket={{
        questions: days.flatMap((day) => day.questions), title, settings, recordId, studentId: studentId || undefined,
        groups: days.map((day) => ({ title: day.title, size: day.questions.length })),
        origin: { back: "← 智能组卷", name: `智能组卷${student ? ` · ${student.name}` : ""}`, hint: "点击回去调整题目" },
        onClose: (changedTitle, changedSettings) => { if (changedTitle) setTitle(changedTitle); setSettings(changedSettings); setTypesetting(false); },
      }} />
    </Suspense>;
  }

  const paths = plan && library ? plan.brief.categoryIds.map((id) => categoryPath(library.modules, library.categories, id)).filter(Boolean) : [];
  return <><SiteHeader active={fromStudent ? "students" : "tools"} user={user ?? null} loading={user === undefined} trail={fromStudent && student ? [{label:"学生档案",href:"/library?view=wrong-book"},{label:student.name,href:`/library?view=wrong-book&studentId=${encodeURIComponent(student.id)}&tab=homework`},{label:"智能组卷"}] : [{label:"工具箱",href:"/tools"},{label:"智能组卷"}]} /><main className="smart-paper">
    <aside className="smart-paper-panel">
      {user === null ? <p className="smart-paper-note">{error || "请先在题库页登录，再使用智能组卷。"}</p> : <>
        {draftStatus && <p className="smart-paper-note" role="status">{draftStatus}</p>}
        <a className="smart-paper-link" href="/tools/typeset">已保存的方案（在快速排版历史里）</a>
        {savedStatus && <p className="smart-paper-note" role="status">{savedStatus}</p>}
        <fieldset disabled={!ready || Boolean(busy)} style={{ display: "flex", flexDirection: "column", flex: 1, gap: 12, border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <label className="smart-paper-field"><span>学生</span>
          <select value={studentId} disabled={Boolean(busy)} onChange={(event) => setStudentId(event.target.value)}>
            <option value="">不针对某位学生</option>
            {students.map((item) => <option key={item.id} value={item.id}>{item.name}{item.className ? `（${item.className}）` : ""}</option>)}
          </select>
          <small>{student ? "会参考知识点正确率、作答过程和具体错因；每题说明对应的历史错误或一般巩固，并避开做过、布置过的题。" : "选择学生后，会按该学生的档案挑题。"}</small>
        </label>
        <label className="smart-paper-field"><span>要出什么样的练习</span>
          <textarea rows={5} value={request} disabled={Boolean(busy)} placeholder={EXAMPLE} onChange={(event) => setRequest(event.target.value)} />
        </label>
        {plan && <section className="smart-paper-brief" aria-label="方案要点">
          <h3>方案要点</h3>
          <dl>
            <dt>范围</dt><dd>{paths.join("；") || "—"}</dd>
            <dt>题量</dt><dd>{plan.brief.days} 天 × 每天 {plan.brief.perDay} 题{plan.brief.questionTypes.length ? ` · ${plan.brief.questionTypes.join("、")}` : ""}</dd>
            {plan.brief.difficulty && <><dt>难度</dt><dd>{plan.brief.difficulty}</dd></>}
          </dl>
          {!!plan.brief.focus.length && <><h4>侧重点</h4><ul>{plan.brief.focus.map((focus) => <li key={focus.label}><b>{focus.label}</b>{focus.description && <small><MathText text={focus.description} /></small>}</li>)}</ul></>}
          {!!plan.findings.length && <><h4>学生档案要点</h4><ul>{plan.findings.map((finding) => <li key={finding.label}><b>{finding.label}</b>{finding.evidence && <small>{finding.evidence.split(/(《[^》]+》第[^：]+题（第\d+次上传）：)/u).map((part, index) => index % 2 ? part : <MathText key={index} text={part} />)}</small>}</li>)}</ul></>}
          {plan.avoided > 0 && <p className="smart-paper-note">已避开这位学生做过或练过的 {plan.avoided} 道题。</p>}
          <label className="smart-paper-field"><span>用一句话调整</span>
            <textarea rows={2} value={instruction} disabled={Boolean(busy)} placeholder="例如：第 3 天难一点；每天加两道分数题" onChange={(event) => setInstruction(event.target.value)} />
          </label>
          <button type="button" className="secondary" disabled={!instruction.trim() || Boolean(busy)} onClick={revise}>调整方案</button>
        </section>}
        <div className="smart-paper-actions">
        <button type="button" className={`${plan ? "secondary" : "primary-button"} smart-paper-go`} aria-describedby={ready&&!request.trim()&&!busy?"smart-paper-missing":undefined} disabled={!request.trim() || Boolean(busy) || !library} onClick={generate}>
          <SmartIcon name="spark" />{plan ? "重新生成方案" : "生成方案"}
        </button>
        {ready&&!request.trim()&&!busy&&<p className="missing-reason" id="smart-paper-missing">还差：<button type="button" className="text-button" onClick={()=>{const control=document.querySelector<HTMLTextAreaElement>(".smart-paper-panel textarea");control?.focus({preventScroll:true});control?.scrollIntoView({block:"nearest"});}}>说一句要出什么练习</button></p>}
        {busy && <p className="smart-paper-busy"><i className="smart-paper-spinner" />{busy}</p>}
        {error && <p className="smart-paper-note error" role="alert">{error}</p>}
        </div>
        </fieldset>
      </>}
    </aside>

    <fieldset className="smart-paper-plan" aria-label="方案" disabled={Boolean(busy)} style={{ border: 0, margin: 0, minWidth: 0 }}>
      {plan ? <>
        <header className="smart-paper-head">
          <input value={title} aria-label="练习标题" placeholder="练习标题" onChange={(event) => setTitle(event.target.value)} />
          <span>{total} 道题 · 分 {plan.groups.length} 天</span>
          <button type="button" className="secondary" disabled={!total || Boolean(busy)} onClick={() => void typeset(false)}>保存方案</button>
          <button type="button" className="primary-button" disabled={!total || Boolean(busy)} onClick={() => void typeset()}>排版</button>
        </header>
        {plan.groups.map((group, dayIndex) => <section key={dayIndex} className="smart-paper-day">
          <h2><b>{group.title}</b>
            <input value={group.theme} aria-label={`${group.title}主题`} placeholder="主题" onChange={(event) => setPlan((current) => current && { ...current, groups: current.groups.map((item, index) => (index === dayIndex ? { ...item, theme: event.target.value } : item)) })} />
            <small>{group.items.length} 题</small></h2>
          <ol>{group.items.map((item, itemIndex) => {
            const question = byId.get(item.id);
            return <li key={item.id} className="smart-paper-item">
              {question ? <QuestionBody question={question} number={itemIndex + 1} /> : <p className="smart-paper-note">这道题已不在题库中</p>}
              <div className="smart-paper-meta">
                {question?.code && <span>ID {question.code}</span>}
                {question && <span>繁度 {questionComplexity(question.stem)}</span>}
                <FocusReason focus={item.focus} reason={item.reason} />
                <PaperMoreMenu label={`${group.title}第 ${itemIndex + 1} 题的操作`}>
                  <button type="button" onClick={() => swap(dayIndex, itemIndex)}>换一道</button>
                  <button type="button" disabled={itemIndex === 0} onClick={() => move(dayIndex, itemIndex, -1)}>上移</button>
                  <button type="button" disabled={itemIndex === group.items.length - 1} onClick={() => move(dayIndex, itemIndex, 1)}>下移</button>
                  <hr /><button type="button" className="danger-text" onClick={() => remove(dayIndex, itemIndex)}>移除</button>
                </PaperMoreMenu>
              </div>
            </li>;
          })}</ol>
          <button type="button" className="smart-paper-link" onClick={() => add(dayIndex)}>＋ 加一道</button>
        </section>)}
      </> : <p className="smart-paper-empty">说明练习要求，生成的方案会显示在这里。 <button type="button" className="smart-paper-link" onClick={() => setRequest(EXAMPLE)}>用示例填写</button></p>}
    </fieldset>
  </main></>;
}
