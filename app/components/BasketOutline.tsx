"use client";

import { useState, type Dispatch, type DragEvent, type SetStateAction } from "react";
import { basketSections, moveBasketQuestion, placeBasketQuestion, removeBasketSection, type BasketStructure } from "../../lib/paper-basket";
import { randomClientId } from "../../lib/client-random-id.mjs";
import { moduleHeading } from "../../lib/handout-rules.mjs";
import { splitMathLines } from "../../lib/math-text";
import type { Question } from "../../lib/types";
import { PaperMoreMenu } from "./PaperMoreMenu";
import { MathText } from "./MathText";

// CategoryTree edits the library's taxonomy. This outline instead places the
// selected questions in one paper, without changing their library categories.
export function BasketOutline({ structure, pool, disabled, onChange, onLocate, onGroupByType }: {
  structure: BasketStructure; pool: Question[]; disabled: boolean;
  onChange: Dispatch<SetStateAction<BasketStructure>>; onLocate: (id: string) => void; onGroupByType: () => void;
}) {
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [dragged, setDragged] = useState<{ kind: "section" | "question"; id: string } | null>(null);
  const [over, setOver] = useState("");
  const sections = basketSections(structure, pool);
  const end = () => { setDragged(null); setOver(""); };
  const start = (event: DragEvent, kind: "section" | "question", id: string) => {
    if (disabled) { event.preventDefault(); return; }
    setDragged({ kind, id });
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", id);
  };
  const accept = (event: DragEvent, target: string) => {
    if (!dragged || disabled) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; setOver(target);
  };
  const drop = (event: DragEvent, sectionId: string | null, beforeId?: string) => {
    if (!dragged || disabled) return;
    event.preventDefault(); event.stopPropagation();
    if (dragged.kind === "question") onChange((current) => placeBasketQuestion(current, dragged.id, sectionId, beforeId));
    else if (sectionId && dragged.id !== sectionId) onChange((current) => {
      const source = current.sections.find((section) => section.id === dragged.id);
      if (!source) return current;
      const next = current.sections.filter((section) => section.id !== dragged.id);
      next.splice(current.sections.findIndex((section) => section.id === sectionId), 0, source);
      return { ...current, sections: next };
    });
    end();
  };
  const moveSection = (id: string, direction: -1 | 1) => onChange((current) => {
    const ids = moveBasketQuestion(current.sections.map((section) => section.id), id, direction);
    return { ...current, sections: ids.map((item) => current.sections.find((section) => section.id === item)!) };
  });
  const moveQuestion = (id: string, sectionId: string | null, direction: -1 | 1) => onChange((current) => {
    if (sectionId === null) return { ...current, unassignedIds: moveBasketQuestion(current.unassignedIds, id, direction) };
    return { ...current, sections: current.sections.map((section) => section.id === sectionId ? { ...section, questionIds: moveBasketQuestion(section.questionIds, id, direction) } : section) };
  });

  return <div className="basket-outline" aria-label="试卷结构" onDragEnd={end}>
    <div className="basket-outline-tools"><b>试卷结构</b><button type="button" disabled={disabled} onClick={() => {
      const id = `section-${randomClientId()}`;
      onChange((current) => ({ ...current, sections: [...current.sections, { id, title: "新分组", questionIds: [] }] }));
      requestAnimationFrame(() => { const input = document.getElementById(`basket-title-${id}`) as HTMLInputElement | null; input?.focus(); input?.select(); });
    }}>＋ 大标题</button><button type="button" disabled={disabled || !pool.length || !sections.some((section) => section.questions.length)} onClick={onGroupByType}>按题型分类</button></div>
    <div className="basket-outline-scroll">
      {sections.map((section, sectionIndex) => {
        const key = section.id ?? "unassigned", closed = collapsed.includes(key);
        return <section key={key} className={`basket-outline-section${over === `section-${key}` ? " drop-target" : ""}`}
          onDragOver={(event) => accept(event, `section-${key}`)} onDrop={(event) => drop(event, section.id)}>
          <header>
            {section.id && <button type="button" className="basket-drag" draggable={!disabled} onDragStart={(event) => start(event, "section", section.id!)} disabled={disabled} aria-label={`拖动大标题 ${section.title}`} title="拖动大标题排序">⠿</button>}
            <button type="button" className="basket-fold" aria-expanded={!closed} aria-label={`${closed ? "展开" : "折叠"}${section.id ? section.title : "未分组"}`} onClick={() => setCollapsed((current) => closed ? current.filter((id) => id !== key) : [...current, key])}>{closed ? "▸" : "▾"}</button>
            {section.id && section.heading && <span className="basket-outline-numeral" aria-hidden="true">{section.heading.split("、")[0]}、</span>}
            {section.id ? <input id={`basket-title-${section.id}`} value={structure.sections[sectionIndex].title} disabled={disabled} aria-label={`大标题 ${sectionIndex + 1}`} maxLength={200}
              onChange={(event) => { const title = event.target.value; onChange((current) => ({ ...current, sections: current.sections.map((item) => item.id === section.id ? { ...item, title } : item) })); }}
              onBlur={() => onChange((current) => ({ ...current, sections: current.sections.map((item) => item.id === section.id ? { ...item, title: moduleHeading(item.title, 0).title || "新分组" } : item) }))} /> : <b>未分组</b>}
            <small>{section.questions.length} 题</small>
            {section.id && <PaperMoreMenu label={`大标题 ${sectionIndex + 1} 操作`}>
              <button disabled={disabled || sectionIndex === 0} onClick={() => moveSection(section.id!, -1)}>上移大标题</button>
              <button disabled={disabled || sectionIndex === structure.sections.length - 1} onClick={() => moveSection(section.id!, 1)}>下移大标题</button>
              <button disabled={disabled} onClick={() => onChange((current) => removeBasketSection(current, section.id!))}>删除标题，题目移回未分组</button>
            </PaperMoreMenu>}
          </header>
          {!closed && <div className="basket-outline-questions">
            {!section.questions.length && <p className="basket-outline-empty">{section.id ? "拖入题目，或用题卡的“移动到”归组" : "新选的题目会放在这里"}</p>}
            {section.questions.map((question, index) => <div key={question.id} className={`basket-outline-question${over === question.id ? " drop-target" : ""}`}
              onDragOver={(event) => { if (dragged?.kind === "question") accept(event, question.id); }} onDrop={(event) => drop(event, section.id, question.id)}>
              <button type="button" className="basket-drag" draggable={!disabled} onDragStart={(event) => start(event, "question", question.id)} disabled={disabled} aria-label={`拖动第 ${section.start + index + 1} 题`} title="拖动调整顺序或归组">⠿</button>
              <button type="button" className="basket-outline-locate" onClick={() => onLocate(question.id)} title={`定位第 ${section.start + index + 1} 题`}>
                <span><b>{section.start + index + 1}.</b>{question.code && <small>ID {question.code}</small>}</span><span className="basket-outline-excerpt"><MathText text={splitMathLines(question.stem).find((line) => line.trim()) || "图片题"} /></span>
              </button>
              <PaperMoreMenu label={`第 ${section.start + index + 1} 题结构操作`}>
                <button disabled={disabled || index === 0} onClick={() => moveQuestion(question.id, section.id, -1)}>上移题目</button>
                <button disabled={disabled || index === section.questions.length - 1} onClick={() => moveQuestion(question.id, section.id, 1)}>下移题目</button>
                {sections.filter((target) => target.id !== section.id).map((target) => <button key={target.id ?? "unassigned"} disabled={disabled} onClick={() => onChange((current) => placeBasketQuestion(current, question.id, target.id))}>移动到：{target.id ? target.title : "未分组"}</button>)}
              </PaperMoreMenu>
            </div>)}
          </div>}
        </section>;
      })}
    </div>
  </div>;
}
