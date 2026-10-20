"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { CategoryTree } from "../../components/CategoryTree";
import { PaperCenter, PaperDirectory } from "../../components/PaperCenter";
import { QuestionBody } from "../../components/QuestionBody";
import { jobsApi } from "../../components/RecognitionJobs";
import { HANDOUT_BANDS, HANDOUT_PARTS, sheetLabel } from "../../../lib/handout-rules.mjs";
import { categoryDescendants, categoryPath, questionMatchesKeyword } from "../../../lib/library-tree";
import type { AuthUser, HandoutBand, HandoutSheet, LibraryData, PaperDetail, PaperFolder, Question, QuestionType } from "../../../lib/types";

export type PickerMode = { kind: "add"; sectionId: string | null; band: HandoutBand } | { kind: "replace"; itemId: string; label: string };

const QUESTION_TYPES: QuestionType[] = ["单选题", "多选题", "填空题", "判断题", "解答题"];
const PAGE_SIZE = 30;

function pickerPaperLocation() {
  const params = new URLSearchParams(window.location.search), view = params.get("view");
  return { view: view === "papers" || view === "paper" ? view : "modules" as "modules" | "papers" | "paper", id: params.get("paperId") ?? "", folder: params.get("folder") ?? "", returnId: params.get("returnPaper") ?? "" };
}

// The same bank stays open while adding to different lanes or replacing a question.
// For a 小测 or 作业 the chosen module is the one the new questions test, and there is no band to choose.
// taken: already in the open sheet, so not offered again; usedIn: where else in this 讲 a question is used.
export function QuestionPicker({ library, user, onLibraryChanged, treeOpen, onTreeOpenChange: setTreeOpen, mode, sheet, taken, usedIn, onPick, sections, onModeChange, source, onSourceChange, temporaryQuestions, onImport, onArchive, onEdit, onRemove, onNotice }: {
  library: LibraryData | null;
  user: AuthUser;
  onLibraryChanged: () => Promise<void>;
  treeOpen: boolean;
  onTreeOpenChange: (open: boolean) => void;
  mode: PickerMode;
  sheet: HandoutSheet;
  taken: Set<string>;
  usedIn: Map<string, Set<string>>;
  onPick: (questionIds: string[]) => void;
  sections: { id: string; label: string }[];
  onModeChange: (mode: PickerMode | null) => void;
  source: "library" | "temporary";
  onSourceChange: (source: "library" | "temporary") => void;
  temporaryQuestions: Question[];
  onImport: () => void;
  onArchive: (ids: string[], categoryId: string) => Promise<string[]>;
  onEdit: (question: Question) => void;
  onRemove: (id: string) => void;
  onNotice: (message: string, tone?: "success" | "error") => void;
}) {
  const replacing = mode.kind === "replace";
  const list = sheet === "handout" ? null : sheetLabel(sheet);
  const [scope, setScope] = useState<{ moduleId: string; categoryId: string }>(() => {
    try { const value = JSON.parse(localStorage.getItem("mathpilot-picker-scope") || "{}"); return { moduleId: typeof value.moduleId === "string" ? value.moduleId : "", categoryId: typeof value.categoryId === "string" ? value.categoryId : "" }; } catch { return { moduleId: "", categoryId: "" }; }
  });
  const [paperLocation, setPaperLocation] = useState(pickerPaperLocation);
  const [paperVisited, setPaperVisited] = useState(paperLocation.view !== "modules");
  const [paperFolders, setPaperFolders] = useState<PaperFolder[]>([]);
  const [paperRefresh, setPaperRefresh] = useState(0);
  const [activePaper, setActivePaper] = useState<PaperDetail | null>(null);
  const [paperError, setPaperError] = useState("");
  const [paperFlipping, setPaperFlipping] = useState(false);
  const target = useRef<HTMLDivElement>(null);
  const resultsPane = useRef<HTMLDivElement>(null);
  const sourceRef = useRef(source);
  useEffect(() => { sourceRef.current = source; }, [source]);
  useEffect(() => {
    const pop = () => { const next = pickerPaperLocation(); setPaperLocation(next); setActivePaper(null); setPaperError(""); if (next.view !== "modules") setPaperVisited(true); onSourceChange("library"); resultsPane.current?.scrollTo({ top: 0, behavior: "instant" }); };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [onSourceChange]);
  useEffect(() => {
    if (!paperVisited) return;
    const controller = new AbortController();
    void jobsApi<{ folders: PaperFolder[] }>("/api/paper-folders", { signal: controller.signal }).then(({ folders }) => { setPaperFolders(folders); setPaperError(""); }).catch(error => { if (!controller.signal.aborted) setPaperError(error instanceof Error ? error.message : "目录读取失败"); });
    return () => controller.abort();
  }, [paperVisited, paperRefresh]);
  useEffect(() => {
    if (paperLocation.view !== "paper" || !paperLocation.id) return;
    const controller = new AbortController();
    void Promise.all([jobsApi<{ paper: PaperDetail }>(`/api/papers/${paperLocation.id}`, { signal: controller.signal }), onLibraryChanged()]).then(([{ paper }]) => {
      if (controller.signal.aborted) return;
      setActivePaper(paper); setPaperError("");
      const first = paper.items.find(item => item.question)?.question;
      if (first?.moduleId) setScope({ moduleId: first.moduleId, categoryId: "" });
    }).catch(error => { if (!controller.signal.aborted) setPaperError(error instanceof Error ? error.message : "试卷读取失败"); });
    return () => controller.abort();
  }, [paperLocation.view, paperLocation.id, paperRefresh, onLibraryChanged]);
  useEffect(() => {
    if (!paperFlipping) return;
    const timer = setTimeout(() => setPaperFlipping(false), 540);
    return () => clearTimeout(timer);
  }, [paperFlipping]);
  useEffect(() => {
    const wide = matchMedia("(min-width:1680px)");
    const update = () => setTreeOpen(wide.matches);
    update(); wide.addEventListener("change", update);
    return () => wide.removeEventListener("change", update);
  }, [setTreeOpen]);
  const [type, setType] = useState<"全部" | QuestionType>("全部");
  const [keyword, setKeyword] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<string[]>([]);
  const [archiveIds, setArchiveIds] = useState<string[]>([]);
  const [archiveCategory, setArchiveCategory] = useState("");
  const [archiving, setArchiving] = useState(false);
  const [fileName, setFileName] = useState("");
  const temporary = source === "temporary";
  const papersOpen = !temporary && paperLocation.view === "papers";
  const paperOpen = !temporary && paperLocation.view === "paper";

  const modules = library?.modules ?? [];
  const categories = library?.categories ?? [];
  const activeModule = modules.find((item) => item.id === scope.moduleId) ?? modules[0] ?? null;
  const activeModuleId = activeModule?.id ?? "";
  const moduleCategories = categories.filter((item) => item.moduleId === activeModuleId);
  const activeCategoryId = moduleCategories.some((item) => item.id === scope.categoryId) ? scope.categoryId : "";
  const allowed = activeCategoryId ? new Set(categoryDescendants(categories, activeCategoryId)) : null;
  useEffect(() => {
    if (!library || !activeModuleId) return;
    try { localStorage.setItem("mathpilot-picker-scope", JSON.stringify({ moduleId: activeModuleId, categoryId: activeCategoryId })); } catch { /* Storage may be unavailable; keep this session's selection. */ }
  }, [library, activeModuleId, activeCategoryId]);
  const targetLabel = mode.kind === "add" ? sections.find(section => section.id === mode.sectionId)?.label || "请先添加知识模块" : "";
  const targetKey = mode.kind === "replace" ? mode.itemId : `${sheet}|${mode.sectionId}|${mode.band}`;
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion:reduce)").matches) return;
    target.current?.querySelector("header")?.animate([{ backgroundColor: "var(--green-soft)", boxShadow: "inset 0 0 0 2px var(--green)" }, { backgroundColor: "var(--green-soft)", boxShadow: "inset 0 0 0 2px transparent" }], { duration: 900 });
  }, [targetKey]);
  const pathOf = (id: string) => categoryPath(modules, categories, id);
  const moduleQuestions = (library?.questions ?? []).filter((question) => question.moduleId === activeModuleId);
  const countFor = (id: string) => {
    if (modules.some(module => module.id === id)) return (library?.questions ?? []).filter(question => question.moduleId === id).length;
    const ids = categoryDescendants(categories, id);
    return (library?.questions ?? []).filter((question) => ids.includes(question.categoryId)).length;
  };
  const search = keyword.trim().toLowerCase();
  const byCode = library?.questions.find((question) => question.code === search);
  const results = temporary ? temporaryQuestions.filter((question) => (!fileName || question.importFileName === fileName)
    && (type === "全部" || question.type === type) && (!search || questionMatchesKeyword(question, search, question.importFileName ?? ""))) : byCode ? [byCode] : moduleQuestions.filter((question) => (!allowed || allowed.has(question.categoryId))
    && (!search || questionMatchesKeyword(question, search, pathOf(question.categoryId))));
  const visibleIds = new Set((temporary ? temporaryQuestions : library?.questions ?? []).map((question) => question.id));
  const archived = new Set((library?.questions ?? []).map((question) => question.id));
  const availableSelection = selected.filter((id) => visibleIds.has(id) && !taken.has(id));
  const pendingArchive = archiveIds.filter((id) => visibleIds.has(id) && !archived.has(id));
  const isSelected = (id: string) => availableSelection.includes(id);

  function toggle(id: string) { setSelected((current) => isSelected(id) ? current.filter((item) => item !== id) : [...current, id]); }

  function toggleTree(open: boolean) {
    setTreeOpen(open);
    requestAnimationFrame(() => {
      const bank = resultsPane.current?.closest(".handout-bank");
      bank?.querySelector<HTMLButtonElement>(open
        ? temporary ? ".picker-tree > header .icon-button" : ".picker-directory-face:not([aria-hidden='true']) > header .icon-button"
        : ".picker-tree-toggle")?.focus({ preventScroll: true });
    });
  }

  function navigatePapers(view: "modules" | "papers" | "paper", id = "", folder = paperLocation.folder, returnId = paperLocation.returnId) {
    if ((view === "papers") !== (paperLocation.view === "papers")) setPaperFlipping(!matchMedia("(prefers-reduced-motion: reduce)").matches);
    setPaperLocation({ view, id, folder, returnId }); setPaperError(""); setLimit(PAGE_SIZE);
    resultsPane.current?.scrollTo({ top: 0, behavior: "instant" });
    if (id !== paperLocation.id) setActivePaper(null);
    if (view !== "modules") setPaperVisited(true);
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries({ view: view === "modules" ? "" : view, paperId: id, folder, returnPaper: returnId })) {
      if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
    }
    window.history.pushState(window.history.state, "", `${url.pathname}${url.search}`);
  }

  async function selectPaper(paper: PaperDetail) {
    try {
      await onLibraryChanged();
      if (sourceRef.current !== "library") return;
      const ids = [...new Set(paper.items.flatMap(item => item.question && !taken.has(item.questionId) ? [item.questionId] : []))];
      setSelected(current => [...new Set([...current, ...ids])]);
      onNotice(`已选中本卷 ${ids.length} 道可用题${paper.items.some(item => !item.question) ? "，不可用题目已跳过" : ""}`);
    } catch (error) { onNotice(error instanceof Error ? error.message : "选题失败，请重试", "error"); }
  }
  const displayed = paperOpen ? (activePaper?.items ?? []).map(item => ({ ...item, question: library?.questions.find(question => question.id === item.questionId) ?? null })) : results.map((question, index) => ({ questionId: question.id, number: String(index + 1), section: "", question }));

  return <section className={`handout-bank${treeOpen ? " with-tree" : ""}`} aria-label="题库选题" data-paper-flipping={paperFlipping || undefined}>
    <aside className="picker-tree" id="picker-directory" aria-label={papersOpen ? "试卷目录" : "知识目录"} inert={!treeOpen} aria-hidden={!treeOpen}>
      {temporary && <><header><h2>临时题库</h2><button className="icon-button" type="button" title="收起目录" aria-label="收起知识目录" aria-expanded={treeOpen} aria-controls="picker-directory" onClick={() => toggleTree(false)}>←</button></header><div className="picker-temporary-help"><p>仅用于当前讲义、小测和作业，随讲义保存。</p><p>刷新后仍保留；勾选「存入正式题库」后，可在其他讲义中复用。</p></div></>}
      <div className={`paper-directory-flip${papersOpen ? " is-papers" : ""}`} hidden={temporary}>
        <div className="picker-directory-face paper-directory-face paper-directory-front" inert={temporary || papersOpen} aria-hidden={temporary || papersOpen}>
          <header><h2>模块</h2><button type="button" className="paper-view-toggle" title="翻转到试卷中心" aria-label="切换到试卷中心" disabled={paperFlipping} onClick={() => navigatePapers("papers")}><span aria-hidden="true">⇄</span></button><button className="icon-button" type="button" title="收起目录" aria-label="收起知识目录" aria-expanded={treeOpen} aria-controls="picker-directory" onClick={() => toggleTree(false)}>←</button></header>
          <div className="picker-module-directory">{modules.map(module => <CategoryTree key={module.id} module={module} categories={categories} activeId={activeCategoryId || activeModuleId} countFor={countFor} collapsible onSelect={id => {
            if (paperOpen) { navigatePapers("modules", "", paperLocation.folder, paperLocation.id); setKeyword(""); }
            setScope({ moduleId: module.id, categoryId: id === module.id ? "" : id }); setLimit(PAGE_SIZE);
          }} />)}</div>
        </div>
        <div className="picker-directory-face paper-directory-face paper-directory-back" inert={!papersOpen} aria-hidden={!papersOpen}>
          <header><h2>试卷</h2><button type="button" className="paper-view-toggle" title="翻转到模块题库" aria-label="切换到模块题库" disabled={paperFlipping} onClick={() => navigatePapers("modules")}><span aria-hidden="true">⇄</span></button><button className="icon-button" type="button" title="收起目录" aria-label="收起试卷目录" aria-expanded={treeOpen} aria-controls="picker-directory" onClick={() => toggleTree(false)}>←</button></header>
          <PaperDirectory folders={paperFolders} selected={paperLocation.folder} user={user} onSelect={id => navigatePapers("papers", "", id)} onChanged={() => setPaperRefresh(value => value + 1)} onNotice={onNotice} />
        </div>
      </div>
    </aside>
    <div className="picker-main">
      <div className="picker-source"><button className="icon-button picker-tree-toggle" type="button" title="展开目录" aria-label={papersOpen ? "展开试卷目录" : "展开知识目录"} aria-expanded={treeOpen} aria-controls="picker-directory" aria-hidden={treeOpen} inert={treeOpen} tabIndex={treeOpen ? -1 : 0} onClick={() => toggleTree(true)}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M5 12h14m-7-7 7 7-7 7" /></svg></button><div className="handout-sheets" role="tablist" aria-label="选题来源">
        <button role="tab" aria-selected={!temporary} onClick={() => { onSourceChange("library"); setSelected([]); }}>正式题库</button>
        <button role="tab" aria-selected={temporary} onClick={() => { onSourceChange("temporary"); setSelected([]); }}>临时题库 <span>{temporaryQuestions.length}</span></button>
      </div>{temporary && <button className="secondary" onClick={onImport}>导入文件</button>}</div>
      {mode.kind === "replace" ? <div className="picker-replacing"><strong>{mode.label} · 选一道题替换</strong><button className="text-button" onClick={() => onModeChange(null)}>取消替换</button></div> : <div ref={target} className={`picker-target${list ? " list" : ""}`}>
        <header><span>{list ? `加入${list}，考查` : "加入到"} <b title={targetLabel}>{targetLabel.split(" · ")[0]}{!list && ` · ${HANDOUT_PARTS[mode.band].label}`}</b></span></header>
        <div className="picker-target-fields">
        <select aria-label={list ? "考查模块" : "加入模块"} value={mode.sectionId ?? ""} onChange={(event) => onModeChange({ ...mode, sectionId: event.target.value })} disabled={!sections.length}>
          {!sections.length && <option value="">{list ? "讲义还没有知识模块" : "请先添加知识模块"}</option>}
          {sections.map((section) => <option key={section.id} value={section.id}>{section.label}</option>)}
        </select>
        {!list && <select aria-label="题目用途" value={mode.band} onChange={(event) => onModeChange({ ...mode, band: event.target.value as HandoutBand })}>
          {HANDOUT_BANDS.map((band) => <option key={band} value={band}>作为{HANDOUT_PARTS[band].label}</option>)}
        </select>}
        </div>
      </div>}
      <div className="picker-filters" hidden={papersOpen || paperOpen}>
        <input type="search" aria-label="搜索" value={keyword} onChange={(event) => { setKeyword(event.target.value); setLimit(PAGE_SIZE); }} placeholder={temporary ? "搜索临时题目、知识点、文件名" : "搜索四位 ID（全库）、题干、知识点"} />
        {temporary && <>
          <select aria-label="来源文件" value={fileName} onChange={(event) => { setFileName(event.target.value); setLimit(PAGE_SIZE); }}><option value="">全部来源文件</option>{[...new Set(temporaryQuestions.map((question) => question.importFileName).filter(Boolean))].map((name) => <option key={name}>{name}</option>)}</select>
          <select aria-label="题型" value={type} onChange={(event) => { setType(event.target.value as "全部" | QuestionType); setLimit(PAGE_SIZE); }}><option value="全部">全部题型</option>{QUESTION_TYPES.map((item) => <option key={item}>{item}</option>)}</select>
        </>}
      </div>
      <div className="picker-results" ref={resultsPane}>
      {paperVisited && <div className="picker-paper-center" hidden={!papersOpen} inert={!papersOpen}><PaperCenter folderId={paperLocation.folder} folders={paperFolders} refresh={paperRefresh} user={user} modules={modules} onOpen={id => navigatePapers("paper", id)} onAdd={replacing ? undefined : selectPaper} addLabel="整卷选择" onNotice={onNotice} onFolders={setPaperFolders} onLibraryChanged={() => void onLibraryChanged().catch(error => onNotice(error instanceof Error ? error.message : "题库更新失败", "error"))} /></div>}
      {paperOpen && <header className="paper-detail-header"><button className="text-button" onClick={() => navigatePapers("papers")}>← 试卷中心</button><h1>{activePaper?.title || (paperError ? "试卷暂不可用" : "正在读取试卷…")}</h1>{activePaper && <div className="paper-detail-actions"><span>{activePaper.items.length} 题</span>{!replacing && <button onClick={() => void selectPaper(activePaper)}>整卷选择</button>}<a href={`/api/papers/${activePaper.id}?source=1`}>下载原件</a></div>}</header>}
      {!temporary && paperError && <p className="paper-error" role="alert">{paperError}<button onClick={() => setPaperRefresh(value => value + 1)}>重试</button></p>}
      {!temporary && !papersOpen && !paperOpen && paperLocation.returnId && <div className="paper-return"><button className="text-button" onClick={() => navigatePapers("paper", paperLocation.returnId)}>← 返回刚才的试卷</button></div>}
      {papersOpen ? null : temporary && !temporaryQuestions.length ? <div className="picker-empty"><b>导入外部题目，开始编撰</b><p>支持 Word（.docx）、PDF 和图片。</p><p>先校对再选题，不自动加入正式题库。</p><button className="secondary" onClick={onImport}>导入文件</button></div> : paperOpen && !activePaper ? null : !library && !temporary ? <p className="picker-empty">正在读取题库…</p> : !modules.length && !temporary && !paperOpen ? <p className="picker-empty">题库还没有模块。</p> : !displayed.length ? <p className="picker-empty">没有符合条件的题目。</p> : <>
        <p className="picker-count">共 {displayed.length} 道</p>
        <ol className="picker-list">{displayed.slice(0, paperOpen ? displayed.length : limit).map((item, index) => {
          const question = item.question;
          const section = item.section && item.section !== displayed[index - 1]?.section ? <li className="picker-paper-section"><h3>{item.section}</h3></li> : null;
          if (!question) return <Fragment key={`${index}-${item.questionId}`}>{section}<li className="paper-missing">第 {item.number} 题已移入回收站或不再可用。原题位仍保留。</li></Fragment>;
          const inHandout = taken.has(question.id); const chosen = isSelected(question.id); const elsewhere = usedIn.get(question.id);
          return <Fragment key={`${index}-${question.id}`}>{section}<li className={`picker-item${chosen ? " chosen" : ""}`}>
            <QuestionBody question={question} number={item.number} />
            <div className="picker-item-foot"><small>{question.code && `ID ${question.code} · `}{question.type} · {question.difficulty} · {temporary ? question.importFileName || "临时录入" : pathOf(question.categoryId)}</small>
              {elsewhere && !inHandout && <span className="picker-taken">{[...elsewhere].join("、")}已用</span>}
              {inHandout ? <span className="picker-taken">已在{list ?? "讲义"}中</span> : replacing
                ? <button className="secondary" onClick={() => onPick([question.id])}>换成这道</button>
                : <button className={chosen ? "picker-toggle on" : "picker-toggle"} aria-pressed={chosen} onClick={() => toggle(question.id)}>{chosen ? "✓ 已选" : "＋ 选择"}</button>}
            </div>
            {temporary && <div className="picker-archive-item"><label><input type="checkbox" aria-label={`第 ${index + 1} 题存入正式题库`} checked={archived.has(question.id) || archiveIds.includes(question.id)} disabled={archived.has(question.id) || archiving} onChange={(event) => setArchiveIds((ids) => event.target.checked ? [...ids, question.id] : ids.filter((id) => id !== question.id))} />{archived.has(question.id) ? "已存入正式题库" : "存入正式题库"}</label><button className="text-button" onClick={() => onEdit(question)}>校对</button><button className="text-button" onClick={() => onRemove(question.id)}>删除</button></div>}
          </li></Fragment>;
        })}</ol>
        {!paperOpen && results.length > limit && <button className="secondary picker-more" onClick={() => setLimit((current) => current + PAGE_SIZE)}>再显示 {Math.min(PAGE_SIZE, results.length - limit)} 道</button>}
      </>}
      </div>
      {temporary && !!pendingArchive.length && <div className="picker-archive"><select aria-label="入库分类" value={archiveCategory} disabled={archiving} onChange={(event) => setArchiveCategory(event.target.value)}><option value="">选择正式题库分类</option>{modules.map((module) => <optgroup key={module.id} label={module.name}><option value={module.id}>{module.name}（根目录）</option>{categories.filter((category) => category.moduleId === module.id).map((category) => <option value={category.id} key={category.id}>{pathOf(category.id)}</option>)}</optgroup>)}</select><button className="secondary" disabled={!archiveCategory || archiving} onClick={async () => { setArchiving(true); try { const saved = await onArchive(pendingArchive, archiveCategory); setArchiveIds((ids) => ids.filter((id) => !saved.includes(id))); } catch (error) { onNotice(error instanceof Error ? error.message : "入库失败，请重试", "error"); } finally { setArchiving(false); } }}>{archiving ? "正在入库…" : `保存勾选 ${pendingArchive.length} 题`}</button></div>}
      {mode.kind === "add" && <div className="picker-actions"><span>已选 {availableSelection.length} 道</span><button className="text-button" disabled={!availableSelection.length} onClick={() => setSelected([])}>清空选择</button><button className="secondary" disabled={!availableSelection.length || (!list && !mode.sectionId)} onClick={() => { onPick(availableSelection); setSelected([]); }}>加入{list ?? HANDOUT_PARTS[mode.band].label}</button></div>}
    </div>
  </section>;
}
