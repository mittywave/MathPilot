import type { KnowledgeChain, KnowledgeGraphFunnel, KnowledgeGraphIndex } from "../../../lib/knowledge-graph-core.mjs";
import type { CapabilityProfileNode, CapabilityStatus, KnowledgeGraphNode } from "../../../lib/types";
import type { CloudChain, CloudHighlight, CloudModel, CloudNode } from "./cloud-renderer";

export type GraphSelection = { kind: "node" | "domain"; key: string } | null;
export type GraphFilters = { stage: number | "all"; hiddenDomains: string[]; evidenceOnly: boolean };
export type LearningStatus = CapabilityStatus | "unassessed";
export type CloudView = { model: CloudModel; indexOf: Map<string, number>; keys: string[] };

// Tuned for the dark canvas: Marble red for attention, readable but not neon.
export const STATUS_META: Record<LearningStatus, { label: string; short: string; color: string }> = {
  attention: { label: "需要关注", short: "需关注", color: "#f0544b" },
  developing: { label: "正在形成", short: "形成中", color: "#e9b04c" },
  stable: { label: "表现稳定", short: "稳定", color: "#3fc48d" },
  insufficient: { label: "证据不足", short: "证据少", color: "#8e96ad" },
  unassessed: { label: "尚未检测", short: "未检测", color: "#4d556c" },
};
export const STATUS_ORDER: LearningStatus[] = ["attention", "developing", "stable", "insufficient", "unassessed"];
export const LEVEL_LABEL = { domain: "领域", topic: "主题", point: "知识点" } as const;

export function learningStatus(node?: Pick<CapabilityProfileNode, "status" | "evidenceCount"> | null): LearningStatus {
  return !node || !node.evidenceCount ? "unassessed" : node.status;
}

export function stageShort(label: string) { return label.replace(/年级$/, ""); }

export function stageName(index: KnowledgeGraphIndex, stage: number) {
  return index.document.stages.find((item) => item.value === stage)?.label ?? `${stage}`;
}

function normalized(value: string) { return value.trim().toLowerCase().replace(/\s+/g, ""); }

export function passesFilters(node: KnowledgeGraphNode, filters: GraphFilters, profile: Map<string, CapabilityProfileNode> | null) {
  if (filters.stage !== "all" && node.stage !== filters.stage) return false;
  if (filters.hiddenDomains.includes(node.domainKey)) return false;
  if (filters.evidenceOnly && profile && !profile.get(node.key)?.evidenceCount) return false;
  return true;
}

// Ranked lookup for the search box: names before aliases before descriptions, earlier grades first.
export function searchNodes(index: KnowledgeGraphIndex, query: string, limit = 8) {
  const needle = normalized(query);
  if (!needle) return [];
  const scored: Array<{ node: KnowledgeGraphNode; score: number }> = [];
  for (const node of index.activeNodes) {
    if (node.level === "domain") continue;
    const label = normalized(node.label);
    let score = label === needle ? 0 : label.startsWith(needle) ? 1 : label.includes(needle) ? 2 : -1;
    if (score < 0 && node.aliases.some((alias) => normalized(alias).includes(needle))) score = 3;
    if (score < 0 && normalized(node.description).includes(needle)) score = 4;
    if (score >= 0) scored.push({ node, score });
  }
  return scored.sort((left, right) => left.score - right.score || (left.node.level === "topic" ? -1 : 0) - (right.node.level === "topic" ? -1 : 0)
    || left.node.stage - right.node.stage || left.node.label.length - right.node.label.length).slice(0, limit).map((item) => item.node);
}

export function buildCloudView(input: {
  index: KnowledgeGraphIndex; funnel: KnowledgeGraphFunnel; filters: GraphFilters; profile: Map<string, CapabilityProfileNode> | null;
}): CloudView {
  const { index, funnel, filters, profile } = input;
  const nodes: CloudNode[] = []; const labels: string[] = []; const keys: string[] = []; const indexOf = new Map<string, number>();
  for (const node of index.activeNodes) {
    if (node.level === "domain") continue;
    const point = funnel.positions.get(node.key); if (!point) continue;
    const status = profile ? learningStatus(profile.get(node.key)) : null;
    indexOf.set(node.key, nodes.length); keys.push(node.key); labels.push(node.label);
    nodes.push({
      key: node.key, level: node.level === "topic" ? "topic" : "point", x: point.x, y: point.y, z: point.z, size: point.centrality,
      color: status ? STATUS_META[status].color : funnel.colors.get(node.key) ?? "#8a94a6",
      ghost: !passesFilters(node, filters, profile), faint: status === "unassessed", glow: Boolean(status && status !== "unassessed"),
    });
  }
  const edges = index.edges.flatMap((edge) => {
    const source = indexOf.get(edge.sourceKey); const target = indexOf.get(edge.targetKey);
    return source === undefined || target === undefined ? [] : [{ source, target, soft: edge.relationship === "supports" }];
  });
  return {
    model: { nodes, labels, edges, bands: funnel.bands.map((band) => ({ label: band.label, y0: band.y0, y1: band.y1 })), height: funnel.height, radius: funnel.radius },
    indexOf, keys,
  };
}

// Marble lights the whole prerequisite lineage; we add the direct unlocks (white, dashed)
// and, for a topic, its own points, so a selection always reads as "where from, where next".
export function buildHighlight(input: { view: CloudView; index: KnowledgeGraphIndex; selectedKey: string; marked: string[]; linkSourceKey: string }): CloudHighlight {
  const { view, index, selectedKey } = input;
  const at = (key: string) => view.indexOf.get(key) ?? -1;
  const focus = selectedKey ? at(selectedKey) : -1;
  const upstream = new Set<number>(); const next = new Set<number>(); const marked = new Set<number>(); const labels: number[] = [];
  if (focus >= 0) {
    for (const key of index.ancestors(selectedKey)) { const position = at(key); if (position >= 0) upstream.add(position); }
    for (const edge of index.outgoing.get(selectedKey) ?? []) { const position = at(edge.targetKey); if (position >= 0) next.add(position); }
    const node = index.nodeByKey.get(selectedKey);
    if (node?.level === "topic") for (const child of index.children.get(selectedKey) ?? []) { const position = at(child.key); if (position >= 0) upstream.add(position); }
    labels.push(focus);
    for (const edge of index.incoming.get(selectedKey) ?? []) { const position = at(edge.sourceKey); if (position >= 0) labels.push(position); }
    labels.push(...next);
  }
  for (const key of input.marked) { const position = at(key); if (position >= 0 && position !== focus) { marked.add(position); labels.push(position); } }
  return { focus, upstream, next, marked, labels: [...new Set(labels)].slice(0, 24), linkSource: input.linkSourceKey ? at(input.linkSourceKey) : -1 };
}

// Maps a chain onto renderer indices; a relation is on the prerequisite side when it ends at the focus or one of its ancestors.
export function buildChainView(view: CloudView, chain: KnowledgeChain | null): CloudChain | null {
  if (!chain) return null;
  const focus = view.indexOf.get(chain.focus); if (focus === undefined) return null;
  const ranks = new Map<string, number>();
  for (const level of chain.levels) for (const key of level.keys) ranks.set(key, level.rank);
  const relation = (edge: { sourceKey: string; targetKey: string }) => {
    const source = view.indexOf.get(edge.sourceKey); const target = view.indexOf.get(edge.targetKey);
    return source === undefined || target === undefined ? [] : [{ source, target, up: (ranks.get(edge.targetKey) ?? 1) <= 0 }];
  };
  return {
    focus,
    levels: chain.levels.map((level) => ({ rank: level.rank, nodes: level.keys.map((key) => view.indexOf.get(key)).filter((position): position is number => position !== undefined) }))
      .filter((level) => level.nodes.length),
    edges: chain.edges.flatMap(relation), shortcuts: chain.shortcuts.flatMap(relation),
  };
}
