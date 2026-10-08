"use client";

import type { KnowledgeGraphIndex } from "../../../lib/knowledge-graph-core.mjs";
import type { CapabilityEdge, CapabilityProfileNode, KnowledgeGraphCoverage } from "../../../lib/types";
import { homeworkQuestionLabel } from "../../../lib/homework-grading-rules.mjs";
import { LEVEL_LABEL, STATUS_META, learningStatus, stageName } from "./graph-model";

type Props = {
  index: KnowledgeGraphIndex;
  nodeKey: string;
  colorOf: (key: string) => string;
  profile: Map<string, CapabilityProfileNode> | null;
  coverage: KnowledgeGraphCoverage | null;
  studentName: string;
  canGoBack: boolean;
  onBack: () => void;
  onClose: () => void;
  onSelect: (key: string) => void;
  view: "chain" | "cloud";
  onView: (view: "chain" | "cloud") => void;
  successors: { shown: number; total: number; all: boolean } | null;
  onAllSuccessors: (all: boolean) => void;
};

const VERDICT_LABEL = { correct: "正确", partial: "部分正确", incorrect: "错误" } as const;

function questionCount(index: KnowledgeGraphIndex, counts: Record<string, number> | undefined, key: string) {
  if (!counts) return 0;
  return (counts[key] ?? 0) + (index.children.get(key) ?? []).reduce((sum, child) => sum + (counts[child.key] ?? 0), 0);
}

function Relations({ title, empty, edges, pick, index, colorOf, profile, onSelect }: {
  title: string; empty: string; edges: CapabilityEdge[]; pick: (edge: CapabilityEdge) => string; index: KnowledgeGraphIndex;
  colorOf: (key: string) => string; profile: Map<string, CapabilityProfileNode> | null; onSelect: (key: string) => void;
}) {
  const rows = edges.map((edge) => ({ edge, node: index.nodeByKey.get(pick(edge)) })).filter((row) => row.node)
    .sort((left, right) => left.node!.stage - right.node!.stage || left.node!.order - right.node!.order);
  return <section className="kg-card-section">
    <h3>{title}<small>{rows.length}</small></h3>
    {rows.length ? <ul className="kg-card-list">
      {rows.map(({ edge, node }) => {
        const status = profile ? learningStatus(profile.get(node!.key)) : null;
        return <li key={node!.key}>
          <button type="button" onClick={() => onSelect(node!.key)} title={edge.reason || undefined}>
            <i style={{ background: status ? STATUS_META[status].color : colorOf(node!.key) }} aria-hidden="true" />
            <span>{node!.label}{edge.relationship === "supports" && <em>支撑</em>}</span>
            <small>{stageName(index, node!.stage).replace(/年级$/, "")}</small>
          </button>
        </li>;
      })}
    </ul> : <p className="kg-card-empty">{empty}</p>}
  </section>;
}

// Marble's selection card: where the node sits, how much it rests on, what it opens next.
export default function NodeCard({ index, nodeKey, colorOf, profile, coverage, studentName, canGoBack, onBack, onClose, onSelect, view, onView, successors, onAllSuccessors }: Props) {
  const node = index.nodeByKey.get(nodeKey);
  if (!node) return null;
  const domain = index.nodeByKey.get(node.domainKey);
  const parent = node.level === "point" ? index.nodeByKey.get(node.parentKey ?? "") : undefined;
  const incoming = index.incoming.get(node.key) ?? []; const outgoing = index.outgoing.get(node.key) ?? [];
  const ancestors = index.ancestors(node.key); const descendants = index.descendants(node.key);
  const points = node.level === "topic" ? index.children.get(node.key) ?? [] : [];
  const status = profile ? learningStatus(profile.get(node.key)) : null;
  const profileNode = profile?.get(node.key);
  const weakAncestors = status === "attention" || status === "developing"
    ? [...ancestors].filter((key) => learningStatus(profile?.get(key)) === "attention").map((key) => index.nodeByKey.get(key)?.label).filter(Boolean) : [];
  const untested = status && status !== "unassessed" && status !== "stable"
    ? incoming.map((edge) => edge.sourceKey).filter((key) => learningStatus(profile?.get(key)) === "unassessed").map((key) => index.nodeByKey.get(key)?.label).filter(Boolean) : [];
  const mappings = index.mappingsFor(node.key);
  const libraryCount = questionCount(index, coverage?.public, node.key);
  return <aside className="kg-card" aria-label={`${node.label}的详情`} data-inset="auto">
    <div className="kg-card-nav">
      {canGoBack ? <button type="button" className="kg-card-back" onClick={onBack}>← 返回</button> : <span />}
      <div className="kg-view-switch" role="group" aria-label="查看方式">
        <button type="button" aria-pressed={view === "chain"} className={view === "chain" ? "active" : ""} onClick={() => onView("chain")}>链路</button>
        <button type="button" aria-pressed={view === "cloud"} className={view === "cloud" ? "active" : ""} onClick={() => onView("cloud")}>点云</button>
      </div>
      <button type="button" className="kg-card-close" aria-label="关闭详情" onClick={onClose}>×</button>
    </div>
    <div className="kg-card-scroll">
      <p className="kg-card-eyebrow"><i style={{ background: colorOf(node.key) }} aria-hidden="true" />{domain?.label} · {stageName(index, node.stage)} · {LEVEL_LABEL[node.level]}</p>
      <h2>{node.label}</h2>
      {parent && <p className="kg-card-parent">属于 <button type="button" onClick={() => onSelect(parent.key)}>{parent.label}</button></p>}
      {node.description && <p className="kg-card-description">{node.description}</p>}
      {node.mastery && <div className="kg-card-mastery"><span>学会的标志</span><p>{node.mastery}</p></div>}
      <div className="kg-card-numbers">
        <div><b>{ancestors.size}</b><span>个前置知识点<small>{ancestors.size ? "一直追溯到起点" : "这是一个起点"}</small></span></div>
        <div><b>{descendants.size}</b><span>个后续知识点<small>{outgoing.length ? `直接解锁 ${outgoing.length} 个` : "暂时没有后续"}</small></span></div>
      </div>
      {status && <section className={`kg-card-student status-${status}`}>
        <p><i style={{ background: STATUS_META[status].color }} aria-hidden="true" /><b>{STATUS_META[status].label}</b><small>{studentName} · {profileNode?.evidenceCount ?? 0} 条证据</small></p>
        {weakAncestors.length > 0 && <p>根源可能在上游：<b>{weakAncestors.slice(0, 3).join("、")}</b></p>}
        {untested.length > 0 && <p>上游尚未检测：{untested.slice(0, 3).join("、")}，建议布置诊断题确认。</p>}
        {profileNode?.recentEvidence.length ? <ul className="kg-card-evidence">
          {profileNode.recentEvidence.slice(0, 4).map((item, itemIndex) => <li key={`${item.assignmentId}-${item.questionNumber}-${itemIndex}`}>
            <span className={`verdict ${item.verdict}`}>{VERDICT_LABEL[item.verdict]}</span>
            <b>{homeworkQuestionLabel(item.questionNumber || "?")}</b><small>{new Date(item.createdAt).toLocaleDateString("zh-CN")}</small>
            {item.diagnosis && <p>{item.diagnosis}</p>}
          </li>)}
        </ul> : null}
      </section>}
      <Relations title="直接建立在" empty="没有更早的前置，可以直接学。" edges={incoming} pick={(edge) => edge.sourceKey} index={index} colorOf={colorOf} profile={profile} onSelect={onSelect} />
      <Relations title="接下来解锁" empty="暂时没有直接的后续知识点。" edges={outgoing} pick={(edge) => edge.targetKey} index={index} colorOf={colorOf} profile={profile} onSelect={onSelect} />
      {successors && successors.total > successors.shown && !successors.all && <p className="kg-card-fold">
        链路图先显示最近的 {successors.shown} 个后续，另有 {successors.total - successors.shown} 个更远的<button type="button" onClick={() => onAllSuccessors(true)}>全部展开</button>
      </p>}
      {successors?.all && successors.total > 0 && <p className="kg-card-fold">已在链路图中展开全部 {successors.total} 个后续<button type="button" onClick={() => onAllSuccessors(false)}>只看最近的</button></p>}
      {points.length > 0 && <section className="kg-card-section">
        <h3>包含的知识点<small>{points.length}</small></h3>
        <div className="kg-card-chips">{points.map((point) => {
          const pointStatus = profile ? learningStatus(profile.get(point.key)) : null;
          return <button key={point.key} type="button" onClick={() => onSelect(point.key)}>
            {pointStatus && <i style={{ background: STATUS_META[pointStatus].color }} aria-hidden="true" />}{point.label}
          </button>;
        })}</div>
      </section>}
      <details className="kg-card-more">
        <summary>题库与教材</summary>
        <dl className="kg-card-facts">
          <div><dt>题库</dt><dd>{libraryCount} 题</dd></div>
        </dl>
        <ul className="kg-card-mappings">{mappings.map((mapping) => <li key={mapping.editionKey}>
          <b>{mapping.editionLabel}</b><span>{mapping.volume === "待校准" ? "尚未对应章节" : [mapping.volume, mapping.unitLabel].filter(Boolean).join(" · ") || "未设置"}</span>
          <em className={mapping.alignmentStatus}>{mapping.alignmentStatus === "verified" ? "已核对" : "待校准"}</em>
        </li>)}</ul>
        {node.aliases.length > 0 && <p className="kg-card-aliases"><span>识别别名</span>{node.aliases.join("、")}</p>}
      </details>
    </div>
  </aside>;
}
