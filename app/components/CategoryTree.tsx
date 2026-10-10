import type { Category, LibraryModule } from "../../lib/types";

// 知识目录: the module root, then its categories indented by depth. Shared by the library sidebar and the handout question bank.
export function CategoryTree({ module, categories, activeId, countFor, onSelect }: {
  module: LibraryModule | null;
  categories: Category[];
  activeId: string | null;
  countFor: (id: string) => number;
  onSelect: (id: string) => void;
}) {
  const childrenOf = (id: string) => categories.filter((item) => item.parentId === id);

  function renderTree(parentId: string, depth: number) {
    return childrenOf(parentId).map((category) => (
      <div key={category.id}>
        <button className={`tree-row ${activeId === category.id ? "active-leaf" : ""}`} style={{ paddingLeft: 10 + depth * 17 }} onClick={() => onSelect(category.id)}>
          <span className="tree-dot">{childrenOf(category.id).length ? "◆" : "·"}</span><span className="tree-name">{category.name}</span><span className="count">{countFor(category.id)}</span>
        </button>
        {renderTree(category.id, depth + 1)}
      </div>
    ));
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
