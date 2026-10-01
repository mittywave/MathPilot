import taxonomy from "../data/china-math-taxonomy.v1.json" with { type: "json" };
import { createKnowledgeGraphIndex, normalizeKnowledgeGraph, validateKnowledgeGraph } from "./knowledge-graph-core.mjs";

// The bundled JSON is version 1 of the editable graph. Published versions live in
// D1; this seed stays the fallback for tests, fresh databases and old evidence.
export const CHINA_MATH_TAXONOMY_VERSION = taxonomy.version;
export const CHINA_MATH_SEED_DOCUMENT = normalizeKnowledgeGraph(taxonomy);
export const CHINA_MATH_GRAPH = createKnowledgeGraphIndex(CHINA_MATH_SEED_DOCUMENT, { version: 1 });
export const CHINA_MATH_NODES = CHINA_MATH_SEED_DOCUMENT.nodes.map((node) => ({ ...node, dimension: "knowledge" }));
export const CHINA_MATH_EDGES = CHINA_MATH_SEED_DOCUMENT.edges;
export const CHINA_TEXTBOOK_EDITIONS = CHINA_MATH_SEED_DOCUMENT.editions;
export const CHINA_MATH_TAXONOMY = { ...taxonomy, nodes: CHINA_MATH_NODES };

export function validateChinaMathTaxonomy(value = taxonomy) {
  return validateKnowledgeGraph(normalizeKnowledgeGraph(value)).errors.map((issue) => issue.message);
}

export function chinaMathNodeFor(key) { return CHINA_MATH_GRAPH.nodeByKey.get(String(key)) ?? null; }
export function textbookMappingsFor(key) { return CHINA_MATH_GRAPH.mappingsFor(key); }
export function resolveChinaMathTaxonomyKeys(labels, stem = "") { return CHINA_MATH_GRAPH.resolveLabels(labels, stem); }
export function taxonomyEdgesFor(keys, options = {}) { return CHINA_MATH_GRAPH.edgesAround(keys, options.depth === undefined ? 2 : options.depth); }
export function taxonomyNodesFor(keys, options = {}) { return CHINA_MATH_GRAPH.nodesAround(keys, options.depth === undefined ? 2 : options.depth); }
