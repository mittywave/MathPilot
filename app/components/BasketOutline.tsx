"use client";

import { useEffect, useState, type Dispatch, type DragEvent, type SetStateAction } from "react";
import { basketSections, placeBasketQuestion, removeBasketSection, type BasketStructure } from "../../lib/paper-basket";
import { randomClientId } from "../../lib/client-random-id.mjs";
import { moduleHeading } from "../../lib/handout-rules.mjs";
import type { Question } from "../../lib/types";

// CategoryTree edits the library's taxonomy. This outline instead places the
// selected questions in one paper, without changing their library categories.
export function BasketOutline({ structure, pool, disabled, activeId, onChange, onLocate, onGroupByType, onNotice }: {
  structure: BasketStructure; pool: Question[]; disabled: boolean; activeId: string;
  onChange: Dispatch<SetStateAction<BasketStructure>>; onLocate: (id: string) => void; onGroupByType: () => void; onNotice: (message: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [dragged, setDragged] = useState<{ kind: "section" | "question"; id: string } | null>(null);
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
  return <div className="basket-outline" aria-label="试卷结构" onDragEnd={end} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null); }}>
    <div className="basket-outline-tools"><b>试卷结构</b><button type="button" disabled={disabled} onClick={() => {
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
            <button type="button" className="basket-fold" aria-expanded={!closed} aria-label={`${closed ? "展开" : "折叠"}${section.id ? section.title : "未分组"}`} onClick={() => setCollapsed((current) => closed ? current.filter((id) => id !== key) : [...current, key])}>{closed ? "▸" : "▾"}</button>
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
          {!closed && !!section.questions.length && <div className="basket-outline-questions">
            {section.questions.map((question, index) => <div key={question.id} className={`basket-outline-question${over?.anchorId === question.id ? ` insert-${over.side}` : ""}${dragged?.kind === "question" && dragged.id === question.id ? " is-dragging" : ""}${moved === question.id ? " is-moved" : ""}${activeId === question.id ? " is-active" : ""}`}>
              <button type="button" className="basket-outline-locate" data-question-id={question.id} draggable={!disabled} onDragStart={(event) => start(event, "question", question.id)} disabled={disabled}
                aria-label={`定位第 ${section.start + index + 1} 题`} aria-current={activeId === question.id || undefined} onClick={() => onLocate(question.id)} title={`第 ${section.start + index + 1} 题 · 点击定位，拖动排序或归组`}>
                {section.start + index + 1}
              </button>
            </div>)}
          </div>}
        </section>;
      })}
    </div>
  </div>;
}
