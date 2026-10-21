"use client";
import { type CSSProperties, type ReactNode, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";
import "./handouts.css";

function readStored(key: string) { try { return localStorage.getItem(key) ?? ""; } catch { return ""; } }

// Shared by handouts, quizzes, homework and the practice basket. Widths and folded
// panels stay local to each workspace; hidden contents remain mounted.
export function useQuestionWorkspace(storageKey: string, treeOpen: boolean, opened = true) {
  const [panels, setPanels] = useState(() => {
    try {
      const saved = JSON.parse(readStored(storageKey) || "{}");
      return { bank: saved.bank !== false, outline: saved.outline !== false, bankWidth: Number.isFinite(saved.bankWidth) && saved.bankWidth > 0 ? saved.bankWidth as number : null, outlineWidth: Number.isFinite(saved.outlineWidth) && saved.outlineWidth > 0 ? saved.outlineWidth as number : 248, treeWidth: Number.isFinite(saved.treeWidth) && saved.treeWidth > 0 ? saved.treeWidth as number : 200 };
    } catch { return { bank: true, outline: true, bankWidth: null, outlineWidth: 248, treeWidth: 200 }; }
  });
  const [workspaceWidth, setWorkspaceWidth] = useState(() => window.innerWidth);
  const panelDrag = useRef<{ side: "bank" | "outline" | "tree"; pointerId: number; startX: number; startWidth: number; bankWidth: number; outlineWidth: number; treeWidth: number; moved: boolean } | null>(null);
  const bankPane = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const workspace = bankPane.current?.parentElement;
    if (!opened || !workspace) return;
    const observer = new ResizeObserver(([entry]) => { if (entry.contentRect.width) setWorkspaceWidth(entry.contentRect.width); });
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [opened]);
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(panels)); } catch { /* Widths remain usable without storage. */ } }, [storageKey, panels]);
  // Clamp preferences to this window without replacing the remembered widths.
  const minBank = Math.min(treeOpen ? 420 : 280, workspaceWidth * .4), minOutline = Math.min(200, workspaceWidth * .2), minDraft = Math.min(440, workspaceWidth * .4);
  const outlineFull = Math.max(minOutline, Math.min(panels.outlineWidth, workspaceWidth - (panels.bank ? minBank : 56) - minDraft));
  const outlineWidth = panels.outline ? outlineFull : 48;
  const bankFull = Math.max(minBank, Math.min(panels.bankWidth ?? (workspaceWidth - outlineWidth) * .4, workspaceWidth - outlineWidth - minDraft));
  const bankWidth = panels.bank ? bankFull : 56;
  const bankMax = Math.max(minBank, workspaceWidth - outlineWidth - minDraft), outlineMax = Math.max(minOutline, workspaceWidth - bankWidth - minDraft);
  const minTree = 160, treeMax = Math.max(minTree, Math.min(400, bankFull - 220));
  const treeFull = Math.max(minTree, Math.min(panels.treeWidth, treeMax));

  function startPanelResize(event: ReactPointerEvent<HTMLDivElement>, side: "bank" | "outline" | "tree") {
    if (event.button !== 0 || panelDrag.current) return;
    event.preventDefault();
    const workspace = event.currentTarget.parentElement!;
    const bank = panels.bank ? workspace.querySelector(".handout-bank-pane")!.getBoundingClientRect().width : bankFull;
    const outline = panels.outline ? workspace.querySelector(".handout-outline-pane")!.getBoundingClientRect().width : outlineFull;
    const tree = workspace.querySelector(".picker-tree")!.getBoundingClientRect().width;
    panelDrag.current = { side, pointerId: event.pointerId, startX: event.clientX, startWidth: side === "bank" ? bank : side === "outline" ? outline : tree, bankWidth: bank, outlineWidth: outline, treeWidth: tree, moved: false };
    workspace.dataset.resizing = side;
    workspace.style.setProperty("--handout-bank-full", `${bank}px`);
    workspace.style.setProperty("--handout-outline-full", `${outline}px`);
    workspace.style.setProperty("--handout-tree-full", `${tree}px`);
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function movePanelResize(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = panelDrag.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = (event.clientX - drag.startX) * (drag.side === "outline" ? -1 : 1);
    if (Math.abs(delta) < 1 && !drag.moved) return;
    const min = drag.side === "bank" ? minBank : drag.side === "outline" ? minOutline : minTree;
    const max = drag.side === "bank" ? bankMax : drag.side === "outline" ? outlineMax : treeMax;
    const width = Math.max(min, Math.min(max, Math.round(drag.startWidth + delta)));
    if (drag.side === "bank") drag.bankWidth = width; else if (drag.side === "outline") drag.outlineWidth = width; else drag.treeWidth = width;
    drag.moved = true;
    // Only resize the DOM while dragging; the math cards do not need to render again.
    const workspace = event.currentTarget.parentElement!;
    workspace.style.setProperty(`--handout-${drag.side}-full`, `${width}px`);
    if (drag.side === "bank") workspace.style.setProperty("--handout-tree-full", `${Math.max(minTree, Math.min(panels.treeWidth, 400, width - 220))}px`);
    event.currentTarget.setAttribute("aria-valuenow", String(Math.round(width)));
    event.currentTarget.setAttribute("aria-valuetext", `${drag.side === "bank" ? "题库" : drag.side === "outline" ? "结构栏" : "目录"}宽度 ${Math.round(width)} 像素`);
  }

  function endPanelResize(element: HTMLDivElement, cancel = false) {
    const drag = panelDrag.current;
    if (!drag) return;
    panelDrag.current = null;
    const workspace = element.parentElement!;
    if (cancel || !drag.moved) {
      workspace.style.setProperty("--handout-bank-full", `${bankFull}px`);
      workspace.style.setProperty("--handout-outline-full", `${outlineFull}px`);
      workspace.style.setProperty("--handout-tree-full", `${treeFull}px`);
      const width = Math.round(drag.side === "bank" ? bankFull : drag.side === "outline" ? outlineFull : treeFull);
      element.setAttribute("aria-valuenow", String(width));
      element.setAttribute("aria-valuetext", `${drag.side === "bank" ? "题库" : drag.side === "outline" ? "结构栏" : "目录"}宽度 ${width} 像素`);
    } else {
      setPanels(current => ({ ...current, bankWidth: drag.side === "bank" || (drag.side === "outline" && current.bank) ? drag.bankWidth : current.bankWidth, outlineWidth: drag.side === "outline" ? drag.outlineWidth : current.outlineWidth, treeWidth: drag.side === "tree" ? drag.treeWidth : current.treeWidth }));
    }
    delete workspace.dataset.resizing;
    if (element.hasPointerCapture(drag.pointerId)) element.releasePointerCapture(drag.pointerId);
  }

  function keyPanelResize(event: ReactKeyboardEvent<HTMLDivElement>, side: "bank" | "outline" | "tree") {
    if (event.key === "Escape" && panelDrag.current) { event.preventDefault(); endPanelResize(event.currentTarget, true); return; }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || panelDrag.current) return;
    event.preventDefault();
    const min = side === "bank" ? minBank : side === "outline" ? minOutline : minTree, max = side === "bank" ? bankMax : side === "outline" ? outlineMax : treeMax;
    const delta = (event.key === "ArrowLeft" ? -1 : 1) * (side === "outline" ? -1 : 1) * (event.shiftKey ? 40 : 16);
    const width = event.key === "Home" ? min : event.key === "End" ? max : Math.max(min, Math.min(max, (side === "bank" ? bankFull : side === "outline" ? outlineFull : treeFull) + delta));
    setPanels(current => ({ ...current, bankWidth: side === "bank" ? width : side === "outline" && current.bank ? bankFull : current.bankWidth, outlineWidth: side === "outline" ? width : current.outlineWidth, treeWidth: side === "tree" ? width : current.treeWidth }));
  }

  return { treeOpen, panels, setPanels, bankPane, bankFull, outlineFull, treeFull, minTree, treeMax, minBank, bankMax, minOutline, outlineMax, startPanelResize, movePanelResize, endPanelResize, keyPanelResize };
}

export function QuestionWorkspace({ bank, outline, outlineLabel, draftLabel, children, ...workspace }: ReturnType<typeof useQuestionWorkspace> & { bank: ReactNode; outline: ReactNode; outlineLabel: string; draftLabel: string; children: ReactNode }) {
  const { treeOpen, panels, setPanels, bankPane, bankFull, outlineFull, treeFull, minTree, treeMax, minBank, bankMax, minOutline, outlineMax, startPanelResize, movePanelResize, endPanelResize, keyPanelResize } = workspace;
  return (
    <div className={`handout-workspace${panels.bank ? "" : " bank-closed"}${panels.outline ? "" : " outline-closed"}`} style={{ "--handout-bank-full": `${bankFull}px`, "--handout-outline-full": `${outlineFull}px`, "--handout-tree-full": `${treeFull}px` } as CSSProperties}>
      <div className="handout-bank-pane" ref={bankPane}>
        <button type="button" className="handout-panel-toggle" title={panels.bank ? "收起题库" : "展开题库"} aria-label={panels.bank ? "收起题库" : "展开题库"} aria-expanded={panels.bank} aria-controls="handout-bank-content" onClick={() => setPanels(current => ({ ...current, bank: !current.bank }))}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" /><path className="handout-panel-chevron" d="m16 9-3 3 3 3" /></svg>
          <span className="handout-panel-label" aria-hidden="true">题库</span>
        </button>
        <div id="handout-bank-content" className="handout-bank-content" inert={!panels.bank} aria-hidden={!panels.bank}>
{bank}
        </div>
      </div>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- A focusable window separator supports pointer and keyboard resizing. */}
      <div className="handout-splitter tree" role="separator" aria-label="调整目录与题目宽度" aria-orientation="vertical" aria-valuemin={minTree} aria-valuemax={Math.round(treeMax)} aria-valuenow={Math.round(treeFull)} aria-valuetext={`目录宽度 ${Math.round(treeFull)} 像素`} aria-controls="picker-directory" tabIndex={0} hidden={!panels.bank || !treeOpen} title="拖动调整目录宽度；双击恢复默认；方向键微调"
        onPointerDown={event => startPanelResize(event, "tree")} onPointerMove={movePanelResize} onPointerUp={event => endPanelResize(event.currentTarget)} onPointerCancel={event => endPanelResize(event.currentTarget, true)} onLostPointerCapture={event => endPanelResize(event.currentTarget, true)}
        onDoubleClick={() => setPanels(current => ({ ...current, treeWidth: 200 }))} onKeyDown={event => keyPanelResize(event, "tree")} />
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- A focusable window separator supports pointer and keyboard resizing. */}
      <div className="handout-splitter bank" role="separator" aria-label="调整题库与正文宽度" aria-orientation="vertical" aria-valuemin={Math.round(minBank)} aria-valuemax={Math.round(bankMax)} aria-valuenow={Math.round(bankFull)} aria-valuetext={`题库宽度 ${Math.round(bankFull)} 像素`} aria-controls="handout-bank-content handout-draft" tabIndex={0} hidden={!panels.bank} title="拖动调整题库宽度；双击恢复默认；方向键微调"
        onPointerDown={event => startPanelResize(event, "bank")} onPointerMove={movePanelResize} onPointerUp={event => endPanelResize(event.currentTarget)} onPointerCancel={event => endPanelResize(event.currentTarget, true)} onLostPointerCapture={event => endPanelResize(event.currentTarget, true)}
        onDoubleClick={() => setPanels(current => ({ ...current, bankWidth: null }))} onKeyDown={event => keyPanelResize(event, "bank")} />
      <div className="handout-draft" id="handout-draft" aria-label={draftLabel}>
{children}
      </div>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- A focusable window separator supports pointer and keyboard resizing. */}
      <div className="handout-splitter outline" role="separator" aria-label="调整正文与结构栏宽度" aria-orientation="vertical" aria-valuemin={Math.round(minOutline)} aria-valuemax={Math.round(outlineMax)} aria-valuenow={Math.round(outlineFull)} aria-valuetext={`结构栏宽度 ${Math.round(outlineFull)} 像素`} aria-controls="handout-draft handout-outline-content" tabIndex={0} hidden={!panels.outline} title="拖动调整结构栏宽度；双击恢复默认；方向键微调"
        onPointerDown={event => startPanelResize(event, "outline")} onPointerMove={movePanelResize} onPointerUp={event => endPanelResize(event.currentTarget)} onPointerCancel={event => endPanelResize(event.currentTarget, true)} onLostPointerCapture={event => endPanelResize(event.currentTarget, true)}
        onDoubleClick={() => setPanels(current => ({ ...current, outlineWidth: 248 }))} onKeyDown={event => keyPanelResize(event, "outline")} />
      <aside className="handout-outline-pane" aria-label={`${outlineLabel}结构侧栏`}>
        <button type="button" className="handout-panel-toggle" title={`${panels.outline ? "收起" : "展开"}${outlineLabel}结构`} aria-label={`${panels.outline ? "收起" : "展开"}${outlineLabel}结构`} aria-expanded={panels.outline} aria-controls="handout-outline-content" onClick={() => setPanels(current => ({ ...current, outline: !current.outline }))}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M15 4v16" /><path className="handout-panel-chevron" d="m8 9 3 3-3 3" /></svg>
          <span className="handout-panel-label" aria-hidden="true">{outlineLabel}结构</span>
        </button>
        <nav id="handout-outline-content" className="handout-outline-content" aria-label={`${outlineLabel}结构`} inert={!panels.outline} aria-hidden={!panels.outline}>
{outline}
        </nav>
      </aside>
    </div>);
}
