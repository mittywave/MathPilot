"use client";

import { type ReactNode, useState } from "react";
import { CategoryTree } from "../../components/CategoryTree";
import { QuestionBody } from "../../components/QuestionBody";
import { HANDOUT_BANDS, HANDOUT_PARTS, sheetLabel } from "../../../lib/handout-rules.mjs";
import { categoryDescendants, categoryPath, questionMatchesKeyword } from "../../../lib/library-tree";
import type { HandoutBand, HandoutSheet, LibraryData, Question, QuestionType } from "../../../lib/types";

export type PickerMode = { kind: "add"; sectionId: string | null; band: HandoutBand } | { kind: "replace"; itemId: string; label: string };

const QUESTION_TYPES: QuestionType[] = ["单选题", "多选题", "填空题", "判断题", "解答题"];
const PAGE_SIZE = 30;

// The same bank stays open while adding to different lanes or replacing a question.
// The footer sits under the directory: the editor puts its back link, save status and export there.
// For a 小测 or 作业 the chosen module is the one the new questions test, and there is no band to choose.
// taken: already in the open sheet, so not offered again; usedIn: where else in this 讲 a question is used.
export function QuestionPicker({ library, mode, sheet, taken, usedIn, onPick, sections, onModeChange, footer, source, onSourceChange, temporaryQuestions, onImport, onArchive, onEdit, onRemove, onNotice }: {
  library: LibraryData | null;
  mode: PickerMode;
  sheet: HandoutSheet;
  taken: Set<string>;
  usedIn: Map<string, Set<string>>;
  onPick: (questionIds: string[]) => void;
  sections: { id: string; label: string }[];
  onModeChange: (mode: PickerMode | null) => void;
  footer?: ReactNode;
  source: "library" | "temporary";
  onSourceChange: (source: "library" | "temporary") => void;
  temporaryQuestions: Question[];
  onImport: () => void;
  onArchive: (ids: string[], categoryId: string) => Promise<string[]>;
  onEdit: (question: Question) => void;
  onRemove: (id: string) => void;
  onNotice: (message: string) => void;
}) {
  const replacing = mode.kind === "replace";
  const list = sheet === "handout" ? null : sheetLabel(sheet);
  const [moduleId, setModuleId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [type, setType] = useState<"全部" | QuestionType>("全部");
  const [keyword, setKeyword] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<string[]>([]);
  const [archiveIds, setArchiveIds] = useState<string[]>([]);
  const [archiveCategory, setArchiveCategory] = useState("");
  const [archiving, setArchiving] = useState(false);
  const [fileName, setFileName] = useState("");
  const temporary = source === "temporary";

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
  const results = temporary ? temporaryQuestions.filter((question) => (!fileName || question.importFileName === fileName)
    && (type === "全部" || question.type === type) && (!search || questionMatchesKeyword(question, search, question.importFileName ?? ""))) : byCode ? [byCode] : moduleQuestions.filter((question) => (!allowed || allowed.has(question.categoryId))
    && (type === "全部" || question.type === type)
    && (!search || questionMatchesKeyword(question, search, pathOf(question.categoryId))));
  const visibleIds = new Set((temporary ? temporaryQuestions : library?.questions ?? []).map((question) => question.id));
  const archived = new Set((library?.questions ?? []).map((question) => question.id));
  const availableSelection = selected.filter((id) => visibleIds.has(id) && !taken.has(id));
  const pendingArchive = archiveIds.filter((id) => visibleIds.has(id) && !archived.has(id));
  const isSelected = (id: string) => availableSelection.includes(id);

  function toggle(id: string) { setSelected((current) => isSelected(id) ? current.filter((item) => item !== id) : [...current, id]); }

  return <section className="handout-bank" aria-label="题库选题">
    <aside className="picker-tree" aria-label="知识目录">
      <h2>{temporary ? "临时题库" : "知识目录"}</h2>
      {temporary ? <div className="picker-temporary-help"><p>仅用于当前讲义、小测和作业，随讲义保存。</p><p>刷新后仍保留；勾选「存入正式题库」后，可在其他讲义中复用。</p></div> : <CategoryTree module={activeModule} categories={categories} activeId={activeCategoryId || activeModuleId} countFor={countFor} onSelect={(id) => { setCategoryId(id === activeModuleId ? "" : id); setLimit(PAGE_SIZE); }} />}
      {footer}
    </aside>
    <div className="picker-main">
      <div className="picker-source"><div className="handout-sheets" role="tablist" aria-label="选题来源">
        <button role="tab" aria-selected={!temporary} onClick={() => { onSourceChange("library"); setSelected([]); }}>正式题库</button>
        <button role="tab" aria-selected={temporary} onClick={() => { onSourceChange("temporary"); setSelected([]); }}>临时题库 <span>{temporaryQuestions.length}</span></button>
      </div>{temporary && <button className="secondary" onClick={onImport}>导入文件</button>}</div>
      {mode.kind === "replace" ? <div className="picker-replacing"><strong>{mode.label} · 选一道题替换</strong><button className="text-button" onClick={() => onModeChange(null)}>取消替换</button></div> : <div className={`picker-target${list ? " list" : ""}`}>
        <span>{list ? `加入${list}，考查` : "加入"}</span>
        <select aria-label={list ? "考查模块" : "加入模块"} value={mode.sectionId ?? ""} onChange={(event) => onModeChange({ ...mode, sectionId: event.target.value })} disabled={!sections.length}>
          {!sections.length && <option value="">{list ? "讲义还没有知识模块" : "请先添加知识模块"}</option>}
          {sections.map((section) => <option key={section.id} value={section.id}>{section.label}</option>)}
        </select>
        {!list && <select aria-label="题目用途" value={mode.band} onChange={(event) => onModeChange({ ...mode, band: event.target.value as HandoutBand })}>
          {HANDOUT_BANDS.map((band) => <option key={band} value={band}>作为{HANDOUT_PARTS[band].label}</option>)}
        </select>}
      </div>}
      <div className="picker-filters">
        <input type="search" aria-label="搜索" value={keyword} onChange={(event) => { setKeyword(event.target.value); setLimit(PAGE_SIZE); }} placeholder={temporary ? "搜索临时题目、知识点、文件名" : "搜索四位 ID（全库）、题干、知识点"} />
        {temporary ? <select aria-label="来源文件" value={fileName} onChange={(event) => { setFileName(event.target.value); setLimit(PAGE_SIZE); }}><option value="">全部来源文件</option>{[...new Set(temporaryQuestions.map((question) => question.importFileName).filter(Boolean))].map((name) => <option key={name}>{name}</option>)}</select> : <select aria-label="模块" value={activeModuleId} onChange={(event) => { setModuleId(event.target.value); setCategoryId(""); setLimit(PAGE_SIZE); }}>{modules.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}
        <select aria-label="题型" value={type} onChange={(event) => { setType(event.target.value as "全部" | QuestionType); setLimit(PAGE_SIZE); }}><option value="全部">全部题型</option>{QUESTION_TYPES.map((item) => <option key={item}>{item}</option>)}</select>
      </div>
      <div className="picker-results">
      {temporary && !temporaryQuestions.length ? <div className="picker-empty"><b>导入外部题目，开始编撰</b><p>支持 Word（.docx）、PDF 和图片。</p><p>先校对再选题，不自动加入正式题库。</p><button className="secondary" onClick={onImport}>导入文件</button></div> : !library && !temporary ? <p className="picker-empty">正在读取题库…</p> : !modules.length && !temporary ? <p className="picker-empty">题库还没有模块。</p> : !results.length ? <p className="picker-empty">没有符合条件的题目。</p> : <>
        <p className="picker-count">共 {results.length} 道</p>
        <ol className="picker-list">{results.slice(0, limit).map((question, index) => {
          const inHandout = taken.has(question.id); const chosen = isSelected(question.id); const elsewhere = usedIn.get(question.id);
          return <li key={question.id} className={`picker-item${chosen ? " chosen" : ""}`}>
            <QuestionBody question={question} number={index + 1} />
            <div className="picker-item-foot"><small>{question.code && `ID ${question.code} · `}{question.type} · {question.difficulty} · {temporary ? question.importFileName || "临时录入" : pathOf(question.categoryId)}</small>
              {elsewhere && !inHandout && <span className="picker-taken">{[...elsewhere].join("、")}已用</span>}
              {inHandout ? <span className="picker-taken">已在{list ?? "讲义"}中</span> : replacing
                ? <button className="secondary" onClick={() => onPick([question.id])}>换成这道</button>
                : <button className={chosen ? "picker-toggle on" : "picker-toggle"} aria-pressed={chosen} onClick={() => toggle(question.id)}>{chosen ? "✓ 已选" : "＋ 选择"}</button>}
            </div>
            {temporary && <div className="picker-archive-item"><label><input type="checkbox" aria-label={`第 ${index + 1} 题存入正式题库`} checked={archived.has(question.id) || archiveIds.includes(question.id)} disabled={archived.has(question.id) || archiving} onChange={(event) => setArchiveIds((ids) => event.target.checked ? [...ids, question.id] : ids.filter((id) => id !== question.id))} />{archived.has(question.id) ? "已存入正式题库" : "存入正式题库"}</label><button className="text-button" onClick={() => onEdit(question)}>校对</button><button className="text-button" onClick={() => onRemove(question.id)}>删除</button></div>}
          </li>;
        })}</ol>
        {results.length > limit && <button className="secondary picker-more" onClick={() => setLimit((current) => current + PAGE_SIZE)}>再显示 {Math.min(PAGE_SIZE, results.length - limit)} 道</button>}
      </>}
      </div>
      {temporary && !!pendingArchive.length && <div className="picker-archive"><select aria-label="入库分类" value={archiveCategory} disabled={archiving} onChange={(event) => setArchiveCategory(event.target.value)}><option value="">选择正式题库分类</option>{modules.map((module) => <optgroup key={module.id} label={module.name}><option value={module.id}>{module.name}（根目录）</option>{categories.filter((category) => category.moduleId === module.id).map((category) => <option value={category.id} key={category.id}>{pathOf(category.id)}</option>)}</optgroup>)}</select><button className="secondary" disabled={!archiveCategory || archiving} onClick={async () => { setArchiving(true); try { const saved = await onArchive(pendingArchive, archiveCategory); setArchiveIds((ids) => ids.filter((id) => !saved.includes(id))); } catch (error) { onNotice(error instanceof Error ? error.message : "入库失败，请重试"); } finally { setArchiving(false); } }}>{archiving ? "正在入库…" : `保存勾选 ${pendingArchive.length} 题`}</button></div>}
      {mode.kind === "add" && <div className="picker-actions"><span>已选 {availableSelection.length} 道</span><button className="text-button" disabled={!availableSelection.length} onClick={() => setSelected([])}>清空选择</button><button className="primary-button" disabled={!availableSelection.length || (!list && !mode.sectionId)} onClick={() => { onPick(availableSelection); setSelected([]); }}>加入{list ?? HANDOUT_PARTS[mode.band].label}</button></div>}
    </div>
  </section>;
}
