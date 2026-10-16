import type { CSSProperties } from "react";
import type { Category, LibraryModule } from "../../lib/types";

/** Categories the 知识图谱 beside the tree is showing, lit in the graph's colour. */
export type TreeLight = { ids: string[]; color: string };

// 知识目录: the module root, then its categories indented by depth. Shared by the library sidebar and the handout question bank.
export function CategoryTree({ module, categories, activeId, countFor, onSelect, light = null }: {
  module: LibraryModule | null;
  categories: Category[];
  activeId: string | null;
  countFor: (id: string) => number;
  onSelect: (id: string) => void;
  light?: TreeLight | null;
}) {
  const childrenOf = (id: string) => categories.filter((item) => item.parentId === id);

  function renderTree(parentId: string, depth: number) {
    return childrenOf(parentId).map((category) => {
      const lit = Boolean(light?.ids.includes(category.id));
      return <div key={category.id}>
        <button className={`tree-row ${activeId === category.id ? "active-leaf" : ""}${lit ? " lit" : ""}`} style={{ paddingLeft: 10 + depth * 17, ...(lit ? { "--lit": light!.color } as CSSProperties : {}) }}
          title={lit ? "右侧知识图谱正在显示的知识点属于这一类" : undefined} onClick={() => onSelect(category.id)}>
          <span className="tree-dot">{childrenOf(category.id).length ? "◆" : "·"}</span><span className="tree-name">{category.name}</span><span className="count">{countFor(category.id)}</span>
        </button>
        {renderTree(category.id, depth + 1)}
      </div>;
    });
  }

  return <div className="tree">
    {!module ? <p className="empty-tree">请先创建一个模块</p> : <>
      <button className={`tree-row module-root ${activeId === module.id ? "active-leaf" : ""}`} onClick={() => onSelect(module.id)}>
        <span className="tree-dot">◆</span><span className="tree-name">{module.name}</span><span className="count">{countFor(module.id)}</span>
      </button>
      {renderTree(module.id, 1)}
    </>}
  </div>;
}
