"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { KNOWLEDGE_GRAPH_PALETTE, type KnowledgeGraphIndex } from "../../../lib/knowledge-graph-core.mjs";
import {
  addKnowledgeEdge, addKnowledgeNodesFromLines, mergeKnowledgeNode, moveKnowledgeNode, removeKnowledgeEdge, removeKnowledgeNode, setKnowledgeMapping, updateKnowledgeEdge, updateKnowledgeNode,
} from "../../../lib/knowledge-graph-edit.mjs";
import type { KnowledgeGraphDocument, KnowledgeGraphIssue, KnowledgeGraphNode } from "../../../lib/types";
import { LEVEL_LABEL, type GraphSelection } from "./graph-model";
import NodePicker, { type PickerOption } from "./NodePicker";

export type ApplyEdit = (next: KnowledgeGraphDocument, options?: { coalesce?: string; select?: GraphSelection }) => void;

type Props = {
  document: KnowledgeGraphDocument;
  index: KnowledgeGraphIndex;
  selection: GraphSelection;
  publishedKeys: Set<string>;
  issues: KnowledgeGraphIssue[];
  autoFocusKey: string;
  apply: ApplyEdit;
  onSelect: (selection: GraphSelection) => void;
  onClose: () => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
};

function attempt(run: () => void, onError: (message: string) => void) {
  try { run(); } catch (error) { onError(error instanceof Error ? error.message : "操作失败"); }
}

function searchText(node: KnowledgeGraphNode) { return [node.label, ...node.aliases].join("|").toLowerCase().replace(/\s+/g, ""); }

function AliasInput({ values, onChange }: { values: string[]; onChange: (values: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const commit = () => { const parts = draft.split(/[,，、;；]/).map((item) => item.trim()).filter(Boolean); if (parts.length) onChange([...values, ...parts]); setDraft(""); };
  return <div className="kg-alias-input">
    {values.map((alias) => <span key={alias}>{alias}<button type="button" aria-label={`删除别名 ${alias}`} onClick={() => onChange(values.filter((item) => item !== alias))}>×</button></span>)}
    <input value={draft} placeholder={values.length ? "继续添加" : "输入后回车，如：正比例函数"} aria-label="添加识别别名" onChange={(event) => setDraft(event.target.value)} onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === "," || event.key === "，") { event.preventDefault(); commit(); }
        if (event.key === "Backspace" && !draft && values.length) onChange(values.slice(0, -1));
      }} />
  </div>;
}

function RelationEditor({ direction, node, document, index, apply, onSelect, onError }: {
  direction: "up" | "down"; node: KnowledgeGraphNode; document: KnowledgeGraphDocument; index: KnowledgeGraphIndex;
  apply: ApplyEdit; onSelect: (selection: GraphSelection) => void; onError: (message: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const edges = document.edges.filter((edge) => direction === "up" ? edge.targetKey === node.key : edge.sourceKey === node.key);
  const linked = new Set(edges.map((edge) => direction === "up" ? edge.sourceKey : edge.targetKey));
  const hierarchy = new Set([...index.hierarchy(node.key), ...(index.children.get(node.key) ?? []).map((child) => child.key)]);
  const blocked = direction === "up" ? index.descendants(node.key) : index.ancestors(node.key);
  const options: PickerOption[] = index.activeNodes
    .filter((candidate) => candidate.level !== "domain" && candidate.key !== node.key && !linked.has(candidate.key) && !hierarchy.has(candidate.key))
    .sort((left, right) => left.stage - right.stage || left.label.localeCompare(right.label, "zh-CN"))
    .map((candidate) => ({
      key: candidate.key, label: candidate.label, search: searchText(candidate),
      hint: `${index.nodeByKey.get(candidate.domainKey)?.label ?? ""} · ${index.document.stages.find((stage) => stage.value === candidate.stage)?.label ?? candidate.stage}`,
      disabledReason: blocked.has(candidate.key) ? "会形成循环" : undefined,
    }));
  const title = direction === "up" ? "前驱 · 先学" : "后继 · 解锁";
  return <section className={`kg-relations editing ${direction}`}>
    <h3><i aria-hidden="true" />{title}<small>{edges.length}</small></h3>
    <ul>
      {edges.map((edge) => {
        const otherKey = direction === "up" ? edge.sourceKey : edge.targetKey; const other = index.nodeByKey.get(otherKey);
        return <li key={otherKey}>
          <div className="kg-relation-row">
            <button type="button" className="kg-relation-name" onClick={() => onSelect({ kind: "node", key: otherKey })}>{other?.label ?? otherKey}</button>
            <div className="kg-segmented small" role="group" aria-label="关系类型">
              {(["prerequisite", "supports"] as const).map((kind) => <button key={kind} type="button" aria-pressed={edge.relationship === kind} className={edge.relationship === kind ? "active" : ""}
                onClick={() => attempt(() => apply(updateKnowledgeEdge(document, edge.sourceKey, edge.targetKey, { relationship: kind })), onError)}>{kind === "prerequisite" ? "前置" : "支撑"}</button>)}
            </div>
            <button type="button" className="kg-icon-button" aria-label={`删除关系：${other?.label ?? otherKey}`}
              onClick={() => attempt(() => apply(removeKnowledgeEdge(document, edge.sourceKey, edge.targetKey)), onError)}>×</button>
          </div>
          <input className="kg-reason" value={edge.reason} placeholder="关系依据（可选）" aria-label="关系依据"
            onChange={(event) => attempt(() => apply(updateKnowledgeEdge(document, edge.sourceKey, edge.targetKey, { reason: event.target.value }), { coalesce: `reason:${edge.sourceKey}>${edge.targetKey}` }), onError)} />
        </li>;
      })}
    </ul>
    {picking ? <NodePicker options={options} placeholder={`搜索要添加的${direction === "up" ? "前驱" : "后继"}`} onCancel={() => setPicking(false)}
      onPick={(key) => attempt(() => {
        apply(direction === "up" ? addKnowledgeEdge(document, key, node.key) : addKnowledgeEdge(document, node.key, key)); setPicking(false);
      }, onError)} />
      : <button type="button" className="kg-add-relation" onClick={() => setPicking(true)}>＋ 添加{direction === "up" ? "前驱" : "后继"}</button>}
  </section>;
}

// Paste a chapter outline: one point per line, optionally chained as a prerequisite sequence.
function BatchAdd({ topic, document, apply, onNotice, onError }: { topic: KnowledgeGraphNode; document: KnowledgeGraphDocument; apply: ApplyEdit; onNotice: (message: string) => void; onError: (message: string) => void }) {
  const [lines, setLines] = useState("");
  const [chain, setChain] = useState(true);
  const count = lines.split(/\r?\n/).filter((line) => line.trim()).length;
  return <details className="kg-more">
    <summary>批量添加知识点</summary>
    <p className="kg-muted">一行一个，格式：名称｜学会的标志｜别名、别名。已存在的同名知识点会跳过。</p>
    <textarea className="kg-batch" rows={6} value={lines} aria-label={`批量添加到「${topic.label}」`}
      placeholder={"配方法｜能用配方法解一元二次方程｜配方\n公式法｜能用求根公式解方程"} onChange={(event) => setLines(event.target.value)} />
    <label className="kg-check"><input type="checkbox" checked={chain} onChange={(event) => setChain(event.target.checked)} />按顺序连成前置链</label>
    <div className="kg-inline-buttons">
      <button type="button" className="primary" disabled={!count} onClick={() => attempt(() => {
        const result = addKnowledgeNodesFromLines(document, topic.key, lines, { chain });
        apply(result.document); setLines("");
        onNotice(`已添加 ${result.keys.length} 个知识点${result.skipped.length ? `，跳过 ${result.skipped.length} 个重复` : ""}`);
      }, onError)}>添加 {count || ""} 个</button>
    </div>
  </details>;
}

function MappingEditor({ node, document, apply, onError }: { node: KnowledgeGraphNode; document: KnowledgeGraphDocument; apply: ApplyEdit; onError: (message: string) => void }) {
  return <div className="kg-mapping-editor">
    {document.editions.map((edition) => {
      const mapping = document.mappings.find((item) => item.nodeKey === node.key && item.editionKey === edition.key);
      const update = (patch: Parameters<typeof setKnowledgeMapping>[3], coalesce?: string) => attempt(() => apply(setKnowledgeMapping(document, node.key, edition.key, patch), coalesce ? { coalesce } : undefined), onError);
      return <div key={edition.key} className="kg-mapping-row">
        <b>{edition.label}</b>
        <input value={mapping?.volume ?? ""} placeholder="册次，如 八下" aria-label={`${edition.label}册次`} onChange={(event) => update({ volume: event.target.value }, `mapping:${node.key}:${edition.key}:volume`)} />
        <input value={mapping?.unitLabel ?? ""} placeholder="章节，如 第十九章" aria-label={`${edition.label}章节`} onChange={(event) => update({ unitLabel: event.target.value }, `mapping:${node.key}:${edition.key}:unit`)} />
        <label className="kg-check"><input type="checkbox" checked={mapping?.alignmentStatus === "verified"} disabled={!mapping} onChange={(event) => update({ alignmentStatus: event.target.checked ? "verified" : "framework" })} />已核对</label>
        {mapping && <button type="button" className="kg-icon-button" aria-label={`清除${edition.label}定位`} onClick={() => update(null)}>×</button>}
      </div>;
    })}
  </div>;
}

export default function NodeEditor({ document, index, selection, publishedKeys, issues, autoFocusKey, apply, onSelect, onClose, onNotice, onError }: Props) {
  const [merging, setMerging] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const node = selection ? document.nodes.find((item) => item.key === selection.key) : undefined;
  // A freshly added node opens with its placeholder name selected, ready to type over.
  const focusName = Boolean(node && autoFocusKey === node.key);
  useEffect(() => { if (focusName) { nameRef.current?.focus(); nameRef.current?.select(); } }, [focusName]);
  if (!node || node.status === "archived") {
    return <div className="kg-inspector kg-editor-empty">
      <p className="kg-eyebrow">编辑模式</p>
      <h2>选择要调整的内容</h2>
      <p className="kg-muted">在左侧目录或点云中点选知识点，这里可以修改名称、学会的标志、别名和前后关系。</p>
      <ul className="kg-edit-tips">
        <li>“＋ 新增”添加主题或知识点；选中主题后可批量粘贴</li>
        <li>“连线”工具：先点前驱，再点后继</li>
        <li>整份草稿可从“更多 → 导入 JSON”载入</li>
        <li>修改自动保存为草稿，点“发布”后才会生效</li>
      </ul>
      {issues.length > 0 && <div className="kg-issue-box"><b>发布前需要处理 {issues.length} 个问题</b>
        <ul>{issues.slice(0, 6).map((issue, issueIndex) => <li key={`${issue.code}-${issueIndex}`}>
          {issue.nodeKey ? <button type="button" className="kg-link-button" onClick={() => onSelect({ kind: "node", key: issue.nodeKey! })}>{issue.message}</button> : issue.message}
        </li>)}</ul>
      </div>}
    </div>;
  }
  const published = publishedKeys.has(node.key);
  const nodeIssues = issues.filter((issue) => issue.nodeKey === node.key || issue.sourceKey === node.key || issue.targetKey === node.key || issue.cycle?.includes(node.key));
  const edit = (patch: Parameters<typeof updateKnowledgeNode>[2], coalesce?: string) => attempt(() => apply(updateKnowledgeNode(document, node.key, patch), coalesce ? { coalesce } : undefined), onError);
  const archiveNode = () => {
    const relations = document.edges.filter((edge) => edge.sourceKey === node.key || edge.targetKey === node.key).length;
    const message = published
      ? `停用「${node.label}」？它的 ${relations} 条关系会移除；历史题目与作业证据保留，但不再用于新标签。`
      : `删除「${node.label}」？这是本次草稿新增的内容，删除后不会留下记录。`;
    if (!window.confirm(message)) return;
    attempt(() => apply(removeKnowledgeNode(document, node.key, publishedKeys).document, { select: null }), onError);
  };
  const mergeOptions: PickerOption[] = index.activeNodes.filter((candidate) => candidate.level === node.level && candidate.key !== node.key && !index.hierarchy(candidate.key).includes(node.key))
    .map((candidate) => ({ key: candidate.key, label: candidate.label, search: searchText(candidate),
      hint: `${index.nodeByKey.get(candidate.domainKey)?.label ?? ""} · ${index.document.stages.find((stage) => stage.value === candidate.stage)?.label ?? ""}` }));
  const domains = index.domains;
  const topics = index.activeNodes.filter((item) => item.level === "topic").sort((left, right) => left.domainKey.localeCompare(right.domainKey) || left.stage - right.stage || left.order - right.order);
  const move = (direction: -1 | 1) => attempt(() => apply(moveKnowledgeNode(document, node.key, direction)), onError);
  return <div className="kg-inspector kg-editor" style={{ "--strip": index.nodeByKey.get(node.domainKey)?.color ?? node.color } as CSSProperties}>
    <p className="kg-eyebrow"><i className="kg-domain-swatch" />{LEVEL_LABEL[node.level]}<span className={`kg-publish-state ${published ? "" : "new"}`}>{published ? "已发布" : "新增 · 未发布"}</span>
      <button type="button" className="kg-icon-button" aria-label="收起编辑" onClick={onClose}>×</button></p>
    {nodeIssues.length > 0 && <div className="kg-issue-box">{nodeIssues.map((issue, issueIndex) => <p key={`${issue.code}-${issueIndex}`}>{issue.message}</p>)}</div>}
    <label className="kg-field"><span>名称</span>
      <input ref={nameRef} value={node.label} maxLength={40} onChange={(event) => edit({ label: event.target.value }, `label:${node.key}`)} />
    </label>
    {node.level === "domain" ? <>
      <div className="kg-field"><span>颜色</span>
        <div className="kg-swatches" role="group" aria-label="领域颜色">
          {[...new Set([...(node.color ? [node.color] : []), ...KNOWLEDGE_GRAPH_PALETTE])].map((color) => <button key={color} type="button" aria-label={`颜色 ${color}`} aria-pressed={node.color === color}
            className={node.color === color ? "active" : ""} style={{ background: color }} onClick={() => edit({ color })} />)}
        </div>
      </div>
      <div className="kg-field"><span>排列顺序</span>
        <div className="kg-inline-buttons">
          <button type="button" onClick={() => move(-1)}>前移</button>
          <button type="button" onClick={() => move(1)}>后移</button>
        </div>
      </div>
    </> : <>
      <div className="kg-field"><span>年级</span>
        <div className="kg-segmented" role="group" aria-label="年级">
          {document.stages.map((stage) => <button key={stage.value} type="button" aria-pressed={node.stage === stage.value} className={node.stage === stage.value ? "active" : ""}
            onClick={() => edit({ stage: stage.value })}>{stage.label}</button>)}
        </div>
      </div>
      {node.level === "topic" && <label className="kg-field"><span>所属领域</span>
        <select value={node.domainKey} onChange={(event) => edit({ domainKey: event.target.value })}>{domains.map((domain) => <option key={domain.key} value={domain.key}>{domain.label}</option>)}</select>
      </label>}
      {node.level === "point" && <label className="kg-field"><span>上级主题</span>
        <select value={node.parentKey} onChange={(event) => edit({ parentKey: event.target.value })}>
          {domains.map((domain) => <optgroup key={domain.key} label={domain.label}>
            {topics.filter((topic) => topic.domainKey === domain.key).map((topic) => <option key={topic.key} value={topic.key}>{topic.label}</option>)}
          </optgroup>)}
        </select>
      </label>}
    </>}
    <label className="kg-field"><span>描述</span>
      <textarea rows={2} value={node.description} maxLength={300} placeholder="一句话说明学什么" onChange={(event) => edit({ description: event.target.value }, `description:${node.key}`)} />
    </label>
    {node.level !== "domain" && <label className="kg-field"><span>学会的标志</span>
      <textarea rows={2} value={node.mastery ?? ""} maxLength={120} placeholder="能……（一句可检测的表现，如：能用配方法解一元二次方程）" onChange={(event) => edit({ mastery: event.target.value }, `mastery:${node.key}`)} />
    </label>}
    <div className="kg-field"><span>识别别名</span>
      <AliasInput values={node.aliases} onChange={(aliases) => edit({ aliases })} />
      <small>题目标签或题干出现这些词时，会自动归到这里</small>
    </div>
    {node.level !== "domain" && <>
      <RelationEditor direction="up" node={node} document={document} index={index} apply={apply} onSelect={onSelect} onError={onError} />
      <RelationEditor direction="down" node={node} document={document} index={index} apply={apply} onSelect={onSelect} onError={onError} />
      {node.level === "topic" && <BatchAdd topic={node} document={document} apply={apply} onNotice={onNotice} onError={onError} />}
      <details className="kg-more">
        <summary>教材定位与顺序</summary>
        <MappingEditor node={node} document={document} apply={apply} onError={onError} />
        <div className="kg-field"><span>{node.level === "topic" ? "在领域内的教材顺序（决定在漏斗中的高度）" : "在主题内的顺序"}</span>
          <div className="kg-inline-buttons">
            <button type="button" onClick={() => move(-1)}>前移</button>
            <button type="button" onClick={() => move(1)}>后移</button>
          </div>
        </div>
      </details>
    </>}
    <details className="kg-more danger">
      <summary>停用、合并或删除</summary>
      <p className="kg-muted">{published ? "已发布的内容不能直接删除：停用后历史题目和作业证据仍能追溯。" : "这是草稿里新增的内容，可以直接删除。"}</p>
      <div className="kg-inline-buttons">
        <button type="button" className="danger" onClick={archiveNode}>{published ? "停用" : "删除"}</button>
        {node.level !== "domain" && <button type="button" onClick={() => setMerging((value) => !value)}>合并到…</button>}
      </div>
      {merging && <NodePicker options={mergeOptions} placeholder="搜索合并目标" onCancel={() => setMerging(false)} onPick={(key) => {
        const target = index.nodeByKey.get(key);
        if (!window.confirm(`把「${node.label}」合并到「${target?.label ?? key}」？关系、下级知识点和别名会并入目标，历史证据自动归到目标。`)) return;
        attempt(() => { apply(mergeKnowledgeNode(document, node.key, key), { select: { kind: "node", key } }); setMerging(false); }, onError);
      }} />}
    </details>
  </div>;
}
