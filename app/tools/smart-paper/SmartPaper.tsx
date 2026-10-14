"use client";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { PaperMoreMenu } from "../../components/PaperMoreMenu";
import { QuestionBody } from "../../components/QuestionBody";
import { authorizeDownload, createSmartPaperRecord, fetchLibrary, fetchMe, fetchStudents, fetchTypesetRecords, generateSmartPaper, updateTypesetRecord } from "../../../lib/api-client";
import { categoryDescendants, categoryPath } from "../../../lib/library-tree";
import { focusFeatures, planDays, planQuestionIds, questionComplexity, questionFeatures } from "../../../lib/smart-paper-contract";
import type { AuthUser, LibraryData, Question, SmartPaperGroup, SmartPaperPlan, StudentSummary, TypesetSettings } from "../../../lib/types";
import "../tools.css";
import "./smart-paper.css";

// 智能组卷: the teacher says what to practise (optionally for one student); the agent reads the student's archive and picks
// questions from the library by day. The teacher checks the plan — swaps, removes, adds or asks for changes in a sentence —
// then 排版 saves it to the 快速排版 history and opens 快速排版 on it, one day per page.
const Typesetter = lazy(() => import("../typeset/Typesetter"));
const EXAMPLE = "给这位同学出一份 5 天的计算打卡练习，内容是有理数的混合运算，每天大概 10 道题，侧重去括号、乘法分配律和通分约分";
const STAGES: Array<[number, string]> = [[0, "正在读学生档案…"], [3000, "正在理解需求…"], [12000, "正在从题库挑题…"], [45000, "题目较多，还在挑选…"]];

function SmartIcon({ name }: { name: "back" | "spark" }) {
  const paths = {
    back: <path d="m10 5-7 7 7 7M3 12h18" />,
    spark: <><path d="M12 3.5 13.8 9l5.7 1.8-5.7 1.8L12 18.2l-1.8-5.6-5.7-1.8L10.2 9Z" /><path d="M18.5 3.5v3M17 5h3M5.5 17v3M4 18.5h3" /></>,
  } as const;
  return <svg className="tool-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}

export default function SmartPaper() {
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  const [library, setLibrary] = useState<LibraryData | null>(null);
  const [students, setStudents] = useState<StudentSummary[]>([]);
  const [studentId, setStudentId] = useState("");
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

  // Signed in only. ?student= preselects a student (from 学生档案); ?record= reopens a plan from the 快速排版 history.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    void fetchMe().then(async ({ user: me }) => {
      setUser(me);
      if (!me) return;
      const [studentList, data] = await Promise.all([fetchStudents(), fetchLibrary()]);
      setStudents(studentList.students); setLibrary(data);
      const wanted = params.get("student");
      if (wanted && studentList.students.some((student) => student.id === wanted)) setStudentId(wanted);
      const recordParam = params.get("record");
      if (!recordParam) return;
      const record = (await fetchTypesetRecords()).records.find((item) => item.id === recordParam && item.plan);
      if (!record?.plan) { setError("没有找到这份智能组卷记录"); return; }
      setPlan(record.plan); setTitle(record.title); setRecordId(record.id); setSettings(record.settings);
      setRequest(record.plan.request); setStudentId(record.studentId ?? "");
    }).catch((reason) => { setUser(null); setError(reason instanceof Error ? reason.message : "读取失败"); });
  }, []);

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
    editDay(dayIndex, (items) => items.map((entry, index) => (index === itemIndex ? { id: spare.id, focus: item.focus, reason: "老师换题：同一侧重点、繁度相近" } : entry)));
  }
  function add(dayIndex: number) {
    const day = plan?.groups[dayIndex]; if (!day) return;
    const questions = day.items.flatMap((item) => byId.get(item.id) ?? []);
    const focus = [...day.items.reduce((counts, item) => counts.set(item.focus, (counts.get(item.focus) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1])[0]?.[0] ?? plan.brief.focus[0]?.label ?? "";
    const level = questions.length ? questions.reduce((sum, question) => sum + questionComplexity(question.stem), 0) / questions.length : 2;
    const spare = bestSpare(focus, level, []);
    if (!spare) { setError("范围内没有可加的题了"); return; }
    editDay(dayIndex, (items) => [...items, { id: spare.id, focus, reason: "老师加题" }]);
  }
  const move = (dayIndex: number, itemIndex: number, step: -1 | 1) => editDay(dayIndex, (items) => {
    const next = [...items]; const target = itemIndex + step;
    if (target < 0 || target >= next.length) return items;
    [next[itemIndex], next[target]] = [next[target], next[itemIndex]]; return next;
  });
  const remove = (dayIndex: number, itemIndex: number) => editDay(dayIndex, (items) => items.filter((_, index) => index !== itemIndex));

  // 排版: the plan is saved (a new record, or the one it came from) and 快速排版 opens on it, one day per page.
  async function typeset() {
    if (!plan || !total) return;
    setError(""); setBusy("正在保存方案…");
    try {
      await authorizeDownload(planQuestionIds(plan));
      const current = { ...plan, studentId: studentId || null };
      const name = title.trim() || plan.brief.title || "智能组卷";
      const saved = recordId ? (await updateTypesetRecord(recordId, { title: name, plan: current })).record : (await createSmartPaperRecord({ title: name, plan: current, settings })).record;
      setRecordId(saved.id); setSettings(saved.settings); setTitle(saved.title);
      window.history.replaceState(null, "", `?record=${encodeURIComponent(saved.id)}`);
      setTypesetting(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); }
    finally { setBusy(""); }
  }

  if (typesetting && plan && recordId) {
    const days = planDays(plan, byId);
    return <Suspense fallback={<div className="smart-paper-loading"><i className="smart-paper-spinner" />正在打开快速排版…</div>}>
      <Typesetter basket={{
        questions: days.flatMap((day) => day.questions), title, settings, recordId, studentId: studentId || undefined,
        groups: days.map((day) => ({ title: day.title, size: day.questions.length })),
        origin: { back: "智能组卷 · 快速排版", name: `智能组卷${student ? ` · ${student.name}` : ""}`, hint: "点击回去调整题目" },
        onClose: (changedTitle, changedSettings) => { if (changedTitle) setTitle(changedTitle); setSettings(changedSettings); setTypesetting(false); },
      }} />
    </Suspense>;
  }

  const paths = plan && library ? plan.brief.categoryIds.map((id) => categoryPath(library.modules, library.categories, id)).filter(Boolean) : [];
  return <main className="smart-paper">
    <aside className="smart-paper-panel">
      <a className="toolbox-back" href="/tools"><SmartIcon name="back" /><span>工具箱 · 智能组卷</span></a>
      {user === null ? <p className="smart-paper-note">请先在题库页登录，再使用智能组卷。</p> : <>
        <label className="smart-paper-field"><span>学生</span>
          <select value={studentId} disabled={Boolean(busy)} onChange={(event) => setStudentId(event.target.value)}>
            <option value="">不针对某位学生</option>
            {students.map((item) => <option key={item.id} value={item.id}>{item.name}{item.className ? `（${item.className}）` : ""}</option>)}
          </select>
          <small>{student ? "会读这位学生的课后反馈、批改出的知识点正确率和错题，并避开做过、布置过的题。" : "选了学生，agent 会按学生档案挑题。"}</small>
        </label>
        <label className="smart-paper-field"><span>要出什么样的练习</span>
          <textarea rows={5} value={request} disabled={Boolean(busy)} placeholder={EXAMPLE} onChange={(event) => setRequest(event.target.value)} />
        </label>
        {!request && <button type="button" className="smart-paper-link" onClick={() => setRequest(EXAMPLE)}>用示例填写</button>}
        <button type="button" className="primary-button smart-paper-go" disabled={!request.trim() || Boolean(busy) || !library} onClick={generate}>
          <SmartIcon name="spark" />{plan ? "重新生成方案" : "生成方案"}
        </button>
        {busy && <p className="smart-paper-busy"><i className="smart-paper-spinner" />{busy}</p>}
        {error && <p className="smart-paper-note error" role="alert">{error}</p>}
        {plan && <section className="smart-paper-brief" aria-label="agent 的理解">
          <h3>agent 的理解</h3>
          <dl>
            <dt>范围</dt><dd>{paths.join("；") || "—"}</dd>
            <dt>题量</dt><dd>{plan.brief.days} 天 × 每天 {plan.brief.perDay} 题{plan.brief.questionTypes.length ? ` · ${plan.brief.questionTypes.join("、")}` : ""}</dd>
            {plan.brief.difficulty && <><dt>难度</dt><dd>{plan.brief.difficulty}</dd></>}
          </dl>
          {!!plan.brief.focus.length && <><h4>侧重点</h4><ul>{plan.brief.focus.map((focus) => <li key={focus.label}><b>{focus.label}</b>{focus.description && <small>{focus.description}</small>}</li>)}</ul></>}
          {!!plan.findings.length && <><h4>学生档案要点</h4><ul>{plan.findings.map((finding) => <li key={finding.label}><b>{finding.label}</b>{finding.evidence && <small>{finding.evidence}</small>}</li>)}</ul></>}
          {plan.avoided > 0 && <p className="smart-paper-note">已避开这位学生做过或练过的 {plan.avoided} 道题。</p>}
          <label className="smart-paper-field"><span>按意见调整</span>
            <textarea rows={2} value={instruction} disabled={Boolean(busy)} placeholder="例如：第 3 天难一点；每天加两道分数题" onChange={(event) => setInstruction(event.target.value)} />
          </label>
          <button type="button" className="secondary" disabled={!instruction.trim() || Boolean(busy)} onClick={revise}>按意见调整</button>
        </section>}
      </>}
    </aside>

    <section className="smart-paper-plan" aria-label="方案">
      {plan ? <>
        <header className="smart-paper-head">
          <input value={title} aria-label="练习标题" placeholder="练习标题" onChange={(event) => setTitle(event.target.value)} />
          <span>{total} 道题 · 分 {plan.groups.length} 天</span>
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
                {item.focus && <em>{item.focus}</em>}
                <small>{item.reason}</small>
                <PaperMoreMenu label={`${group.title}第 ${itemIndex + 1} 题的操作`}>
                  <button type="button" onClick={() => swap(dayIndex, itemIndex)}>换一道</button>
                  <button type="button" disabled={itemIndex === 0} onClick={() => move(dayIndex, itemIndex, -1)}>上移</button>
                  <button type="button" disabled={itemIndex === group.items.length - 1} onClick={() => move(dayIndex, itemIndex, 1)}>下移</button>
                  <button type="button" className="danger-text" onClick={() => remove(dayIndex, itemIndex)}>移除</button>
                </PaperMoreMenu>
              </div>
            </li>;
          })}</ol>
          <button type="button" className="smart-paper-link" onClick={() => add(dayIndex)}>＋ 加一道</button>
        </section>)}
      </> : <div className="smart-paper-empty">
        <SmartIcon name="spark" />
        <b>说一句要出什么练习，agent 从题库里挑题</b>
        <p>选好学生时，会读学生档案里的课后反馈、批改出的知识点正确率、错题和作业报告，侧重反复出错的地方，并避开做过、布置过的题。方案按天列出，每道题写明为什么选它；可以换题、删题、加题，或用一句话让 agent 调整，确认后点“排版”进快速排版，每天单独起页，排好后可以直接布置给这位学生。</p>
      </div>}
    </section>
  </main>;
}
