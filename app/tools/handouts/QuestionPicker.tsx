"use client";

import { useState } from "react";
import { QuestionBody } from "../../components/QuestionBody";
import { categoryDescendants, categoryPath, questionMatchesKeyword } from "../../../lib/library-tree";
import type { HandoutBand, LibraryData, Question, QuestionType } from "../../../lib/types";

export type PickerMode = { kind: "add"; sectionId: string | null; band: HandoutBand; label: string } | { kind: "replace"; itemId: string; question?: Question; label: string };

const QUESTION_TYPES: QuestionType[] = ["单选题", "多选题", "填空题", "判断题", "解答题"];
const PAGE_SIZE = 30;

// Add mode collects several questions; replace mode opens on the replaced question's
// category and type, and one click swaps it in place.
export function QuestionPicker({ library, mode, taken, onPick, onClose }: {
  library: LibraryData | null;
  mode: PickerMode;
  taken: Set<string>;
  onPick: (questionIds: string[]) => void;
  onClose: () => void;
}) {
  const replacing = mode.kind === "replace" ? mode : null;
  const [moduleId, setModuleId] = useState(replacing?.question?.moduleId ?? "");
  const [categoryId, setCategoryId] = useState(replacing?.question?.categoryId ?? "");
  const [type, setType] = useState<"全部" | QuestionType>(replacing?.question?.type ?? "全部");
  const [keyword, setKeyword] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<string[]>([]);

  const modules = library?.modules ?? [];
  const categories = library?.categories ?? [];
  const activeModuleId = modules.some((item) => item.id === moduleId) ? moduleId : modules[0]?.id ?? "";
  const moduleCategories = categories.filter((item) => item.moduleId === activeModuleId);
  const activeCategoryId = moduleCategories.some((item) => item.id === categoryId) ? categoryId : "";
  const allowed = activeCategoryId ? new Set(categoryDescendants(categories, activeCategoryId)) : null;
  const pathOf = (id: string) => categoryPath(modules, categories, id);
  const search = keyword.trim().toLowerCase();
  const byCode = library?.questions.find((question) => question.code === search);
  const results = byCode ? [byCode] : (library?.questions ?? []).filter((question) => question.moduleId === activeModuleId
    && (!allowed || allowed.has(question.categoryId))
    && (type === "全部" || question.type === type)
    && (!search || questionMatchesKeyword(question, search, pathOf(question.categoryId))));
  const isSelected = (id: string) => selected.includes(id);

  function toggle(id: string) { setSelected((current) => isSelected(id) ? current.filter((item) => item !== id) : [...current, id]); }

  return <div className="modal-backdrop"><section className="modal picker-modal" role="dialog" aria-modal="true" aria-label={replacing ? "替换题目" : "从题库选题"}>
    <div className="modal-head"><div><span className="eyebrow">{mode.label}</span><h2>{replacing ? "选一道题替换" : "选择要加入的题目"}</h2></div><button className="close" aria-label="关闭" onClick={onClose}>×</button></div>
    <div className="picker-filters">
      <label>模块<select value={activeModuleId} onChange={(event) => { setModuleId(event.target.value); setCategoryId(""); setLimit(PAGE_SIZE); }}>{modules.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>分类<select value={activeCategoryId} onChange={(event) => { setCategoryId(event.target.value); setLimit(PAGE_SIZE); }}><option value="">全部分类</option>{moduleCategories.map((item) => <option key={item.id} value={item.id}>{pathOf(item.id)}</option>)}</select></label>
      <label>题型<select value={type} onChange={(event) => { setType(event.target.value as "全部" | QuestionType); setLimit(PAGE_SIZE); }}><option>全部</option>{QUESTION_TYPES.map((item) => <option key={item}>{item}</option>)}</select></label>
      <label className="picker-search">搜索<input type="search" value={keyword} onChange={(event) => { setKeyword(event.target.value); setLimit(PAGE_SIZE); }} placeholder="四位 ID（全库）、题干、知识点" /></label>
    </div>
    {!library ? <p className="picker-empty">正在读取题库…</p> : !modules.length ? <p className="picker-empty">题库还没有模块。</p> : !results.length ? <p className="picker-empty">没有符合条件的题目。</p> : <>
      <p className="picker-count">共 {results.length} 道</p>
      <ol className="picker-list">{results.slice(0, limit).map((question, index) => {
        const inHandout = taken.has(question.id); const chosen = isSelected(question.id);
        return <li key={question.id} className={`picker-item${chosen ? " chosen" : ""}`}>
          <QuestionBody question={question} number={index + 1} />
          <div className="picker-item-foot"><small>{question.code && `ID ${question.code} · `}{question.type} · {question.difficulty} · {pathOf(question.categoryId)}</small>
            {inHandout ? <span className="picker-taken">已在讲义中</span> : replacing
              ? <button className="secondary" onClick={() => onPick([question.id])}>换成这道</button>
              : <button className={chosen ? "picker-toggle on" : "picker-toggle"} aria-pressed={chosen} onClick={() => toggle(question.id)}>{chosen ? "✓ 已选" : "＋ 选择"}</button>}
          </div>
        </li>;
      })}</ol>
      {results.length > limit && <button className="secondary picker-more" onClick={() => setLimit((current) => current + PAGE_SIZE)}>再显示 {Math.min(PAGE_SIZE, results.length - limit)} 道</button>}
    </>}
    {!replacing && <div className="modal-actions picker-actions"><span>已选 {selected.length} 道</span><button className="secondary" onClick={onClose}>取消</button><button className="primary-button" disabled={!selected.length} onClick={() => onPick(selected)}>加入讲义</button></div>}
  </section></div>;
}
