"use client";

/* eslint-disable @next/next/no-html-link-for-pages -- vinext beta currently breaks next/link RSC prefetch on these client-only pages. */

import "./knowledge-graph.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { homeworkApi } from "../../lib/homework-api-client";
import { knowledgeGraphApi } from "../../lib/knowledge-graph-api-client";
import {
  createKnowledgeGraphIndex, diagnoseKnowledgeGaps, diffKnowledgeGraphs, layoutKnowledgeChain, layoutKnowledgeFunnel, validateKnowledgeGraph,
  type KnowledgeGraphFunnel, type KnowledgeGraphIndex,
} from "../../lib/knowledge-graph-core.mjs";
import { addKnowledgeEdge, addKnowledgeNode, restoreKnowledgeNode } from "../../lib/knowledge-graph-edit.mjs";
import type { AuthUser, KnowledgeGraphDocument, KnowledgeGraphLevel, KnowledgeGraphOverview, StudentSummary } from "../../lib/types";
import GraphCloud, { type CloudCommand, type CloudTip } from "../components/knowledge-graph/GraphCloud";
import { HistoryDrawer, ImportDialog, PublishDialog } from "../components/knowledge-graph/GraphDialogs";
import GraphLegend from "../components/knowledge-graph/GraphLegend";
import GraphOutline from "../components/knowledge-graph/GraphOutline";
import GraphSearch from "../components/knowledge-graph/GraphSearch";
import NodeCard from "../components/knowledge-graph/NodeCard";
import NodeEditor, { type ApplyEdit } from "../components/knowledge-graph/NodeEditor";
import StudentDiagnosis from "../components/knowledge-graph/StudentDiagnosis";
import { STATUS_META, buildChainView, buildCloudView, buildHighlight, learningStatus, stageName, type GraphFilters, type GraphSelection } from "../components/knowledge-graph/graph-model";
import { useGraphEditor } from "./use-graph-editor";

type Mode = "explore" | "edit";
type Notice = { tone: "info" | "success" | "error"; text: string } | null;
type Dialog = "" | "publish" | "history" | "import";
type SelectionView = "chain" | "cloud";

// Successors beyond this many are folded until the teacher asks for all of them.
const CHAIN_SUCCESSORS = 40;

const SAVE_LABEL = { idle: "与发布版一致", pending: "有未保存的改动", saving: "正在保存…", saved: "草稿已保存", error: "保存失败" } as const;

function downloadDocument(document: KnowledgeGraphDocument, version: number) {
  const blob = new Blob([JSON.stringify(document, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob); const link = window.document.createElement("a");
  link.href = url; link.download = version ? `${document.graphId}-v${version}.json` : `${document.graphId}-draft.json`; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// The funnel only depends on structure; typing a name or a description must not re-run the layout.
let cachedLayout: { key: string; funnel: KnowledgeGraphFunnel } | null = null;
function layoutFor(index: KnowledgeGraphIndex) {
  let key = JSON.stringify(index.document.stages);
  for (const node of index.document.nodes) {
    key += `${node.key}|${node.level}|${node.parentKey ?? ""}|${node.domainKey}|${node.stage}|${node.order}|${node.status}|${node.color ?? ""}|${node.level === "domain" ? node.label : ""};`;
  }
  for (const edge of index.document.edges) key += `${edge.sourceKey}>${edge.targetKey};`;
  if (cachedLayout?.key !== key) cachedLayout = { key, funnel: layoutKnowledgeFunnel(index.document, { index }) };
  return cachedLayout.funnel;
}

export default function KnowledgeGraphPage() {
  const shellRef = useRef<HTMLElement>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState<KnowledgeGraphOverview | null>(null);
  const [students, setStudents] = useState<StudentSummary[]>([]);
  const [studentId, setStudentId] = useState("");
  const [profileLoading, setProfileLoading] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [mode, setMode] = useState<Mode>("explore");
  const [selection, setSelection] = useState<GraphSelection>(null);
  const [trail, setTrail] = useState<string[]>([]);
  const [marked, setMarked] = useState<string[]>([]);
  const [filters, setFilters] = useState<GraphFilters>({ stage: "all", hiddenDomains: [], evidenceOnly: false });
  const [command, setCommand] = useState<CloudCommand | null>(null);
  const [canvasError, setCanvasError] = useState("");
  const [linkMode, setLinkMode] = useState(false);
  const [linkSource, setLinkSource] = useState("");
  const [autoFocusKey, setAutoFocusKey] = useState("");
  const [dialog, setDialog] = useState<Dialog>("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectionView, setSelectionView] = useState<SelectionView>("chain");
  const [chainAll, setChainAll] = useState(false);

  const showNotice = useCallback((text: string, tone: "info" | "success" | "error" = "info") => setNotice({ text, tone }), []);
  const editor = useGraphEditor(mode === "edit", useCallback((message: string) => showNotice(`${message}，已重新载入最新草稿`, "error"), [showNotice]));

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      void homeworkApi.me().then(async ({ user: currentUser }) => {
        setUser(currentUser);
        if (!currentUser) return;
        const [studentData, graphData] = await Promise.all([homeworkApi.students().catch(() => ({ students: [] as StudentSummary[] })), knowledgeGraphApi.overview()]);
        setStudents(studentData.students); setOverview(graphData);
      }).catch((error) => showNotice(error instanceof Error ? error.message : "知识图谱读取失败", "error")).finally(() => setLoading(false));
    });
    return () => cancelAnimationFrame(frame);
  }, [showNotice]);

  useEffect(() => {
    if (!notice || notice.tone === "error") return;
    const timer = window.setTimeout(() => setNotice(null), 4200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const editing = mode === "edit" && Boolean(editor.session);
  const published = editing ? editor.session!.published : overview?.graph ?? null;
  const graphDocument = editing ? editor.session!.document : overview?.graph.document ?? null;
  const version = published?.version ?? 1;
  const index = useMemo(() => graphDocument ? createKnowledgeGraphIndex(graphDocument, { version }) : null, [graphDocument, version]);
  const funnel = useMemo(() => index ? layoutFor(index) : null, [index]);
  const profile = useMemo(() => studentId && overview && !editing ? new Map(overview.profile.nodes.map((node) => [node.key, node])) : null, [editing, overview, studentId]);
  const diagnosis = useMemo(() => profile && index ? diagnoseKnowledgeGaps(index, [...profile.values()]) : null, [index, profile]);
  const skills = useMemo(() => profile ? [...profile.values()].filter((node) => node.dimension === "skill") : [], [profile]);
  const issues = useMemo(() => editing && graphDocument && published ? validateKnowledgeGraph(graphDocument, { previous: published.document }).errors : [], [editing, graphDocument, published]);
  const issueKeys = useMemo(() => new Set(issues.flatMap((issue) => [issue.nodeKey, issue.sourceKey, issue.targetKey, ...(issue.cycle ?? [])].filter((key): key is string => Boolean(key)))), [issues]);
  const diff = useMemo(() => editing && graphDocument && published ? diffKnowledgeGraphs(published.document, graphDocument) : null, [editing, graphDocument, published]);
  const publishedKeys = useMemo(() => new Set(published?.document.nodes.map((node) => node.key) ?? []), [published]);
  const archived = useMemo(() => graphDocument?.nodes.filter((node) => node.status === "archived") ?? [], [graphDocument]);
  const view = useMemo(() => index && funnel ? buildCloudView({ index, funnel, filters, profile }) : null, [filters, funnel, index, profile]);
  const activeSelection = useMemo<GraphSelection>(() => {
    if (!selection || !index) return null;
    if (selection.kind === "domain") return index.domains.some((domain) => domain.key === selection.key) ? selection : null;
    return index.activeKeys.has(selection.key) ? selection : null;
  }, [index, selection]);
  const selectedKey = activeSelection?.kind === "node" ? activeSelection.key : "";
  const highlight = useMemo(() => view && index ? buildHighlight({ view, index, selectedKey, marked, linkSourceKey: linkMode ? linkSource : "" }) : null,
    [index, linkMode, linkSource, marked, selectedKey, view]);
  // Browsing a selection spreads its whole chain out in front of the viewer instead of highlighting it inside the funnel.
  const chainMode = mode === "explore" && selectionView === "chain" && Boolean(selectedKey);
  const chain = useMemo(() => chainMode && index ? layoutKnowledgeChain(index, selectedKey, { descendantLimit: chainAll ? Infinity : CHAIN_SUCCESSORS }) : null,
    [chainAll, chainMode, index, selectedKey]);
  const cloudChain = useMemo(() => view ? buildChainView(view, chain) : null, [chain, view]);
  const student = students.find((item) => item.id === studentId) ?? null;
  const labelOf = useCallback((key: string) => index?.nodeByKey.get(key)?.label ?? key, [index]);
  const colorOf = useCallback((key: string) => {
    const node = index?.nodeByKey.get(key);
    return funnel?.colors.get(key) ?? (node ? index?.nodeByKey.get(node.domainKey)?.color : undefined) ?? "#8a94a6";
  }, [funnel, index]);

  const focusOn = useCallback((key: string) => {
    const position = view?.indexOf.get(key);
    if (position !== undefined) setCommand({ kind: "focus", index: position, token: Date.now() });
  }, [view]);

  const openNode = useCallback((key: string, options: { push?: boolean; focus?: boolean } = {}) => {
    if (options.push !== false && activeSelection?.kind === "node" && activeSelection.key !== key) setTrail((items) => [...items, activeSelection.key].slice(-40));
    setSelection({ kind: "node", key }); setMarked([]); setAutoFocusKey(""); setChainAll(false);
    // The chain view lays itself out; only the funnel view needs the camera turned toward the node.
    if (options.focus !== false && (mode === "edit" || selectionView === "cloud")) focusOn(key);
  }, [activeSelection, focusOn, mode, selectionView]);

  const chooseSelectionView = useCallback((next: SelectionView) => {
    setSelectionView(next);
    if (next === "cloud" && selectedKey) focusOn(selectedKey);
  }, [focusOn, selectedKey]);

  const closeNode = useCallback(() => {
    setSelection(null); setTrail([]); setCommand({ kind: "reset", token: Date.now() });
  }, []);

  const goBack = useCallback(() => {
    const previous = trail[trail.length - 1]; if (!previous) return;
    setTrail(trail.slice(0, -1)); openNode(previous, { push: false });
  }, [openNode, trail]);

  const applyEdit: ApplyEdit = useCallback((next, options) => {
    editor.apply(next, options?.coalesce);
    if (options && "select" in options) setSelection(options.select ?? null);
  }, [editor]);

  const handlePick = useCallback((position: number) => {
    const key = position >= 0 ? view?.keys[position] ?? "" : "";
    if (linkMode && editing && editor.session) {
      if (!key) { setLinkSource(""); return; }
      if (!linkSource) { setLinkSource(key); return; }
      if (key === linkSource) { setLinkSource(""); return; }
      try {
        applyEdit(addKnowledgeEdge(editor.session.document, linkSource, key), { select: { kind: "node", key } });
        showNotice(`已连接：${labelOf(linkSource)} → ${labelOf(key)}（前置，可在右侧改为支撑）`, "success");
      } catch (error) { showNotice(error instanceof Error ? error.message : "无法添加关系", "error"); }
      setLinkSource(""); return;
    }
    if (!key) { if (activeSelection) closeNode(); return; }
    openNode(key);
  }, [activeSelection, applyEdit, closeNode, editing, editor.session, labelOf, linkMode, linkSource, openNode, showNotice, view]);

  const describe = useCallback((position: number): CloudTip | null => {
    const key = view?.keys[position]; const node = key ? index?.nodeByKey.get(key) : null;
    if (!index || !view || !node) return null;
    const parent = node.level === "point" ? index.nodeByKey.get(node.parentKey ?? "") : null;
    const status = profile ? learningStatus(profile.get(node.key)) : null;
    const evidence = profile?.get(node.key)?.evidenceCount ?? 0;
    return {
      title: node.label, color: view.model.nodes[position].color,
      meta: `${parent?.label ?? index.nodeByKey.get(node.domainKey)?.label ?? ""} · ${stageName(index, node.stage)}`,
      detail: status ? `${STATUS_META[status].label}${evidence ? ` · ${evidence} 条证据` : ""}` : node.mastery || node.description,
    };
  }, [index, profile, view]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const typing = event.target instanceof HTMLElement && (event.target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName));
      if (event.key === "Escape" && !typing) {
        if (dialog) setDialog(""); else if (menuOpen) setMenuOpen(false); else if (linkMode) { setLinkMode(false); setLinkSource(""); } else if (activeSelection) closeNode();
      }
      if (editing && !typing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault(); if (event.shiftKey) editor.redo(); else editor.undo();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeSelection, closeNode, dialog, editing, editor, linkMode, menuOpen]);

  async function reloadOverview(nextStudentId = studentId) {
    setProfileLoading(true);
    try { setOverview(await knowledgeGraphApi.overview(nextStudentId)); }
    catch (error) { showNotice(error instanceof Error ? error.message : "知识图谱读取失败", "error"); }
    finally { setProfileLoading(false); }
  }

  function chooseStudent(nextStudentId: string) {
    setStudentId(nextStudentId); setFilters((current) => ({ ...current, evidenceOnly: false }));
    void reloadOverview(nextStudentId);
  }

  function chooseMode(next: Mode) {
    if (next === mode) return;
    if (next === "explore") void editor.flush();
    setMode(next); setLinkMode(false); setLinkSource(""); setMenuOpen(false); setTrail([]); setMarked([]);
  }

  function addNode(level: KnowledgeGraphLevel) {
    if (!editor.session || !index) return;
    const current = activeSelection ? index.nodeByKey.get(activeSelection.key) : undefined;
    const domainKey = current?.level === "domain" ? current.key : current?.domainKey ?? index.domains.find((domain) => !filters.hiddenDomains.includes(domain.key))?.key;
    const parentKey = current?.level === "topic" ? current.key : current?.level === "point" ? current.parentKey : undefined;
    const stage = current && current.level !== "domain" ? current.stage : filters.stage !== "all" ? filters.stage : undefined;
    try {
      const result = addKnowledgeNode(editor.session.document, { level, domainKey, parentKey, stage });
      applyEdit(result.document, { select: { kind: level === "domain" ? "domain" : "node", key: result.key } });
      setAutoFocusKey(result.key);
    } catch (error) { showNotice(error instanceof Error ? error.message : "无法新增", "error"); }
  }

  function restoreNode(key: string) {
    if (!editor.session) return;
    try { applyEdit(restoreKnowledgeNode(editor.session.document, key), { select: { kind: "node", key } }); showNotice(`已恢复「${labelOf(key)}」`, "success"); }
    catch (error) { showNotice(error instanceof Error ? error.message : "无法恢复", "error"); }
  }

  function importDraft(document: KnowledgeGraphDocument) {
    applyEdit(document, { select: null }); setDialog(""); setTrail([]);
    const points = document.nodes.filter((node) => node.level === "point" && node.status !== "archived").length;
    showNotice(`已载入为草稿：${points} 个知识点、${document.edges.length} 条关系。审核无误后再发布`, "success");
  }

  async function publishDraft(note: string) {
    const result = await editor.publish(note);
    setDialog("");
    showNotice(result.unchanged ? "草稿与发布版一致，无需发布" : `已发布 v${result.version}：题库打标签与学情分析已使用新版本`, "success");
    await reloadOverview();
  }

  async function discardDraft() {
    setMenuOpen(false);
    if (!window.confirm("放弃当前草稿中的全部改动？此操作不能撤销。")) return;
    try { await editor.discard(); setSelection(null); showNotice("已放弃草稿，回到发布版", "success"); }
    catch (error) { showNotice(error instanceof Error ? error.message : "放弃草稿失败", "error"); }
  }

  if (loading) return <main className="kg-shell kg-loading"><p>正在打开知识图谱…</p></main>;
  if (!user) return <main className="kg-shell kg-loading"><h1>请先登录教师账号</h1><a href="/">返回题库登录</a></main>;

  const canEdit = Boolean(overview?.permissions.canEdit);
  const nextVersion = (editor.session?.published.version ?? version) + 1;
  const publishBlocked = !diff?.changed ? "还没有改动" : issues.length ? `还有 ${issues.length} 个问题` : "";
  const title = index?.document.title.replace(/\s*V\d+$/i, "") ?? "知识图谱";
  const heroName = title.replace(/知识图谱$/, "");
  const pointCount = index?.activeNodes.filter((node) => node.level === "point").length ?? 0;
  const topicCount = index?.activeNodes.filter((node) => node.level === "topic").length ?? 0;
  const sizeLabel = pointCount ? `${pointCount} 个知识点` : `${topicCount} 个主题`;
  const prerequisiteCount = index?.edges.filter((edge) => edge.relationship === "prerequisite").length ?? 0;
  const cardOpen = mode === "explore" && Boolean(selectedKey);

  return <main ref={shellRef} className={`kg-shell ${editing ? "is-editing" : ""} ${cardOpen ? "has-card" : ""} ${activeSelection ? "has-selection" : ""} ${cloudChain ? "has-chain" : ""}`}>
    {view && highlight && !canvasError && <GraphCloud model={view.model} highlight={highlight} chain={cloudChain} spin={mode === "explore" && !dialog} command={command} shellRef={shellRef}
      describe={describe} onPick={handlePick} onUnavailable={(message) => setCanvasError(message)} />}
    {canvasError && <p className="kg-canvas-error" role="alert">{canvasError}。可以用搜索和目录继续查看知识点。</p>}

    <header className="kg-top" data-inset="auto">
      <div className="kg-top-left">
        <a className="kg-brand" href="/" title="返回题库" aria-label="返回题库"><i aria-hidden="true">‹</i><span>题</span></a>
        <div className="kg-top-title"><b>{title}</b><small>{editing ? `编辑草稿 · 基于 v${version}` : sizeLabel}</small></div>
      </div>
      {!editing && index && <GraphSearch index={index} colorOf={colorOf} onPick={(key) => openNode(key)} onPreview={setMarked} />}
      <div className="kg-top-actions">
        {canEdit && <div className="kg-segment" role="tablist" aria-label="模式">
          <button type="button" role="tab" aria-selected={mode === "explore"} className={mode === "explore" ? "active" : ""} onClick={() => chooseMode("explore")}>浏览</button>
          <button type="button" role="tab" aria-selected={mode === "edit"} className={mode === "edit" ? "active" : ""} onClick={() => chooseMode("edit")}>编辑</button>
        </div>}
        {mode === "explore" ? <label className="kg-student">
          <span>学生</span>
          <select value={studentId} disabled={profileLoading} onChange={(event) => chooseStudent(event.target.value)} aria-label="叠加学生学情">
            <option value="">不叠加学情</option>
            {students.map((item) => <option key={item.id} value={item.id}>{item.name}{item.className ? ` · ${item.className}` : ""}</option>)}
          </select>
        </label> : editor.session && <>
          <span className={`kg-save-state ${editor.saveState}`} title={editor.saveError || undefined}>
            <i aria-hidden="true" />{SAVE_LABEL[editor.saveState]}{diff?.count ? ` · ${diff.count} 处改动` : ""}{issues.length ? <b> · {issues.length} 个问题</b> : null}
          </span>
          <div className="kg-history-buttons">
            <button type="button" className="kg-icon-button" aria-label="撤销" title="撤销（⌘Z）" disabled={!editor.canUndo} onClick={editor.undo}>↶</button>
            <button type="button" className="kg-icon-button" aria-label="重做" title="重做（⇧⌘Z）" disabled={!editor.canRedo} onClick={editor.redo}>↷</button>
          </div>
          <div className="kg-more-menu">
            <button type="button" className="kg-button" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}>更多</button>
            {menuOpen && <div className="kg-menu right" role="menu">
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setDialog("import"); }}>导入 JSON<small>把整理好的图谱文件载入为草稿</small></button>
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); downloadDocument(editor.session!.document, diff?.changed ? 0 : version); }}>导出 JSON<small>备份当前图谱数据</small></button>
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setDialog("history"); }}>版本记录<small>查看或载入历史版本</small></button>
              <button type="button" role="menuitem" className="danger" disabled={!diff?.changed} onClick={() => void discardDraft()}>放弃草稿<small>回到已发布的 v{version}</small></button>
            </div>}
          </div>
          <button type="button" className="kg-button primary" disabled={Boolean(publishBlocked)} title={publishBlocked || undefined} onClick={() => setDialog("publish")}>发布 v{nextVersion}</button>
        </>}
      </div>
    </header>

    {mode === "edit" && !editor.session && <div className="kg-edit-loading" role="status">{editor.loadError || "正在打开编辑草稿…"}</div>}

    {mode === "explore" && index && !studentId && !cardOpen && <section className="kg-hero" data-inset="auto">
      <h1>{heroName && <span>{heroName}</span>}<span>知识全景<span className="kg-red" aria-hidden="true">。</span></span></h1>
      <p className="kg-hero-lede"><span>{sizeLabel}按年级自下而上排列，</span><span>{prerequisiteCount} 条连线标出学习先后。</span><span>点任一圆点，看它要先学什么、接着能学什么。</span></p>
      <p className="kg-hero-meta">v{version} · {published?.publishedAt ? `发布于 ${new Date(published.publishedAt).toLocaleDateString("zh-CN")}` : "初始课程骨架"}</p>
    </section>}

    {mode === "explore" && index && diagnosis && student && <StudentDiagnosis studentName={student.name} diagnosis={diagnosis} index={index} skills={skills} onSelect={(key) => openNode(key)} />}

    {cardOpen && index && <NodeCard index={index} nodeKey={selectedKey} colorOf={colorOf} profile={profile} coverage={overview?.coverage ?? null} studentName={student?.name ?? ""}
      canGoBack={trail.length > 0} onBack={goBack} onClose={closeNode} onSelect={(key) => openNode(key)}
      view={selectionView} onView={chooseSelectionView}
      successors={chain ? { shown: chain.descendants.shown, total: chain.descendants.total, all: chainAll } : null} onAllSuccessors={setChainAll} />}

    {editing && index && <>
      <aside className="kg-panel kg-outline-panel" aria-label="知识目录" data-inset="auto">
        <GraphOutline index={index} selection={activeSelection} colorOf={colorOf} onSelect={(next) => next?.kind === "node" ? openNode(next.key) : setSelection(next)}
          issueKeys={issueKeys} archived={archived} onAdd={addNode} onRestore={restoreNode} />
      </aside>
      <aside className="kg-panel kg-editor-panel" aria-label="编辑知识点" data-inset="auto">
        <NodeEditor key={activeSelection?.key ?? "none"} document={graphDocument!} index={index} selection={activeSelection} publishedKeys={publishedKeys} issues={issues}
          autoFocusKey={autoFocusKey} apply={applyEdit} onSelect={(next) => next?.kind === "node" ? openNode(next.key) : setSelection(next)}
          onClose={() => setSelection(null)} onNotice={(message) => showNotice(message, "success")} onError={(message) => showNotice(message, "error")} />
      </aside>
    </>}

    {index && funnel && mode === "explore" && <GraphLegend index={index} funnel={funnel} filters={filters} onChange={setFilters} diagnosis={diagnosis} />}

    {view && <div className="kg-corner">
      {editing && <button type="button" className={`kg-chip-button ${linkMode ? "active" : ""}`} aria-pressed={linkMode} onClick={() => { setLinkMode((value) => !value); setLinkSource(""); }}>连线</button>}
      <span className="kg-hint">{linkMode ? linkSource ? `已选「${labelOf(linkSource)}」，再点它的后继` : "先点前驱，再点后继 · Esc 退出"
        : cloudChain ? "前置在下、后续在上 · 悬停看关系 · 拖动或滚动查看" : "拖动旋转 · 滚轮缩放 · 点圆点看前置"}</span>
      <button type="button" className="kg-chip-button" onClick={() => setCommand({ kind: "reset", token: Date.now() })}>复位</button>
    </div>}

    {profileLoading && <div className="kg-pill" role="status">正在叠加学情…</div>}

    {notice && <div className={`kg-toast ${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
      <span>{notice.text}</span><button type="button" aria-label="关闭提示" onClick={() => setNotice(null)}>×</button>
    </div>}

    {dialog === "publish" && diff && <PublishDialog diff={diff} nextVersion={nextVersion} labelOf={labelOf} onCancel={() => setDialog("")} onConfirm={publishDraft} />}
    {dialog === "history" && <HistoryDrawer currentVersion={version} onClose={() => setDialog("")}
      onRestore={async (restored) => { await editor.restore(restored); setSelection(null); showNotice(`已把 v${restored} 载入为草稿，发布后才会生效`, "success"); }} />}
    {dialog === "import" && editor.session && <ImportDialog published={editor.session.published.document} current={editor.session.document}
      onCancel={() => setDialog("")} onConfirm={importDraft} />}
  </main>;
}
