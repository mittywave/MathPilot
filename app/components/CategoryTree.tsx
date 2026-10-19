import { useId, useState, type CSSProperties } from "react";
import type { Category, LibraryModule } from "../../lib/types";

/** Categories the 知识图谱 beside the tree is showing, lit in the graph's colour. */
export type TreeLight = { ids: string[]; color: string };

// 知识目录: the module root, then its categories indented by depth. Shared by the library sidebar and the handout question bank.
export function CategoryTree({ module, categories, activeId, countFor, onSelect, light = null, collapsible = false }: {
  module: LibraryModule | null;
  categories: Category[];
  activeId: string | null;
  countFor: (id: string) => number;
  onSelect: (id: string) => void;
  light?: TreeLight | null;
  collapsible?: boolean;
}) {
  const treeId = useId();
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [moving, setMoving] = useState<string | null>(null);
  const childrenOf = (id: string) => categories.filter((item) => item.parentId === id);

  function renderTree(node: LibraryModule | Category, depth: number) {
    const children = childrenOf(node.id);
    const lit = Boolean(light?.ids.includes(node.id));
    const open = !collapsible || !collapsed.includes(node.id);
    const label = `${open ? "收起" : "展开"}${node.name}`;
    const childrenId = `${treeId}-${node.id}`;
    return <div key={node.id}>
      <div className={collapsible ? "tree-branch-row" : undefined} style={lit ? { "--lit": light!.color } as CSSProperties : undefined}>
        <button className={`tree-row${depth === 0 ? " module-root" : ""}${activeId === node.id ? " active-leaf" : ""}${lit ? " lit" : ""}`} style={{ paddingLeft: 10 + depth * 17 }}
          title={lit ? "右侧知识图谱正在显示的知识点属于这一类" : undefined} onClick={() => onSelect(node.id)}>
          <span className="tree-dot" aria-hidden="true">{children.length && collapsible ? "" : children.length || depth === 0 ? "◆" : "·"}</span><span className="tree-name">{node.name}</span><span className="count">{countFor(node.id)}</span>
        </button>
        {collapsible && children.length > 0 && <button className="tree-fold" style={{ left: 3 + depth * 17 }} title={label} aria-label={label} aria-expanded={open} aria-controls={childrenId} onClick={() => {
          setCollapsed((current) => open ? [...current, node.id] : current.filter((id) => id !== node.id));
          setMoving(window.matchMedia("(prefers-reduced-motion: reduce)").matches ? null : node.id);
        }}><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg></button>}
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
