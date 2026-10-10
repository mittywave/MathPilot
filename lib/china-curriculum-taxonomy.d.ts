import type { KnowledgeGraphIndex } from "./knowledge-graph-core.mjs";
import type { CapabilityEdge, CapabilityNode, KnowledgeGraphDocument, TextbookEdition, TextbookTopicMapping } from "./types";

export const CHINA_MATH_TAXONOMY: {
  version: string;
  title: string;
  scope: string;
  status: "foundation" | "verified";
  nodes: CapabilityNode[];
  edges: CapabilityEdge[];
  editions: TextbookEdition[];
  mappings: TextbookTopicMapping[];
};
export const CHINA_MATH_TAXONOMY_VERSION: string;
export const CHINA_MATH_SEED_DOCUMENT: KnowledgeGraphDocument;
export const CHINA_MATH_GRAPH: KnowledgeGraphIndex;
export const CHINA_MATH_NODES: CapabilityNode[];
export const CHINA_MATH_EDGES: CapabilityEdge[];
export const CHINA_TEXTBOOK_EDITIONS: TextbookEdition[];
export function validateChinaMathTaxonomy(value?: unknown): string[];
export function chinaMathNodeFor(key: string): CapabilityNode | null;
export function textbookMappingsFor(key: string): Array<TextbookTopicMapping & { editionLabel: string }>;
export function resolveChinaMathTaxonomyKeys(labels: string[], stem?: string): string[];
export function taxonomyEdgesFor(keys: string[], options?: { depth?: number }): CapabilityEdge[];
export function taxonomyNodesFor(keys: string[], options?: { depth?: number }): CapabilityNode[];
