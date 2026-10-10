"use client";

import { type ReactNode, useState } from "react";
import { CategoryTree } from "../../components/CategoryTree";
import { QuestionBody } from "../../components/QuestionBody";
import { HANDOUT_BANDS, HANDOUT_PARTS } from "../../../lib/handout-rules.mjs";
import { categoryDescendants, categoryPath, questionMatchesKeyword } from "../../../lib/library-tree";
import type { HandoutBand, LibraryData, QuestionType } from "../../../lib/types";

export type PickerMode = { kind: "add"; sectionId: string | null; band: HandoutBand } | { kind: "replace"; itemId: string; label: string };

const QUESTION_TYPES: QuestionType[] = ["单选题", "多选题", "填空题", "判断题", "解答题"];
const PAGE_SIZE = 30;

// The same bank stays open while adding to different lanes or replacing a question.
// The footer sits under the directory: the editor puts its back link, save status and export there.
export function QuestionPicker({ library, mode, taken, onPick, sections, onModeChange, footer }: {
  library: LibraryData | null;
  mode: PickerMode;
  taken: Set<string>;
  onPick: (questionIds: string[]) => void;
  sections: { id: string; label: string }[];
  onModeChange: (mode: PickerMode | null) => void;
  footer?: ReactNode;
}) {
  const replacing = mode.kind === "replace";
  const [moduleId, setModuleId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [type, setType] = useState<"全部" | QuestionType>("全部");
  const [keyword, setKeyword] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<string[]>([]);

  const modules = library?.modules ?? [];
  const categories = library?.categories ?? [];
  const activeModule = modules.find((item) => item.id === moduleId) ?? modules[0] ?? null;
  const activeModuleId = activeModule?.id ?? "";
  const moduleCategories = categories.filter((item) => item.moduleId === activeModuleId);
  const activeCategoryId = moduleCategories.some((item) => item.id === categoryId) ? categoryId : "";
  const allowed = activeCategoryId ? new Set(categoryDescendants(categories, activeCategoryId)) : null;
  const pathOf = (id: string) => categoryPath(modules, categories, id);
  const moduleQuestions = (library?.questions ?? []).filter((question) => question.moduleId === activeModuleId);
  const countFor = (id: string) => id === activeModuleId ? moduleQuestions.length : moduleQuestions.filter((question) => categoryDescendants(categories, id).includes(question.categoryId)).length;
  const search = keyword.trim().toLowerCase();
  const byCode = library?.questions.find((question) => question.code === search);
  const results = byCode ? [byCode] : moduleQuestions.filter((question) => (!allowed || allowed.has(question.categoryId))
    && (type === "全部" || question.type === type)
    && (!search || questionMatchesKeyword(question, search, pathOf(question.categoryId))));
  const availableSelection = selected.filter((id) => !taken.has(id));
  const isSelected = (id: string) => availableSelection.includes(id);

  function toggle(id: string) { setSelected((current) => isSelected(id) ? current.filter((item) => item !== id) : [...current, id]); }

  return <section className="handout-bank" aria-label="题库选题">
    <aside className="picker-tree" aria-label="知识目录">
      <h2>知识目录</h2>
      <CategoryTree module={activeModule} categories={categories} activeId={activeCategoryId || activeModuleId} countFor={countFor} onSelect={(id) => { setCategoryId(id === activeModuleId ? "" : id); setLimit(PAGE_SIZE); }} />
      {footer}
    </aside>
    <div className="picker-main">
      {mode.kind === "replace" ? <div className="picker-replacing"><strong>{mode.label} · 选一道题替换</strong><button className="text-button" onClick={() => onModeChange(null)}>取消替换</button></div> : <div className="picker-target">
        <span>加入</span>
        <select aria-label="加入模块" value={mode.sectionId ?? ""} onChange={(event) => onModeChange({ ...mode, sectionId: event.target.value })} disabled={!sections.length}>
          {!sections.length && <option value="">请先添加知识模块</option>}
          {sections.map((section) => <option key={section.id} value={section.id}>{section.label}</option>)}
        </select>
        <select aria-label="题目用途" value={mode.band} onChange={(event) => onModeChange({ ...mode, band: event.target.value as HandoutBand })}>
          {HANDOUT_BANDS.map((band) => <option key={band} value={band}>作为{HANDOUT_PARTS[band].label}</option>)}
        </select>
      </div>}
      <div className="picker-filters">
        <input type="search" aria-label="搜索" value={keyword} onChange={(event) => { setKeyword(event.target.value); setLimit(PAGE_SIZE); }} placeholder="搜索四位 ID（全库）、题干、知识点" />
        <select aria-label="模块" value={activeModuleId} onChange={(event) => { setModuleId(event.target.value); setCategoryId(""); setLimit(PAGE_SIZE); }}>{modules.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        <select aria-label="题型" value={type} onChange={(event) => { setType(event.target.value as "全部" | QuestionType); setLimit(PAGE_SIZE); }}><option value="全部">全部题型</option>{QUESTION_TYPES.map((item) => <option key={item}>{item}</option>)}</select>
      </div>
      <div className="picker-results">
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
      </div>
      {mode.kind === "add" && <div className="picker-actions"><span>已选 {availableSelection.length} 道</span><button className="text-button" disabled={!availableSelection.length} onClick={() => setSelected([])}>清空选择</button><button className="primary-button" disabled={!availableSelection.length || !mode.sectionId} onClick={() => { onPick(availableSelection); setSelected([]); }}>加入{HANDOUT_PARTS[mode.band].label}</button></div>}
    </div>
  </section>;
}
