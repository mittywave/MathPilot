import { CHINA_MATH_GRAPH, CHINA_MATH_TAXONOMY_VERSION } from "./china-curriculum-taxonomy.mjs";

// Every graph-aware helper takes an optional published graph index; without one
// the bundled V1 seed is used, which keeps old callers and tests unchanged.
export const CAPABILITY_FRAMEWORK_VERSION = CHINA_MATH_TAXONOMY_VERSION;

export const CORE_CAPABILITY_NODES = [
  { key: "skill:calculation", label: "计算准确性", dimension: "skill", description: "运算顺序、符号与结果准确性", level: "capability", domainKey: "skill:calculation", stage: 1 },
  { key: "skill:concept", label: "概念理解", dimension: "skill", description: "理解定义、性质与适用条件", level: "capability", domainKey: "skill:concept", stage: 1 },
  { key: "skill:reasoning", label: "逻辑推理", dimension: "skill", description: "步骤衔接、论证与推导", level: "capability", domainKey: "skill:reasoning", stage: 2 },
  { key: "skill:modeling", label: "数学建模", dimension: "skill", description: "从情境中建立数学关系", level: "capability", domainKey: "skill:modeling", stage: 3 },
  { key: "skill:expression", label: "表达与步骤", dimension: "skill", description: "书写规范、过程完整与结论清晰", level: "capability", domainKey: "skill:expression", stage: 2 },
];

export const CAPABILITY_GRAPH_EDGES = [
  { sourceKey: "skill:concept", targetKey: "skill:reasoning", relationship: "prerequisite", strength: "hard", reason: "清晰的概念理解是有效推理的基础" },
  { sourceKey: "skill:calculation", targetKey: "skill:modeling", relationship: "supports", strength: "soft", reason: "可靠计算帮助模型得到正确结论" },
  { sourceKey: "skill:reasoning", targetKey: "skill:modeling", relationship: "prerequisite", strength: "hard", reason: "建模需要组织条件并推导数量关系" },
  { sourceKey: "skill:reasoning", targetKey: "skill:expression", relationship: "supports", strength: "soft", reason: "完整推理需要清楚呈现步骤" },
];

const CORE_BY_KEY = new Map(CORE_CAPABILITY_NODES.map((node) => [node.key, node]));
const SKILL_KEYS = new Set(CORE_CAPABILITY_NODES.filter((node) => node.dimension === "skill").map((node) => node.key));
const LEGACY_KNOWLEDGE_KEYS = new Map([
  ["knowledge:number-algebra", "cn-math:domain:number-algebra"],
  ["knowledge:geometry", "cn-math:domain:geometry"],
  ["knowledge:statistics-probability", "cn-math:domain:statistics-probability"],
  ["knowledge:integrated-application", "cn-math:domain:integrated-application"],
]);

function text(value, limit = 80) { return typeof value === "string" ? value.trim().slice(0, limit) : ""; }
function unique(values, limit = 12) { return [...new Set(values.map((item) => text(item)).filter(Boolean))].slice(0, limit); }

export function normalizeKnowledgeTags(value) {
  if (Array.isArray(value)) return unique(value, 8);
  if (typeof value === "string") return unique(value.split(/[，,、;/]/), 8);
  return [];
}

export function knowledgeTagKey(label, graph = CHINA_MATH_GRAPH) {
  return graph.resolveLabels([label])[0] ?? "";
}

export function resolveKnowledgeTaxonomyKeys(labels, stem = "", graph = CHINA_MATH_GRAPH) { return graph.resolveLabels(normalizeKnowledgeTags(labels), stem); }

export function inferKnowledgeTags(stem) {
  const value = text(stem, 10_000);
  if (/概率|统计|频数|平均数|中位数|众数|方差/.test(value)) return ["统计与概率"];
  if (/三角形|四边形|圆|角|平行|垂直|全等|相似|坐标|图形/.test(value)) return ["图形与几何"];
  if (/方程|不等式|函数|代数式|有理数|实数|因式|分式|根式/.test(value)) return ["数与代数"];
  return ["综合与应用"];
}

export function normalizeCapabilityKeys(value, input = {}) {
  const supplied = Array.isArray(value) ? value.map((item) => text(item, 80)) : [];
  const valid = supplied.filter((key) => SKILL_KEYS.has(key));
  const errorType = text(input.errorType, 120);
  const questionType = text(input.questionType, 40);
  if (/计算|符号|运算/.test(errorType)) valid.push("skill:calculation");
  if (/概念|审题|条件/.test(errorType)) valid.push("skill:concept");
  if (/推理|证明|逻辑/.test(errorType) || questionType === "解答题") valid.push("skill:reasoning");
  if (/建模|应用|情境/.test(errorType)) valid.push("skill:modeling");
  if (/步骤|表达|漏答/.test(errorType) || questionType === "解答题") valid.push("skill:expression");
  if (!valid.length) valid.push(questionType === "解答题" ? "skill:reasoning" : "skill:concept");
  return [...new Set(valid)].slice(0, 4);
}

export function capabilityNodeFor(key, label = "", graph = CHINA_MATH_GRAPH) {
  const migratedKey = LEGACY_KNOWLEDGE_KEYS.get(key) ?? key;
  // Archived nodes that were merged still resolve to their merge target.
  const taxonomyNode = graph.node(migratedKey);
  if (taxonomyNode) return { ...taxonomyNode, dimension: "knowledge" };
  const core = CORE_BY_KEY.get(key);
  if (core) return { ...core };
  if (key.startsWith("knowledge:tag:")) {
    const resolvedNode = graph.node(graph.resolveLabels([label || key.slice("knowledge:tag:".length)])[0] ?? "");
    if (resolvedNode) return { ...resolvedNode, dimension: "knowledge" };
  }
  return null;
}

function evidenceScore(verdict) { return verdict === "correct" ? 1 : verdict === "partial" ? -0.35 : -1; }
function statusSummary(status, label) {
  if (status === "stable") return `${label}近期表现稳定`;
  if (status === "attention") return `${label}是当前优先改进方向`;
  if (status === "developing") return `${label}正在形成，需要继续巩固`;
  return `${label}证据仍在积累`;
}

export function buildCapabilityProfile(rawEvidence, options = {}) {
  const graph = options.graph ?? CHINA_MATH_GRAPH;
  const now = Number(options.now) || Date.now();
  const groups = new Map();
  for (const evidence of Array.isArray(rawEvidence) ? rawEvidence : []) {
    const rawKey = text(evidence.capabilityKey, 100); const label = text(evidence.capabilityLabel, 80);
    const node = capabilityNodeFor(rawKey, label, graph); if (!node) continue; const key = node.key;
    const createdAt = Number(evidence.createdAt) || now; const ageDays = Math.max(0, (now - createdAt) / 86_400_000);
    const confidence = Math.max(0, Math.min(1, Number(evidence.confidence) || 0));
    const weightedScore = evidenceScore(evidence.verdict) * Math.max(.25, confidence) * 0.5 ** (ageDays / 90);
    const bucket = groups.get(key) ?? { node, evidence: [] };
    bucket.evidence.push({ ...evidence, createdAt, weightedScore });
    groups.set(key, bucket);
  }

  const evidenceKnowledgeKeys = [...groups.keys()].filter((key) => graph.activeKeys.has(key));
  const visibleKnowledgeNodes = options.includeAllKnowledge ? graph.activeNodes : graph.nodesAround(evidenceKnowledgeKeys, 2);
  for (const node of [...visibleKnowledgeNodes, ...graph.domains]) {
    if (!groups.has(node.key)) groups.set(node.key, { node: { ...node, dimension: "knowledge" }, evidence: [] });
  }
  for (const core of CORE_CAPABILITY_NODES) if (!groups.has(core.key)) groups.set(core.key, { node: { ...core }, evidence: [] });
  const nodes = [...groups.values()].map(({ node, evidence }) => {
    const recent = evidence.sort((left, right) => right.createdAt - left.createdAt).slice(0, 20);
    const totalWeight = recent.reduce((sum, item) => sum + Math.max(.25, Number(item.confidence) || 0), 0);
    const mean = totalWeight ? recent.reduce((sum, item) => sum + item.weightedScore, 0) / totalWeight : 0;
    const status = recent.length < 2 ? "insufficient" : mean >= .35 ? "stable" : mean <= -.3 ? "attention" : "developing";
    return {
      ...node, status, evidenceCount: recent.length, summary: statusSummary(status, node.label),
      textbookMappings: node.dimension === "knowledge" ? graph.mappingsFor(node.key) : [],
      recentEvidence: recent.slice(0, 5).map((item) => ({ questionNumber: text(item.questionNumber, 40), verdict: item.verdict,
        diagnosis: text(item.diagnosis, 240), assignmentId: text(item.assignmentId, 100), createdAt: item.createdAt })),
    };
  }).sort((left, right) => right.evidenceCount - left.evidenceCount || left.label.localeCompare(right.label, "zh-CN"));

  const nodeKeys = new Set(nodes.map((node) => node.key));
  const knowledgeEdges = graph.edgesAround(nodes.filter((node) => node.dimension === "knowledge").map((node) => node.key), 0);
  const edges = [...knowledgeEdges, ...CAPABILITY_GRAPH_EDGES].filter((edge) => nodeKeys.has(edge.sourceKey) && nodeKeys.has(edge.targetKey));
  return { frameworkVersion: graph.frameworkVersion, studentId: text(options.studentId, 100),
    nodes, edges, textbookEditions: graph.document.editions, updatedAt: now };
}
