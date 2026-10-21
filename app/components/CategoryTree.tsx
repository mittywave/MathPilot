import { useEffect, useId, useRef, useState, type CSSProperties, type HTMLAttributes, type RefAttributes, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent, type DragEvent } from "react";
import { categoryDescendants } from "../../lib/library-tree";
import type { Category, LibraryModule } from "../../lib/types";

/** Categories the 知识图谱 beside the tree is showing, lit in the graph's colour. */
export type TreeLight = { ids: string[]; color: string };

// 知识目录: the module root, then its categories indented by depth. Shared by the library sidebar and the handout question bank.
export function FolderIcon() {
  return <svg aria-hidden="true" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"><path d="M2 4.5v8h12V6H7.5L6 4.5z" /></svg>;
}

export type DirectoryDrop = { id: string; kind: "module" | "category"; targetId: string; targetKind: "module" | "category"; position: "before" | "after" | "inside" };

// Pointer motion stays outside React; only a completed drop changes the library.
// Both the sidebar and the management window use these same gestures.
export function useDirectoryDrag({ modules, categories, enabled, onDrop }: {
  modules: LibraryModule[]; categories: Category[]; enabled: boolean;
  onDrop: (drop: DirectoryDrop) => void;
}) {
  const gesture = useRef<{ cancel?: () => void; suppressClick: boolean }>({ suppressClick: false });
  const expanders = useRef(new WeakMap<HTMLElement, (() => void) | undefined>());
  useEffect(() => { const current = gesture.current; return () => current.cancel?.(); }, []);

  return (id: string, kind: "module" | "category" = "module", expand?: () => void) => ({
    "data-directory-id": id,
    "data-directory-kind": kind,
    "data-directory-draggable": enabled || undefined,
    ref: (node: HTMLDivElement | null) => { if (node) expanders.current.set(node, expand); },
    onDragStart: (event: DragEvent<HTMLDivElement>) => event.preventDefault(),
    onClickCapture: (event: ReactMouseEvent<HTMLDivElement>) => {
      if (gesture.current.suppressClick) { event.preventDefault(); event.stopPropagation(); gesture.current.suppressClick = false; }
    },
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button === 0) gesture.current.suppressClick = false;
      if (!enabled || event.button !== 0 || event.pointerType === "touch") return;
      const clicked = event.target as Element;
      if (clicked.closest("input, select, textarea, a, button:not(.tree-row):not(.module-select):not(.tree-fold)")) return;
      event.stopPropagation();
      gesture.current.cancel?.(); gesture.current.suppressClick = false;
      const source = event.currentTarget;
      const item = (kind === "module" ? modules : categories).find(node => node.id === id);
      if (!item) return;
      const moduleId = kind === "module" ? id : (item as Category).moduleId;
      const blocked = new Set(kind === "category" ? categoryDescendants(categories, id) : [id]);
      const rowOf = (node: HTMLElement) => node.querySelector<HTMLElement>(".tree-row, .module-select") ?? node;
      const scope = source.closest<HTMLElement>(".library-management-grid") ?? source.closest<HTMLElement>("#library-directory") ?? source.parentElement!;
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const startX = event.clientX, startY = event.clientY, pointerId = event.pointerId;
      let x = startX, y = startY, active = false, frame = 0, lastTime = 0;
      let preview: HTMLDivElement | null = null, hint: HTMLSpanElement | null = null;
      let target: HTMLElement | null = null, plan: DirectoryDrop | null = null;
      let hoverStart = 0, hoverOpened = false;
      const controller = new AbortController();
      const options = { capture: true, signal: controller.signal };

      const markTarget = (next: HTMLElement | null, drop: DirectoryDrop | null, label: string) => {
        if (target !== next || plan?.position !== drop?.position) {
          target?.removeAttribute("data-drop-position");
          target = next; hoverStart = performance.now(); hoverOpened = false;
          if (drop) target?.setAttribute("data-drop-position", drop.position);
        }
        plan = drop;
        if (hint && hint.textContent !== label) hint.textContent = label;
        preview?.toggleAttribute("data-invalid", !drop);
      };
      const tick = (now: number) => {
        if (!active || !preview) return;
        preview.style.transform = `translate3d(${Math.min(x + 16, innerWidth - preview.offsetWidth - 8)}px,${Math.min(y + 14, innerHeight - preview.offsetHeight - 8)}px,0)`;
        let hit = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-directory-id]") ?? null;
        if (kind === "module" && hit?.dataset.directoryKind === "category") hit = hit.closest<HTMLElement>('[data-directory-kind="module"]');
        const targetId = hit?.dataset.directoryId, targetKind = hit?.dataset.directoryKind as "module" | "category" | undefined;
        const targetItem = targetKind === "module" ? modules.find(node => node.id === targetId) : categories.find(node => node.id === targetId);
        const targetModule = targetKind === "module" ? targetId : (targetItem as Category | undefined)?.moduleId;
        if (!hit || !targetId || !targetKind || !targetItem || blocked.has(targetId) || (kind === "category" && moduleId !== targetModule)) {
          const label = kind === "module" ? "拖到模块上方或下方排序" : targetId && targetId !== id && blocked.has(targetId) ? "不能移入自己的子分类" : targetItem && moduleId !== targetModule ? "请选择当前模块内的分类" : "拖到分类中间移入，边缘排序";
          markTarget(null, null, label);
        } else {
          const box = rowOf(hit).getBoundingClientRect();
          const ratio = (y - box.top) / Math.max(box.height, 1);
          const position = kind === "module" ? ratio < .5 ? "before" : "after" : targetKind === "module" ? "inside" : ratio < .25 ? "before" : ratio > .75 ? "after" : "inside";
          markTarget(hit, { id, kind, targetId, targetKind, position }, position === "inside" ? `移入「${targetItem.name}」` : `放在「${targetItem.name}」${position === "before" ? "上方" : "下方"}`);
          if (position === "inside" && !hoverOpened && now - hoverStart > 420) {
            hoverOpened = true; expanders.current.get(hit)?.();
          }
        }
        // Scroll only the directory under the pointer, never the question page.
        let scroller = hit;
        while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) scroller = scroller.parentElement;
        if (scroller) {
          const box = scroller.getBoundingClientRect();
          const speed = y < box.top + 38 ? -Math.min(10, (box.top + 38 - y) / 3) : y > box.bottom - 38 ? Math.min(10, (y - box.bottom + 38) / 3) : 0;
          if (speed) scroller.scrollTop += speed * Math.min(32, now - (lastTime || now)) / 16;
        }
        lastTime = now; frame = requestAnimationFrame(tick);
      };
      const finish = (commit: boolean) => {
        controller.abort(); cancelAnimationFrame(frame);
        gesture.current.cancel = undefined;
        try { if (source.hasPointerCapture(pointerId)) source.releasePointerCapture(pointerId); } catch { /* The row may have unmounted. */ }
        if (!active) return;
        active = false; gesture.current.suppressClick = true;
        document.documentElement.classList.remove("directory-drag-active");
        source.removeAttribute("data-dragging"); target?.removeAttribute("data-drop-position");
        const before = new Map<string, DOMRect>();
        if (commit && plan) {
          if (!reduced) for (const node of scope.querySelectorAll<HTMLElement>("[data-directory-id]")) before.set(`${node.dataset.directoryKind}:${node.dataset.directoryId}`, rowOf(node).getBoundingClientRect());
          if (plan.position === "inside" && target) expanders.current.get(target)?.();
          onDrop(plan);
          requestAnimationFrame(() => requestAnimationFrame(() => {
            for (const node of scope.querySelectorAll<HTMLElement>("[data-directory-id]")) {
              const row = rowOf(node), previous = before.get(`${node.dataset.directoryKind}:${node.dataset.directoryId}`), next = row.getBoundingClientRect();
              if (node.dataset.directoryKind === kind && node.dataset.directoryId === id) {
                let pane = node.parentElement;
                while (pane && pane !== scope.parentElement && !(pane.scrollHeight > pane.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(pane).overflowY))) pane = pane.parentElement;
                if (pane && pane !== scope.parentElement) {
                  const viewport = pane.getBoundingClientRect();
                  const offset = next.top < viewport.top ? next.top - viewport.top - 8 : next.bottom > viewport.bottom ? next.bottom - viewport.bottom + 8 : 0;
                  if (offset) pane.scrollTo({ top: pane.scrollTop + offset, behavior: reduced ? "instant" : "smooth" });
                }
              }
              if (reduced) continue;
              if (!previous || !next.height || next.bottom < 0 || next.top > innerHeight) continue;
              const dx = previous.left - next.left, dy = previous.top - next.top;
              if (Math.abs(dx) + Math.abs(dy) > 1) row.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: "translate(0,0)" }], { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)" });
            }
          }));
        }
        if (preview) {
          const fading = preview;
          if (!reduced) fading.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120 }).onfinish = () => fading.remove();
          else fading.remove();
          window.setTimeout(() => fading.remove(), 180);
        }
      };
      gesture.current.cancel = () => finish(false);
      window.addEventListener("pointermove", (move: PointerEvent) => {
        if (move.pointerId !== pointerId) return;
        x = move.clientX; y = move.clientY;
        if (!active && Math.hypot(x - startX, y - startY) >= 5) {
          active = true;
          try { source.setPointerCapture(pointerId); } catch { /* Window listeners still track the gesture. */ }
          document.documentElement.classList.add("directory-drag-active");
          window.getSelection()?.removeAllRanges(); source.setAttribute("data-dragging", "true");
          preview = document.createElement("div"); preview.className = "directory-drag-preview"; preview.setAttribute("aria-hidden", "true");
          const name = document.createElement("strong"); name.textContent = item.name;
          hint = document.createElement("span"); preview.append(name, hint); document.body.append(preview);
          frame = requestAnimationFrame(tick);
        }
        if (active) move.preventDefault();
      }, options);
      window.addEventListener("pointerup", (up: PointerEvent) => {
        if (up.pointerId !== pointerId) return;
        if (active) { x = up.clientX; y = up.clientY; cancelAnimationFrame(frame); tick(performance.now()); }
        finish(true);
      }, options);
      window.addEventListener("pointercancel", () => finish(false), options);
      window.addEventListener("blur", () => finish(false), { signal: controller.signal });
      window.addEventListener("keydown", (key: KeyboardEvent) => { if (key.key === "Escape") { key.preventDefault(); key.stopPropagation(); finish(false); } }, options);
    },
  });
}

export function CategoryTree({ module, categories, activeId, countFor, onSelect, light = null, collapsible = false, rootOpen, onRootToggle, dragProps }: {
  module: LibraryModule | null;
  categories: Category[];
  activeId: string | null;
  countFor: (id: string) => number;
  onSelect: (id: string) => void;
  light?: TreeLight | null;
  collapsible?: boolean;
  rootOpen?: boolean;
  onRootToggle?: () => void;
  dragProps?: (id: string, expand?: () => void) => HTMLAttributes<HTMLDivElement> & RefAttributes<HTMLDivElement>;
}) {
  const treeId = useId();
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [moving, setMoving] = useState<string | null>(null);
  const childrenOf = (id: string) => categories.filter((item) => item.parentId === id);

  function renderTree(node: LibraryModule | Category, depth: number) {
    const children = childrenOf(node.id);
    const lit = Boolean(light?.ids.includes(node.id));
    const open = !collapsible || (depth === 0 && rootOpen !== undefined ? rootOpen : !collapsed.includes(node.id));
    const label = `${open ? "收起" : "展开"}${node.name}`;
    const childrenId = `${treeId}-${node.id}`;
    const toggle = () => {
      if (depth === 0 && onRootToggle) onRootToggle();
      else setCollapsed((current) => open ? [...current, node.id] : current.filter((id) => id !== node.id));
      setMoving(window.matchMedia("(prefers-reduced-motion: reduce)").matches ? null : node.id);
    };
    return <div key={node.id} className={depth > 0 && dragProps ? "tree-category" : undefined} {...(depth > 0 ? dragProps?.(node.id, !open && children.length ? () => setCollapsed(current => current.filter(id => id !== node.id)) : undefined) : {})}>
      <div className={collapsible ? "tree-branch-row" : undefined} style={lit ? { "--lit": light!.color } as CSSProperties : undefined}>
        <button className={`tree-row${depth === 0 ? " module-root" : ""}${activeId === node.id ? " active-leaf" : ""}${lit ? " lit" : ""}`} style={{ paddingLeft: 10 + depth * 17 }}
          title={lit ? "右侧知识图谱正在显示的知识点属于这一类" : undefined} onClick={() => collapsible && children.length && activeId === node.id ? toggle() : onSelect(node.id)}>
          <span className="tree-dot" aria-hidden="true">{children.length && collapsible && depth > 0 ? "" : children.length || depth === 0 ? <FolderIcon /> : "·"}</span><span className="tree-name">{node.name}</span><span className="count">{countFor(node.id)}</span>
        </button>
        {collapsible && children.length > 0 && <button className="tree-fold" style={{ left: 3 + depth * 17 }} title={label} aria-label={label} aria-expanded={open} aria-controls={childrenId} onClick={toggle}>{depth > 0 && <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>}</button>}
      </div>
      {children.length > 0 && (collapsible ? <div id={childrenId} className="tree-children" data-open={open} data-directory-motion={moving === node.id ? open ? "opening" : "closing" : undefined} inert={!open} aria-hidden={!open} onAnimationEnd={(event) => { if (event.target === event.currentTarget && event.animationName === "tree-glass") setMoving(null); }}>
        <div className="tree-children-content">{children.map((child) => renderTree(child, depth + 1))}</div>
      </div> : children.map((child) => renderTree(child, depth + 1)))}
    </div>;
  }

  return <div className="tree">
    {!module ? <p className="empty-tree">请先创建一个模块</p> : renderTree(module, 0)}
  </div>;
}
