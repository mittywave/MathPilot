"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type DragEvent, type SetStateAction } from "react";
import { basketIds, basketSections, moveBasketQuestion, placeBasketQuestion, removeBasketSection, selectBasketQuestions, type BasketStructure } from "../../lib/paper-basket";
import { randomClientId } from "../../lib/client-random-id.mjs";
import { moduleHeading } from "../../lib/handout-rules.mjs";
import { fetchLibrary } from "../../lib/api-client";
import { categoryPath } from "../../lib/library-tree";
import { QuestionPicker, type PickerMode } from "../tools/handouts/QuestionPicker";
import { QuestionWorkspace, useQuestionWorkspace } from "../tools/handouts/QuestionWorkspace";
import { SheetQuestion } from "./QuestionBody";
import { BrandWordmark } from "./SiteHeader";
import { PaperMoreMenu } from "./PaperMoreMenu";
import { DocxContent } from "./DocxContent";
import { MathText } from "./MathText";
import { StudioSolution } from "./StudioSolution";
import "../tools/tools.css";
import type { AuthUser, LibraryData, Question } from "../../lib/types";

// CategoryTree edits the library's taxonomy. This outline instead places the
// selected questions in one paper, without changing their library categories.
function BasketOutline({ structure, pool, disabled, activeId, onChange, onLocate, onGroupByType, onNotice, dragged, setDragged }: {
  dragged: { kind: "section" | "question"; id: string } | null; setDragged: Dispatch<SetStateAction<{ kind: "section" | "question"; id: string } | null>>;
  structure: BasketStructure; pool: Question[]; disabled: boolean; activeId: string;
  onChange: Dispatch<SetStateAction<BasketStructure>>; onLocate: (id: string) => void; onGroupByType: () => void; onNotice: (message: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [over, setOver] = useState<{ sectionId: string | null; beforeId?: string; anchorId?: string; side?: "before" | "after" } | null>(null);
  const [moved, setMoved] = useState("");
  useEffect(() => {
    if (!moved) return;
    const timer = setTimeout(() => setMoved(""), 2000);
    return () => clearTimeout(timer);
  }, [moved]);
  // A question picked in the list keeps its number in view here.
  useEffect(() => { if (activeId) document.querySelector(`.basket-outline-locate[data-question-id="${CSS.escape(activeId)}"]`)?.scrollIntoView({ block: "nearest" }); }, [activeId]);
  const sections = basketSections(structure, pool);
  const end = () => { setDragged(null); setOver(null); };
  const start = (event: DragEvent, kind: "section" | "question", id: string) => {
    if (disabled) { event.preventDefault(); return; }
    setMoved(""); setDragged({ kind, id });
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", id);
  };
  // Resolve a slot from the pointer, including the gaps and wrapped rows. The
  // indicator and the drop share this calculation, so the preview is the result.
  const targetAt = (event: DragEvent<HTMLElement>, sectionId: string | null) => {
    const nodes = [...event.currentTarget.querySelectorAll<HTMLElement>(".basket-outline-question")];
    if (dragged?.kind !== "question" || !nodes.length) return { sectionId };
    const entries = nodes.map((node) => ({ id: node.querySelector<HTMLElement>("[data-question-id]")!.dataset.questionId!, rect: node.getBoundingClientRect() }));
    if (!(event.target as Element).closest(".basket-outline-questions")) {
      return { sectionId, anchorId: entries.at(-1)!.id, side: "after" as const };
    }
    const nearest = entries.reduce((best, item) => Math.abs(event.clientY - (item.rect.top + item.rect.height / 2)) < Math.abs(event.clientY - (best.rect.top + best.rect.height / 2)) ? item : best);
    const row = entries.filter((item) => Math.abs(item.rect.top - nearest.rect.top) < 1);
    const next = row.find((item) => event.clientX < item.rect.left + item.rect.width / 2);
    const anchor = next ?? row.at(-1)!;
    return { sectionId, beforeId: next?.id ?? entries[entries.indexOf(anchor) + 1]?.id, anchorId: anchor.id, side: next ? "before" as const : "after" as const };
  };
  const accept = (event: DragEvent<HTMLElement>, sectionId: string | null) => {
    if (!dragged || disabled) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move";
    setOver(targetAt(event, sectionId));
  };
  const drop = (event: DragEvent<HTMLElement>, sectionId: string | null) => {
    if (!dragged || disabled) return;
    event.preventDefault(); event.stopPropagation();
    if (dragged.kind === "question") {
      const target = targetAt(event, sectionId);
      const next = placeBasketQuestion(structure, dragged.id, sectionId, target.beforeId);
      if (JSON.stringify(next) === JSON.stringify(structure)) onNotice("题目位置未改变");
      else {
        const previous = sections.flatMap((section) => section.questions).findIndex((question) => question.id === dragged.id) + 1;
        const destination = basketSections(next, pool).find((section) => section.id === sectionId)!;
        const position = destination.questions.findIndex((question) => question.id === dragged.id) + 1;
        onChange(next); setMoved(dragged.id);
        setCollapsed((current) => current.filter((id) => id !== (sectionId ?? "unassigned")));
        onNotice(`已将原第 ${previous} 题移至「${sectionId ? destination.title : "未分组"}」第 ${position} 位（全卷第 ${destination.start + position} 题）`);
      }
    } else if (sectionId && dragged.id !== sectionId) {
      const source = structure.sections.find((section) => section.id === dragged.id);
      if (source) {
        const next = structure.sections.filter((section) => section.id !== dragged.id);
        next.splice(structure.sections.findIndex((section) => section.id === sectionId), 0, source);
        onChange({ ...structure, sections: next }); onNotice("已调整大标题顺序");
      }
    }
    end();
  };
  return <div className="basket-outline" aria-label="试卷分组" onDragEnd={end} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null); }}>
    <div className="basket-outline-tools"><button type="button" disabled={disabled} onClick={() => {
      const id = `section-${randomClientId()}`;
      onChange((current) => ({ ...current, sections: [...current.sections, { id, title: "新分组", questionIds: [] }] }));
      requestAnimationFrame(() => { const input = document.getElementById(`basket-title-${id}`) as HTMLInputElement | null; input?.focus(); input?.select(); });
    }}>＋ 大标题</button><button type="button" disabled={disabled || !pool.length || !sections.some((section) => section.questions.length)} onClick={onGroupByType}>按题型分类</button></div>
    <div className="basket-outline-scroll">
      {sections.map((section, sectionIndex) => {
        const key = section.id ?? "unassigned", closed = collapsed.includes(key);
        return <section key={key} className={`basket-outline-section${over?.sectionId === section.id && !over.anchorId ? " drop-target" : ""}`}
          onDragOver={(event) => accept(event, section.id)} onDrop={(event) => drop(event, section.id)}>
          <header>
            {section.id && <button type="button" className="basket-drag" draggable={!disabled} onDragStart={(event) => start(event, "section", section.id!)} disabled={disabled} aria-label={`拖动大标题 ${section.title}`} title="拖动大标题排序">⠿</button>}
            <button type="button" className="basket-fold" aria-expanded={!closed} aria-label={`${closed ? "展开" : "折叠"}${section.id ? section.title : "未分组"}`} title={`${closed ? "展开" : "折叠"}分组`} onClick={() => setCollapsed((current) => closed ? current.filter((id) => id !== key) : [...current, key])}>{closed ? "▸" : "▾"}</button>
            {section.id && section.heading && <span className="basket-outline-numeral" aria-hidden="true">{section.heading.split("、")[0]}、</span>}
            {section.id ? <input id={`basket-title-${section.id}`} value={structure.sections[sectionIndex].title} disabled={disabled} aria-label={`大标题 ${sectionIndex + 1}`} maxLength={200}
              onChange={(event) => { const title = event.target.value; onChange((current) => ({ ...current, sections: current.sections.map((item) => item.id === section.id ? { ...item, title } : item) })); }}
              onBlur={() => onChange((current) => ({ ...current, sections: current.sections.map((item) => item.id === section.id ? { ...item, title: moduleHeading(item.title, 0).title || "新分组" } : item) }))} /> : <b>未分组</b>}
            <small>{section.questions.length} 题</small>
            {section.id && <button type="button" className="basket-delete" disabled={disabled} title="删除标题，题目移回未分组" aria-label="删除标题，题目移回未分组"
              onClick={() => onChange((current) => removeBasketSection(current, section.id!))}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6" /></svg>
            </button>}
          </header>
          <div className={`basket-outline-fold${closed ? " closed" : ""}`} inert={closed} aria-hidden={closed}><div><div className="basket-outline-questions">
            {section.questions.map((question, index) => <div key={question.id} className={`basket-outline-question${over?.anchorId === question.id ? ` insert-${over.side}` : ""}${dragged?.kind === "question" && dragged.id === question.id ? " is-dragging" : ""}${moved === question.id ? " is-moved" : ""}${activeId === question.id ? " is-active" : ""}`}>
              <button type="button" className="basket-outline-locate" data-question-id={question.id} draggable={!disabled} onDragStart={(event) => start(event, "question", question.id)} disabled={disabled}
                aria-label={`定位第 ${section.start + index + 1} 题`} aria-current={activeId === question.id || undefined} onClick={() => onLocate(question.id)} title={`第 ${section.start + index + 1} 题 · 点击定位，拖动排序或归组`}>
                {section.start + index + 1}
              </button>
            </div>)}
          </div></div></div>
        </section>;
      })}
    </div>
  </div>;
}


// The basket owns placements and local persistence; the workspace, picker and
// assessment rows are the same components used by handout quizzes and homework.
export default function BasketEditor({ user, library, pool, structure, title, includeAnswers, disabled, exporting, status, onChange, onTitle, onAnswers, onLibrary, onBack, onTypeset, onWord, onGroupByType, onNotice }: {
  user: AuthUser; library: LibraryData; pool: Question[]; structure: BasketStructure; title: string; includeAnswers: boolean; disabled: boolean; exporting: boolean; status: string;
  onChange: Dispatch<SetStateAction<BasketStructure>>; onTitle: (title: string) => void; onAnswers: (include: boolean) => void; onLibrary: (library: LibraryData) => void; onBack: () => void; onTypeset: () => void; onWord: () => void; onGroupByType: () => void; onNotice: (message: string, tone?: "success" | "error") => void;
}) {
  const [treeOpen, setTreeOpen] = useState(false);
  const workspace = useQuestionWorkspace("mathpilot-basket-panels", treeOpen);
  const [picker, setPicker] = useState<PickerMode | null>(null);
  const [activeId, setActiveId] = useState("");
  const [limit, setLimit] = useState(40);
  const [locating, setLocating] = useState("");
  const [dragged, setDragged] = useState<{ kind: "section" | "question"; id: string } | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; after: boolean } | null>(null);
  const [answers, setAnswers] = useState<string[]>([]);
  const end = useRef<HTMLDivElement>(null);
  const libraryChanged = useRef(onLibrary);
  useEffect(() => { libraryChanged.current = onLibrary; }, [onLibrary]);
  const refreshLibrary = useCallback(async () => { libraryChanged.current(await fetchLibrary()); }, []);
  const ids = useMemo(() => basketIds(structure), [structure]);
  const sections = useMemo(() => basketSections(structure, pool), [structure, pool]);
  const currentId = ids.includes(activeId) ? activeId : ids[0] ?? "";
  const count = sections.reduce((sum, section) => sum + section.questions.length, 0);
  const taken = useMemo(() => new Set(ids), [ids]);
  const usedIn = useMemo(() => new Map<string, Set<string>>(), []);
  const options = sections.map(section => ({ id: section.id ?? "", label: section.id ? section.title : "未分组" }));
  const activePicker: PickerMode = picker?.kind === "replace" && taken.has(picker.itemId) ? picker : { kind: "add", sectionId: picker?.kind === "add" && structure.sections.some(section => section.id === picker.sectionId) ? picker.sectionId : null, band: "example" };

  useEffect(() => {
    if (!end.current) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) setLimit(current => current + 40); }, { root: end.current.closest(".handout-draft"), rootMargin: "800px" });
    observer.observe(end.current);
    return () => observer.disconnect();
  }, [limit, count]);
  useEffect(() => {
    if (!locating) return;
    const frame = requestAnimationFrame(() => {
      const card = document.getElementById(`basket-question-${locating}`);
      if (card) { card.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" }); card.focus({ preventScroll: true }); setLocating(""); }
    });
    return () => cancelAnimationFrame(frame);
  }, [locating, limit]);
  const locate = (id: string) => { setLimit(current => Math.max(current, ids.indexOf(id) + 1)); setActiveId(id); setLocating(id); };
  const choose = (mode: PickerMode) => { workspace.setPanels(current => ({ ...current, bank: true })); setPicker(mode); };
  const move = (id: string, direction: -1 | 1) => onChange(current => {
    const group = current.sections.find(section => section.questionIds.includes(id));
    return group ? { ...current, sections: current.sections.map(section => section.id === group.id ? { ...section, questionIds: moveBasketQuestion(section.questionIds, id, direction) } : section) } : { ...current, unassignedIds: moveBasketQuestion(current.unassignedIds, id, direction) };
  });
  const pick = (questionIds: string[]) => {
    if (disabled) return;
    const fresh = questionIds.filter(id => !taken.has(id));
    if (!fresh.length) return;
    if (activePicker.kind === "replace") {
      const oldId = activePicker.itemId, newId = fresh[0];
      onChange(current => ({ sections: current.sections.map(section => ({ ...section, questionIds: section.questionIds.map(id => id === oldId ? newId : id) })), unassignedIds: current.unassignedIds.map(id => id === oldId ? newId : id) }));
      setPicker(null); setActiveId(newId); onNotice("题目已替换，分组与位置保留");
    } else {
      onChange(current => {
        let next = selectBasketQuestions(current, [...basketIds(current), ...fresh]);
        if (activePicker.sectionId) for (const id of fresh) next = placeBasketQuestion(next, id, activePicker.sectionId);
        return next;
      });
      onNotice(`已加入 ${fresh.length} 道练习题`);
    }
  };
  return <main className="toolbox handouts handout-editor basket-editor">
    <header className="handout-bar">
      <button className="handout-brand" onClick={onBack} aria-label="返回题库" title="返回题库"><BrandWordmark /></button>
      <span className="handout-location">组卷篮<span aria-hidden="true">/</span>练习卷</span>
      <span className="handout-save" role="status">{status}</span>
      <label className="basket-answer"><input type="checkbox" checked={includeAnswers} disabled={disabled} onChange={event => onAnswers(event.target.checked)} />附带答案与解析</label>
      <button className="secondary" disabled={disabled || !count} onClick={onWord}>{exporting ? "正在生成…" : "生成 Word"}</button>
      <button className="primary-button" disabled={disabled || !count} onClick={onTypeset}>快速排版</button>
      <PaperMoreMenu label="练习卷更多操作"><button disabled={disabled || !ids.length && !structure.sections.length} onClick={() => onChange({ sections: [], unassignedIds: [] })}>清空组卷篮</button></PaperMoreMenu>
    </header>
    <QuestionWorkspace {...workspace} outlineLabel="试卷" draftLabel="练习卷编辑" bank={
      <QuestionPicker library={library} user={user} onLibraryChanged={refreshLibrary} treeOpen={treeOpen} onTreeOpenChange={setTreeOpen} mode={activePicker} sheet="practice" disabled={disabled} taken={taken} usedIn={usedIn} onPick={pick} sections={options} onModeChange={setPicker} onNotice={onNotice} />
    } outline={<>
      <header><h2>试卷结构</h2><span>{count} 题</span></header>
      <button className="handout-outline-title" onClick={() => document.getElementById("basket-heading")?.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" })}>{title || "未命名练习卷"}</button>
      <BasketOutline structure={structure} pool={pool} disabled={disabled} activeId={currentId} onChange={onChange} onLocate={locate} onGroupByType={onGroupByType} onNotice={onNotice} dragged={dragged} setDragged={setDragged} />
    </>}>
      <div className="handout-draft-head" id="basket-heading" tabIndex={-1}>
        <input className="handout-title" aria-label="练习标题" placeholder="输入练习标题" value={title} disabled={disabled} onChange={event => onTitle(event.target.value)} />
        <span className="basket-paper-count">练习卷 · {count} 题</span>
      </div>
      <div className="basket-student-line" aria-label="答卷信息">姓名 __________<span>班级 __________</span>得分 __________</div>
      {!count && <div className="handout-empty"><b>从左侧选题，开始编排练习卷</b><p>可按知识点选题，也可浏览试卷整卷选择。</p></div>}
      {sections.filter(section => section.id || section.questions.length).map(section => <section className="handout-list" key={section.id ?? "unassigned"}>
        <div className="handout-lane">
          <div className="handout-lane-head basket-section-heading"><b>{section.heading || (section.id ? section.title : "试题")}</b><span className="handout-count">{section.questions.length}</span>
            <div className="handout-lane-add"><button className="text-button" disabled={disabled} onClick={() => choose({ kind: "add", sectionId: section.id, band: "example" })}>从题库选题</button></div>
          </div>
          {!section.questions.length && <p className="basket-empty-group">此分组尚未加入题目</p>}
          {section.questions.slice(0, Math.max(0, limit - section.start)).map((question, index) => {
            const number = section.start + index + 1;
            const label = `第 ${number} 题`;
            return <SheetQuestion key={question.id} id={`basket-question-${question.id}`} question={question} number={number}
              className={`${currentId === question.id ? "active" : ""}${dropAt?.id === question.id ? dropAt.after ? " drop-after" : " drop-before" : ""}`}
              onFocus={() => setActiveId(question.id)}
              onDragOver={event => { if (disabled || dragged?.kind !== "question") return; event.preventDefault(); const box = event.currentTarget.getBoundingClientRect(); setDropAt({ id: question.id, after: event.clientY > box.top + box.height / 2 }); }}
              onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropAt(null); }}
              onDrop={event => { if (disabled || dragged?.kind !== "question") return; event.preventDefault(); const box = event.currentTarget.getBoundingClientRect(); const after = event.clientY > box.top + box.height / 2; onChange(current => placeBasketQuestion(current, dragged.id, section.id, after ? section.questions[index + 1]?.id : question.id)); setActiveId(dragged.id); setDragged(null); setDropAt(null); }}
              grip={<button type="button" className="handout-drag" draggable={!disabled} disabled={disabled} aria-label={`拖动${label}调整顺序`} title="拖动调整顺序，也可按 ↑ ↓ 键"
                onDragStart={event => { setDragged({ kind: "question", id: question.id }); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", question.id); }}
                onDragEnd={() => { setDragged(null); setDropAt(null); }} onKeyDown={event => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); move(question.id, event.key === "ArrowUp" ? -1 : 1); } }}><svg viewBox="0 0 10 16" aria-hidden="true">{[3,8,13].flatMap(y => [2.5,7.5].map(x => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.2" />))}</svg></button>}
              metadata={<small>{question.code && `ID ${question.code} · `}{question.type} · {question.difficulty} · {categoryPath(library.modules, library.categories, question.categoryId) || "学生错题"}{question.createdBy === "local-admin" ? " · 本机管理员 录入" : question.createdByEmail ? ` · ${question.createdByEmail} 录入` : ""}</small>}>
              {!!structure.sections.length && <label className="handout-tests">分组<select aria-label={`${label}移动到`} disabled={disabled} value={section.id ?? ""} onChange={event => onChange(current => placeBasketQuestion(current, question.id, event.target.value || null))}>{options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>}
              <div className="handout-actions">
                <button onClick={() => setAnswers(current => current.includes(question.id) ? current.filter(id => id !== question.id) : [...current, question.id])}>{answers.includes(question.id) ? "收起解析" : "查看解析"}</button>
                <button disabled={disabled} onClick={() => choose({ kind: "replace", itemId: question.id, label: `替换${label}` })}>替换</button>
                <PaperMoreMenu label={`${label}更多操作`}><button disabled={disabled || index === 0} onClick={() => move(question.id, -1)}>上移</button><button disabled={disabled || index === section.questions.length - 1} onClick={() => move(question.id, 1)}>下移</button></PaperMoreMenu>
                <button className="danger" disabled={disabled} aria-label={`移除${label}`} onClick={() => onChange(current => selectBasketQuestions(current, basketIds(current).filter(id => id !== question.id)))}>移出练习卷</button>
              </div>
              <div className={`basket-solution${answers.includes(question.id) ? " open" : ""}`} inert={!answers.includes(question.id)} aria-hidden={!answers.includes(question.id)}><div><div className="answer-box"><b>答案</b><p><MathText text={question.answer || "略"} /></p>{question.analysis && <><b>解析</b><div className="analysis-content">{question.studioSource ? <StudioSolution source={{ ...question.studioSource, analysis: question.analysis }} /> : <DocxContent xml={question.analysisDocxXml} fallback={question.analysis} assets={question.analysisDocxAssets} />}</div></>}</div></div></div>
            </SheetQuestion>;
          })}
        </div>
      </section>)}
      {count > limit && <div ref={end} className="basket-list-end"><button className="text-button" onClick={() => setLimit(current => current + 40)}>继续显示题目</button></div>}
    </QuestionWorkspace>
  </main>;
}
