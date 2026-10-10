import type { CapabilityEdge, KnowledgeGraphDocument, KnowledgeGraphLevel, TextbookTopicMapping } from "./types";

export function addKnowledgeNode(document: KnowledgeGraphDocument, input: { level: KnowledgeGraphLevel; label?: string; domainKey?: string; parentKey?: string; stage?: number }, random?: () => number): { document: KnowledgeGraphDocument; key: string };
export function updateKnowledgeNode(document: KnowledgeGraphDocument, key: string, patch: { label?: string; description?: string; mastery?: string; aliases?: string[]; stage?: number; color?: string; domainKey?: string; parentKey?: string }): KnowledgeGraphDocument;
export function moveKnowledgeNode(document: KnowledgeGraphDocument, key: string, direction: -1 | 1): KnowledgeGraphDocument;
export function removeKnowledgeNode(document: KnowledgeGraphDocument, key: string, publishedKeys?: Set<string>): { document: KnowledgeGraphDocument; archived: boolean; removedEdges: number };
export function restoreKnowledgeNode(document: KnowledgeGraphDocument, key: string): KnowledgeGraphDocument;
export function mergeKnowledgeNode(document: KnowledgeGraphDocument, sourceKey: string, targetKey: string): KnowledgeGraphDocument;
export function addKnowledgeEdge(document: KnowledgeGraphDocument, sourceKey: string, targetKey: string, relationship?: CapabilityEdge["relationship"], reason?: string): KnowledgeGraphDocument;
export function updateKnowledgeEdge(document: KnowledgeGraphDocument, sourceKey: string, targetKey: string, patch: { relationship?: CapabilityEdge["relationship"]; reason?: string }): KnowledgeGraphDocument;
export function removeKnowledgeEdge(document: KnowledgeGraphDocument, sourceKey: string, targetKey: string): KnowledgeGraphDocument;
export function setKnowledgeMapping(document: KnowledgeGraphDocument, nodeKey: string, editionKey: string, patch: Partial<Pick<TextbookTopicMapping, "volume" | "unitLabel" | "grade" | "alignmentStatus">> | null): KnowledgeGraphDocument;
export function addKnowledgeNodesFromLines(document: KnowledgeGraphDocument, topicKey: string, input: string, options?: { chain?: boolean }, random?: () => number): { document: KnowledgeGraphDocument; keys: string[]; skipped: string[] };
export function importKnowledgeGraphDraft(published: KnowledgeGraphDocument | null | undefined, raw: unknown): KnowledgeGraphDocument;
