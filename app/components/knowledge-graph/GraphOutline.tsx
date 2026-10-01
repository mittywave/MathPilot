"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { KnowledgeGraphIndex } from "../../../lib/knowledge-graph-core.mjs";
import type { KnowledgeGraphLevel, KnowledgeGraphNode } from "../../../lib/types";
import { searchNodes, stageShort, type GraphSelection } from "./graph-model";

type Props = {
  index: KnowledgeGraphIndex;
  selection: GraphSelection;
  colorOf: (key: string) => string;
  onSelect: (selection: GraphSelection) => void;
  issueKeys: Set<string>;
  archived: KnowledgeGraphNode[];
  onAdd: (level: KnowledgeGraphLevel) => void;
  onRestore: (key: string) => void;
};

// Editing outline for hundreds of points: domains open, topics folded until needed.
export default function GraphOutline({ index, selection, colorOf, onSelect, issueKeys, archived, onAdd, onRestore }: Props) {
  const [query, setQuery] = useState("");
  const [openTopics, setOpenTopics] = useState<string[]>([]);
  const [closedDomains, setClosedDomains] = useState<string[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const listRef = useRef<HTMLElement>(null);
  const stageLabel = useMemo(() => new Map(index.document.stages.map((stage) => [stage.value, stageShort(stage.label)])), [index.document.stages]);
  const matches = useMemo(() => searchNodes(index, query, 60), [index, query]);
  const selectedNode = selection?.kind === "node" ? index.nodeByKey.get(selection.key) : undefined;
  const selectedTopic = selectedNode?.level === "topic" ? selectedNode : selectedNode?.level === "point" ? index.nodeByKey.get(selectedNode.parentKey ?? "") : undefined;
  // Picking a node elsewhere reveals it here once: its domain and topic unfold.
  const [revealedKey, setRevealedKey] = useState(selection?.key ?? "");
  if ((selection?.key ?? "") !== revealedKey) {
    setRevealedKey(selection?.key ?? "");
    if (selectedTopic && !openTopics.includes(selectedTopic.key)) setOpenTopics([...openTopics, selectedTopic.key]);
    if (selectedNode && closedDomains.includes(selectedNode.domainKey)) setClosedDomains(closedDomains.filter((key) => key !== selectedNode.domainKey));
  }

  useEffect(() => {
    if (!selection) return;
    const frame = requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>("[data-current='true']")?.scrollIntoView({ block: "nearest" }));
    return () => cancelAnimationFrame(frame);
  }, [selection]);

  const row = (node: KnowledgeGraphNode, depth: number, extra?: string, count?: number) => {
    const current = selection?.kind === "node" && selection.key === node.key;
    return <button key={node.key} type="button" data-current={current} className={`kg-outline-row depth-${depth} ${current ? "current" : ""}`} onClick={() => onSelect({ kind: "node", key: node.key })}>
      <i className="kg-outline-dot" style={{ background: colorOf(node.key) }} aria-hidden="true" />
      <span className="kg-outline-label">{node.label}{extra && <small>{extra}</small>}</span>
      {issueKeys.has(node.key) && <b className="kg-issue-dot" title="有待处理的问题" />}
      {count !== undefined && <em className="kg-outline-count" title={`${count} 个知识点`}>{count}</em>}
      <span className="kg-stage-tag">{stageLabel.get(node.stage) ?? node.stage}</span>
    </button>;
  };
  const toggle = (list: string[], key: string) => list.includes(key) ? list.filter((item) => item !== key) : [...list, key];
  const add = (level: KnowledgeGraphLevel) => { setAddOpen(false); onAdd(level); };

  return <div className="kg-outline">
    <div className="kg-outline-tools">
      <label className="kg-outline-search">
        <span aria-hidden="true">⌕</span>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索知识点或别名" aria-label="在目录中搜索"
          onKeyDown={(event) => { if (event.key === "Enter" && matches[0]) onSelect({ kind: "node", key: matches[0].key }); if (event.key === "Escape") setQuery(""); }} />
      </label>
      <div className="kg-add-menu">
        <button type="button" className="kg-add-button" aria-expanded={addOpen} onClick={() => setAddOpen((open) => !open)}>＋ 新增</button>
        {addOpen && <div className="kg-menu right" role="menu">
          <button type="button" role="menuitem" disabled={!selectedTopic} onClick={() => add("point")}>知识点<small>{selectedTopic ? `放在「${selectedTopic.label}」下` : "先选中一个主题"}</small></button>
          <button type="button" role="menuitem" onClick={() => add("topic")}>主题<small>放在当前领域，如“一次函数”</small></button>
          <button type="button" role="menuitem" onClick={() => add("domain")}>领域<small>新的课程领域</small></button>
        </div>}
      </div>
    </div>
    <nav className="kg-outline-list" aria-label="知识目录" ref={listRef}>
      {query.trim() ? matches.length ? matches.map((node) => row(node, 1, node.level === "point" ? index.nodeByKey.get(node.parentKey ?? "")?.label : "主题"))
        : <p className="kg-outline-empty">没有找到“{query.trim()}”</p>
        : index.domains.map((domain) => {
          const topics = (index.children.get(domain.key) ?? []).filter((node) => node.level === "topic").sort((left, right) => left.stage - right.stage || left.order - right.order);
          const open = !closedDomains.includes(domain.key);
          const current = selection?.kind === "domain" && selection.key === domain.key;
          return <div key={domain.key} className="kg-outline-group">
            <div className={`kg-outline-domain ${current ? "current" : ""}`} data-current={current}>
              <button type="button" className="kg-outline-toggle" aria-expanded={open} aria-label={`${open ? "收起" : "展开"}${domain.label}`} onClick={() => setClosedDomains(toggle(closedDomains, domain.key))}>{open ? "▾" : "▸"}</button>
              <button type="button" className="kg-outline-domain-name" onClick={() => onSelect({ kind: "domain", key: domain.key })}>
                <i style={{ background: domain.color }} aria-hidden="true" />{domain.label}<small>{topics.length} 个主题</small>
              </button>
            </div>
            {open && topics.map((topic) => {
              const points = (index.children.get(topic.key) ?? []).filter((node) => node.level === "point");
              const expanded = openTopics.includes(topic.key);
              return <div key={topic.key} className="kg-outline-branch">
                <div className="kg-outline-topic">
                  <button type="button" className="kg-outline-toggle" aria-expanded={expanded} aria-label={`${expanded ? "收起" : "展开"}${topic.label}`} disabled={!points.length}
                    onClick={() => setOpenTopics(toggle(openTopics, topic.key))}>{points.length ? expanded ? "▾" : "▸" : ""}</button>
                  {row(topic, 1, undefined, points.length)}
                </div>
                {expanded && points.map((point) => row(point, 2))}
              </div>;
            })}
          </div>;
        })}
    </nav>
    {archived.length > 0 && <details className="kg-archived">
      <summary>已停用 {archived.length}</summary>
      {archived.map((node) => <div key={node.key}>
        <span>{node.label}<small>{node.mergedInto ? `已合并到「${index.nodeByKey.get(node.mergedInto)?.label ?? "其他知识点"}」` : "不再用于标签和学情"}</small></span>
        <button type="button" onClick={() => onRestore(node.key)}>恢复</button>
      </div>)}
    </details>}
  </div>;
}
