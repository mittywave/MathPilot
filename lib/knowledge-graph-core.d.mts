import type { CapabilityEdge, CapabilityProfileNode, KnowledgeGraphChangeSummary, KnowledgeGraphDocument, KnowledgeGraphIssue, KnowledgeGraphNode, TextbookTopicMapping } from "./types";

export const KNOWLEDGE_GRAPH_SCHEMA_VERSION: 2;
export const KNOWLEDGE_GRAPH_PALETTE: string[];
export const KNOWLEDGE_GRAPH_LIMITS: { nodes: number; edges: number; label: number; description: number; mastery: number; aliases: number; alias: number; reason: number };
export const KNOWLEDGE_GRAPH_FUNNEL: { bandHeight: number; baseRadius: number; topRadius: number; bandPadding: number; domainGap: number; relaxRounds: number; relaxStrength: number };

export type KnowledgeGraphIndex = {
  document: KnowledgeGraphDocument;
  version: number;
  frameworkVersion: string;
  nodeByKey: Map<string, KnowledgeGraphNode>;
  activeNodes: KnowledgeGraphNode[];
  activeKeys: Set<string>;
  domains: KnowledgeGraphNode[];
  edges: CapabilityEdge[];
  outgoing: Map<string, CapabilityEdge[]>;
  incoming: Map<string, CapabilityEdge[]>;
  children: Map<string, KnowledgeGraphNode[]>;
  node(key: string): KnowledgeGraphNode | null;
  resolveKey(key: string): string | null;
  hierarchy(key: string): string[];
  resolveLabels(labels: string[], stem?: string): string[];
  mappingsFor(key: string): Array<TextbookTopicMapping & { editionLabel: string }>;
  edgesAround(keys: string[], depth?: number): CapabilityEdge[];
  nodesAround(keys: string[], depth?: number): KnowledgeGraphNode[];
  ancestors(key: string): Set<string>;
  descendants(key: string): Set<string>;
};

export type KnowledgeGraphPoint = { x: number; y: number; z: number; centrality: number };
export type KnowledgeGraphFunnel = {
  positions: Map<string, KnowledgeGraphPoint>;
  colors: Map<string, string>;
  sectors: Array<{ domainKey: string; label: string; color: string; start: number; end: number }>;
  bands: Array<{ stage: number; label: string; y0: number; y1: number }>;
  height: number;
  radius: { base: number; top: number };
};

export type KnowledgeGraphDiff = {
  nodes: { added: KnowledgeGraphNode[]; updated: Array<{ node: KnowledgeGraphNode; fields: string[] }>; archived: KnowledgeGraphNode[]; restored: KnowledgeGraphNode[]; removed: KnowledgeGraphNode[] };
  edges: { added: CapabilityEdge[]; removed: CapabilityEdge[]; updated: CapabilityEdge[] };
  meta: string[];
  count: number;
  changed: boolean;
};

export type KnowledgeGapRoot = {
  key: string; label: string; stage: number; domainKey: string; status: "attention" | "developing";
  evidenceCount: number; impact: number; weakDescendants: string[]; untestedPrerequisites: string[];
};
export type KnowledgeStageSummary = { stage: number; label: string; total: number; stable: number; developing: number; attention: number; insufficient: number; unassessed: number };
export type KnowledgeGapDiagnosis = {
  counts: { stable: number; developing: number; attention: number; insufficient: number; unassessed: number };
  roots: KnowledgeGapRoot[];
  developing: KnowledgeGapRoot[];
  stages: KnowledgeStageSummary[];
};

export function stageLabel(value: number): string;
export function normalizeKnowledgeGraph(raw: unknown): KnowledgeGraphDocument;
export function validateKnowledgeGraph(document: KnowledgeGraphDocument, options?: { previous?: KnowledgeGraphDocument | null }): { errors: KnowledgeGraphIssue[] };
export function createKnowledgeGraphIndex(document: KnowledgeGraphDocument, options?: { version?: number }): KnowledgeGraphIndex;
export function knowledgeGraphShade(color: string, index: number, count: number): string;
export function knowledgeGraphCentrality(index: KnowledgeGraphIndex): Map<string, number>;
export function layoutKnowledgeFunnel(document: KnowledgeGraphDocument, options?: { index?: KnowledgeGraphIndex; spacing?: Partial<typeof KNOWLEDGE_GRAPH_FUNNEL> }): KnowledgeGraphFunnel;
export type KnowledgeChain = {
  focus: string;
  levels: Array<{ rank: number; keys: string[] }>;
  edges: CapabilityEdge[];
  shortcuts: CapabilityEdge[];
  ancestors: number;
  descendants: { shown: number; total: number };
};
export function layoutKnowledgeChain(index: KnowledgeGraphIndex, focusKey: string, options?: { descendantLimit?: number }): KnowledgeChain | null;
export function preservePublishedNodes(document: KnowledgeGraphDocument, published: KnowledgeGraphDocument | null | undefined): KnowledgeGraphDocument;
export function diffKnowledgeGraphs(before: KnowledgeGraphDocument | null | undefined, after: KnowledgeGraphDocument | null | undefined): KnowledgeGraphDiff;
export function summarizeKnowledgeGraphDiff(diff: KnowledgeGraphDiff): KnowledgeGraphChangeSummary;
export function diagnoseKnowledgeGaps(index: KnowledgeGraphIndex, profileNodes: Array<Pick<CapabilityProfileNode, "key" | "status" | "evidenceCount">>): KnowledgeGapDiagnosis;
export function knowledgeGraphKeyPrefix(document: KnowledgeGraphDocument): string;
export function createKnowledgeGraphKey(document: KnowledgeGraphDocument, level?: string, random?: () => number): string;
