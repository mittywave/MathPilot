// Pure editing operations for a knowledge-graph draft. Every operation returns a
// new document and throws an Error with teacher-facing copy when it would break
// the graph (cycles, hierarchy loops, deleting a node that history depends on).
import {
  KNOWLEDGE_GRAPH_LIMITS, KNOWLEDGE_GRAPH_PALETTE, createKnowledgeGraphKey, normalizeKnowledgeGraph, preservePublishedNodes, validateKnowledgeGraph,
} from "./knowledge-graph-core.mjs";

const DEFAULT_LABELS = { domain: "新领域", topic: "新主题", point: "新知识点" };

function copy(document) { return structuredClone(document); }
function nodeIn(document, key) {
  const node = document.nodes.find((item) => item.key === key);
  if (!node) throw new Error("知识点不存在或已被删除");
  return node;
}
function activeChildren(document, key) { return document.nodes.filter((node) => node.parentKey === key && node.level !== "domain" && node.status !== "archived"); }
function siblingsOf(document, node) {
  return document.nodes.filter((item) => item.status !== "archived" && item.level === node.level && (node.level === "domain" || item.parentKey === node.parentKey));
}
function uniqueLabel(document, level, parentKey, base) {
  const used = new Set(document.nodes.filter((node) => node.status !== "archived" && node.level === level && (level !== "point" || node.parentKey === parentKey)).map((node) => node.label));
  if (!used.has(base)) return base;
  for (let index = 2; index < 500; index += 1) if (!used.has(`${base} ${index}`)) return `${base} ${index}`;
  return `${base} ${Date.now()}`;
}
function hierarchyKeys(document, key) {
  const chain = []; const seen = new Set([key]); let current = document.nodes.find((node) => node.key === key);
  while (current?.parentKey && !seen.has(current.parentKey)) { seen.add(current.parentKey); chain.push(current.parentKey); current = document.nodes.find((node) => node.key === current.parentKey); }
  return chain;
}
function pathBetween(document, fromKey, toKey) {
  const previous = new Map([[fromKey, null]]); const queue = [fromKey];
  while (queue.length) {
    const key = queue.shift();
    if (key === toKey) break;
    for (const edge of document.edges) if (edge.sourceKey === key && !previous.has(edge.targetKey)) { previous.set(edge.targetKey, key); queue.push(edge.targetKey); }
  }
  if (!previous.has(toKey)) return null;
  const path = []; for (let key = toKey; key; key = previous.get(key)) path.unshift(key);
  return path;
}
function labelOf(document, key) { return document.nodes.find((node) => node.key === key)?.label ?? key; }
function assertNoCycle(document) {
  const cycle = validateKnowledgeGraph(document).errors.find((issue) => issue.code === "cycle");
  if (cycle) throw new Error(cycle.message);
}

export function addKnowledgeNode(document, input = {}, random) {
  const next = copy(document); const level = ["domain", "topic", "point"].includes(input.level) ? input.level : "topic";
  let domainKey = ""; let parentKey; let stage = Number(input.stage) || next.stages[0]?.value || 1;
  if (level === "topic") {
    const domain = nodeIn(next, input.domainKey);
    if (domain.level !== "domain" || domain.status === "archived") throw new Error("请选择一个有效的领域");
    domainKey = parentKey = domain.key;
  }
  if (level === "point") {
    const parent = nodeIn(next, input.parentKey);
    if (parent.level !== "topic" || parent.status === "archived") throw new Error("知识点需要放在一个主题下面");
    domainKey = parent.domainKey; parentKey = parent.key; stage = Number(input.stage) || parent.stage;
  }
  if (!next.stages.some((item) => item.value === stage)) stage = next.stages[0]?.value ?? stage;
  const key = createKnowledgeGraphKey(next, level, random);
  const siblings = next.nodes.filter((node) => node.level === level && (level === "domain" || node.parentKey === parentKey));
  const node = {
    key, label: uniqueLabel(next, level, parentKey, String(input.label ?? DEFAULT_LABELS[level]).trim().slice(0, KNOWLEDGE_GRAPH_LIMITS.label) || DEFAULT_LABELS[level]),
    level, domainKey: level === "domain" ? key : domainKey, stage, description: "", aliases: [],
    order: Math.max(-1, ...siblings.map((item) => item.order)) + 1, status: "active",
  };
  if (parentKey) node.parentKey = parentKey;
  if (level === "domain") {
    const used = new Set(next.nodes.filter((item) => item.level === "domain").map((item) => item.color));
    node.color = KNOWLEDGE_GRAPH_PALETTE.find((color) => !used.has(color)) ?? KNOWLEDGE_GRAPH_PALETTE[siblings.length % KNOWLEDGE_GRAPH_PALETTE.length];
  }
  next.nodes.push(node);
  return { document: next, key };
}

export function updateKnowledgeNode(document, key, patch = {}) {
  const next = copy(document); const node = nodeIn(next, key);
  if (typeof patch.label === "string") node.label = patch.label.slice(0, KNOWLEDGE_GRAPH_LIMITS.label);
  if (typeof patch.description === "string") node.description = patch.description.slice(0, KNOWLEDGE_GRAPH_LIMITS.description);
  if (typeof patch.mastery === "string" && node.level !== "domain") {
    const mastery = patch.mastery.slice(0, KNOWLEDGE_GRAPH_LIMITS.mastery);
    if (mastery) node.mastery = mastery; else delete node.mastery;
  }
  if (Array.isArray(patch.aliases)) {
    node.aliases = [...new Set(patch.aliases.map((alias) => String(alias).trim().slice(0, KNOWLEDGE_GRAPH_LIMITS.alias)).filter(Boolean))].slice(0, KNOWLEDGE_GRAPH_LIMITS.aliases);
  }
  if (patch.stage !== undefined && node.level !== "domain") {
    const stage = Number(patch.stage);
    if (!next.stages.some((item) => item.value === stage)) throw new Error("年级层不存在");
    node.stage = stage;
  }
  if (typeof patch.color === "string" && node.level === "domain" && /^#[0-9a-f]{6}$/i.test(patch.color)) node.color = patch.color.toLowerCase();
  if (typeof patch.domainKey === "string" && node.level === "topic" && patch.domainKey !== node.domainKey) {
    const domain = nodeIn(next, patch.domainKey);
    if (domain.level !== "domain" || domain.status === "archived") throw new Error("请选择一个有效的领域");
    node.domainKey = node.parentKey = domain.key;
    node.order = Math.max(-1, ...next.nodes.filter((item) => item.level === "topic" && item.parentKey === domain.key && item.key !== key).map((item) => item.order)) + 1;
    for (const child of next.nodes) if (child.parentKey === key && child.level === "point") child.domainKey = domain.key;
  }
  if (typeof patch.parentKey === "string" && node.level === "point" && patch.parentKey !== node.parentKey) {
    const parent = nodeIn(next, patch.parentKey);
    if (parent.level !== "topic" || parent.status === "archived") throw new Error("请选择一个有效的主题");
    const hierarchyEdge = next.edges.some((edge) => (edge.sourceKey === key && edge.targetKey === parent.key) || (edge.sourceKey === parent.key && edge.targetKey === key));
    if (hierarchyEdge) throw new Error(`「${node.label}」与「${parent.label}」之间已有前后关系，请先删除该关系再调整上级`);
    node.parentKey = parent.key; node.domainKey = parent.domainKey;
  }
  return next;
}

export function moveKnowledgeNode(document, key, direction) {
  const next = copy(document); const node = nodeIn(next, key);
  const siblings = siblingsOf(next, node).sort((left, right) => left.order - right.order || left.label.localeCompare(right.label, "zh-CN"));
  siblings.forEach((item, index) => { item.order = index; });
  const position = siblings.findIndex((item) => item.key === key); const target = siblings[position + (direction < 0 ? -1 : 1)];
  if (!target) return next;
  [node.order, target.order] = [target.order, node.order];
  return next;
}

export function removeKnowledgeNode(document, key, publishedKeys = new Set()) {
  const next = copy(document); const node = nodeIn(next, key);
  const children = activeChildren(next, key);
  if (children.length) throw new Error(`请先停用或移走「${node.label}」下的 ${children.length} 个下级知识点`);
  if (next.nodes.some((item) => item.mergedInto === key)) throw new Error(`已有知识点合并到「${node.label}」，不能再停用它`);
  const removedEdges = next.edges.filter((edge) => edge.sourceKey === key || edge.targetKey === key).length;
  next.edges = next.edges.filter((edge) => edge.sourceKey !== key && edge.targetKey !== key);
  const archived = publishedKeys.has(key);
  if (archived) { node.status = "archived"; delete node.mergedInto; }
  else {
    next.nodes = next.nodes.filter((item) => item.key !== key);
    next.mappings = next.mappings.filter((mapping) => mapping.nodeKey !== key);
  }
  return { document: next, archived, removedEdges };
}

export function restoreKnowledgeNode(document, key) {
  const next = copy(document); const node = nodeIn(next, key);
  const parent = node.parentKey ? next.nodes.find((item) => item.key === node.parentKey) : null;
  if (parent && parent.status === "archived") throw new Error(`请先恢复上级「${parent.label}」`);
  node.status = "active"; delete node.mergedInto;
  node.label = uniqueLabel({ ...next, nodes: next.nodes.filter((item) => item.key !== key) }, node.level, node.parentKey, node.label);
  return next;
}

export function mergeKnowledgeNode(document, sourceKey, targetKey) {
  const next = copy(document); const source = nodeIn(next, sourceKey); const target = nodeIn(next, targetKey);
  if (source.key === target.key) throw new Error("不能合并到自己");
  if (source.status === "archived" || target.status === "archived") throw new Error("只能合并两个启用中的知识点");
  if (source.level !== target.level || source.level === "domain") throw new Error("只能在同一层级的主题或知识点之间合并");
  if (hierarchyKeys(next, targetKey).includes(sourceKey)) throw new Error(`「${target.label}」属于「${source.label}」，不能合并`);
  for (const child of next.nodes) if (child.parentKey === sourceKey && child.level === "point") { child.parentKey = target.key; child.domainKey = target.domainKey; }
  const related = (left, right) => hierarchyKeys(next, left).includes(right) || hierarchyKeys(next, right).includes(left);
  const moved = new Map();
  for (const edge of next.edges) {
    const candidate = { ...edge, sourceKey: edge.sourceKey === sourceKey ? target.key : edge.sourceKey, targetKey: edge.targetKey === sourceKey ? target.key : edge.targetKey };
    if (candidate.sourceKey === candidate.targetKey || related(candidate.sourceKey, candidate.targetKey)) continue;
    const pair = `${candidate.sourceKey}>${candidate.targetKey}`;
    // Keep the target's own relation (and its reason) when both nodes already had one.
    if (!moved.has(pair) || (edge.sourceKey !== sourceKey && edge.targetKey !== sourceKey)) moved.set(pair, candidate);
  }
  next.edges = [...moved.values()];
  target.aliases = [...new Set([...target.aliases, source.label, ...source.aliases])].filter((alias) => alias !== target.label).slice(0, KNOWLEDGE_GRAPH_LIMITS.aliases);
  source.status = "archived"; source.mergedInto = target.key;
  for (const node of next.nodes) if (node.mergedInto === sourceKey) node.mergedInto = target.key;
  next.mappings = next.mappings.filter((mapping) => mapping.nodeKey !== sourceKey);
  assertNoCycle(next);
  return next;
}

export function addKnowledgeEdge(document, sourceKey, targetKey, relationship = "prerequisite", reason = "") {
  const next = copy(document); const source = nodeIn(next, sourceKey); const target = nodeIn(next, targetKey);
  if (source.key === target.key) throw new Error("前驱和后继不能是同一个知识点");
  if (source.level === "domain" || target.level === "domain") throw new Error("领域之间不设前后关系，请选择具体主题或知识点");
  if (source.status === "archived" || target.status === "archived") throw new Error("已停用的知识点不能添加关系");
  if (hierarchyKeys(next, sourceKey).includes(targetKey) || hierarchyKeys(next, targetKey).includes(sourceKey)) throw new Error(`「${source.label}」与「${target.label}」是上下级，不需要前后关系`);
  if (next.edges.some((edge) => edge.sourceKey === sourceKey && edge.targetKey === targetKey)) throw new Error(`已存在关系：${source.label} → ${target.label}`);
  const loop = pathBetween(next, targetKey, sourceKey);
  if (loop) throw new Error(`会形成循环：${[sourceKey, ...loop].map((key) => labelOf(next, key)).join(" → ")}`);
  const kind = relationship === "supports" ? "supports" : "prerequisite";
  next.edges.push({ sourceKey, targetKey, relationship: kind, strength: kind === "prerequisite" ? "hard" : "soft", reason: String(reason).trim().slice(0, KNOWLEDGE_GRAPH_LIMITS.reason) });
  return next;
}

export function updateKnowledgeEdge(document, sourceKey, targetKey, patch = {}) {
  const next = copy(document); const edge = next.edges.find((item) => item.sourceKey === sourceKey && item.targetKey === targetKey);
  if (!edge) throw new Error("关系不存在或已被删除");
  if (patch.relationship === "prerequisite" || patch.relationship === "supports") { edge.relationship = patch.relationship; edge.strength = patch.relationship === "prerequisite" ? "hard" : "soft"; }
  if (typeof patch.reason === "string") edge.reason = patch.reason.slice(0, KNOWLEDGE_GRAPH_LIMITS.reason);
  return next;
}

export function removeKnowledgeEdge(document, sourceKey, targetKey) {
  const next = copy(document);
  next.edges = next.edges.filter((edge) => !(edge.sourceKey === sourceKey && edge.targetKey === targetKey));
  return next;
}

export function setKnowledgeMapping(document, nodeKey, editionKey, patch) {
  const next = copy(document); const node = nodeIn(next, nodeKey);
  const index = next.mappings.findIndex((mapping) => mapping.nodeKey === nodeKey && mapping.editionKey === editionKey);
  if (patch === null) { if (index >= 0) next.mappings.splice(index, 1); return next; }
  const current = index >= 0 ? next.mappings[index] : { nodeKey, editionKey, grade: node.stage, volume: "", unitLabel: "", alignmentStatus: "framework" };
  const mapping = {
    ...current,
    ...(patch.volume !== undefined ? { volume: String(patch.volume).slice(0, 40) } : {}),
    ...(patch.unitLabel !== undefined ? { unitLabel: String(patch.unitLabel).slice(0, 80) } : {}),
    ...(patch.grade !== undefined ? { grade: Number(patch.grade) || node.stage } : {}),
    ...(patch.alignmentStatus !== undefined ? { alignmentStatus: patch.alignmentStatus === "verified" ? "verified" : "framework" } : {}),
  };
  if (index >= 0) next.mappings[index] = mapping; else next.mappings.push(mapping);
  return next;
}

// Bulk entry for big graphs: one point per line, "名称｜学会的标志｜别名1、别名2".
// Lines that repeat an existing point of the topic are skipped, not duplicated.
export function addKnowledgeNodesFromLines(document, topicKey, input, options = {}, random) {
  const topic = nodeIn(document, topicKey);
  if (topic.level !== "topic" || topic.status === "archived") throw new Error("批量添加需要先选中一个主题");
  const lines = String(input ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error("请至少输入一行知识点");
  if (lines.length > 200) throw new Error("一次最多添加 200 个知识点");
  const existing = new Set(document.nodes.filter((node) => node.parentKey === topicKey && node.status !== "archived").map((node) => node.label));
  let next = document; const keys = []; const skipped = [];
  for (const line of lines) {
    const [rawLabel = "", rawMastery = "", rawAliases = ""] = line.split(/[｜|]/).map((part) => part.trim());
    const label = rawLabel.slice(0, KNOWLEDGE_GRAPH_LIMITS.label);
    if (!label || existing.has(label)) { skipped.push(label || line); continue; }
    const added = addKnowledgeNode(next, { level: "point", parentKey: topicKey, label }, random);
    next = updateKnowledgeNode(added.document, added.key, { mastery: rawMastery, aliases: rawAliases.split(/[,，、;；]/) });
    if (options.chain && keys.length) next = addKnowledgeEdge(next, keys[keys.length - 1], added.key);
    existing.add(label); keys.push(added.key);
  }
  return { document: next, keys, skipped };
}

// Imports a full graph JSON (an export or a prepared draft) as the new draft.
// Nodes published since that file was made are kept as archived history.
export function importKnowledgeGraphDraft(published, raw) {
  const document = normalizeKnowledgeGraph(raw);
  if (!document.nodes.length) throw new Error("文件里没有知识点");
  if (published && document.graphId !== published.graphId) throw new Error(`这份文件属于另一张图谱（${document.graphId}）`);
  return preservePublishedNodes(document, published);
}
