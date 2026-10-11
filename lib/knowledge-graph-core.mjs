// Pure knowledge-graph logic shared by the Worker, the editor and the 3D view.
// A graph document is versioned data: stable node keys are referenced by
// question tags and student evidence, so nodes are archived, never renamed away.

export const KNOWLEDGE_GRAPH_SCHEMA_VERSION = 2;
export const KNOWLEDGE_GRAPH_PALETTE = ["#4c6ef0", "#e76d95", "#e8b08a", "#9db8dc", "#8e6fe6", "#3fb6a8", "#e2c46b", "#c98bdb"];
export const KNOWLEDGE_GRAPH_LIMITS = { nodes: 2500, edges: 8000, label: 40, description: 300, mastery: 120, aliases: 20, alias: 30, reason: 120 };
export const KNOWLEDGE_GRAPH_FUNNEL = { bandHeight: 460, baseRadius: 150, topRadius: 520, bandPadding: .05, domainGap: .14, relaxRounds: 16, relaxStrength: .3 };

const STAGE_NAMES = { 1: "一年级", 2: "二年级", 3: "三年级", 4: "四年级", 5: "五年级", 6: "六年级", 7: "七年级", 8: "八年级", 9: "九年级", 10: "高一", 11: "高二", 12: "高三" };
const KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{2,119}$/i;
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const NODE_FIELDS = ["label", "level", "parentKey", "domainKey", "stage", "description", "mastery", "aliases", "order", "color", "mergedInto"];
const LEVEL_RANK = { domain: 0, topic: 1, point: 2 };

function text(value, limit) { return typeof value === "string" ? value.trim().slice(0, limit) : ""; }
function finite(value, fallback) { const number = Number(value); return Number.isFinite(number) ? number : fallback; }
function byOrder(left, right) { return left.order - right.order || left.label.localeCompare(right.label, "zh-CN") || left.key.localeCompare(right.key); }
function normalizedText(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s·•，,、；;：:（）()【】]+/g, "").replaceAll("[", "").replaceAll("]", "");
}

export function stageLabel(value) { return STAGE_NAMES[value] ?? `第 ${value} 层`; }

export function normalizeKnowledgeGraph(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const rawNodes = (Array.isArray(source.nodes) ? source.nodes : []).filter((node) => node && typeof node === "object");
  const legacyVersion = text(source.version, 120);
  const graphId = text(source.graphId, 80) || legacyVersion.replace(/-v\d+$/i, "") || "knowledge-graph";
  const stageInput = Array.isArray(source.stages) && source.stages.length
    ? source.stages.map((stage) => ({ value: Math.round(finite(stage?.value, Number.NaN)), label: text(stage?.label, 20) }))
    : rawNodes.map((node) => ({ value: Math.round(finite(node.stage, Number.NaN)), label: "" }));
  const stages = [...new Map(stageInput.filter((stage) => Number.isFinite(stage.value)).map((stage) => [stage.value, stage])).values()]
    .sort((left, right) => left.value - right.value)
    .map((stage) => ({ value: stage.value, label: stage.label || stageLabel(stage.value) }));
  let domainCount = 0;
  const nodes = rawNodes.map((node, index) => {
    const level = node.level === "domain" ? "domain" : node.level === "point" ? "point" : "topic";
    const key = text(node.key, 120);
    const domainKey = level === "domain" ? key : text(node.domainKey, 120);
    const aliases = [...new Set((Array.isArray(node.aliases) ? node.aliases : []).map((alias) => text(alias, KNOWLEDGE_GRAPH_LIMITS.alias)).filter(Boolean))]
      .slice(0, KNOWLEDGE_GRAPH_LIMITS.aliases);
    const result = {
      key, label: text(node.label, KNOWLEDGE_GRAPH_LIMITS.label), level, domainKey,
      stage: Math.round(finite(node.stage, stages[0]?.value ?? 1)),
      description: text(node.description, KNOWLEDGE_GRAPH_LIMITS.description), aliases,
      order: finite(node.order, index), status: node.status === "archived" ? "archived" : "active",
    };
    const mastery = level === "domain" ? "" : text(node.mastery, KNOWLEDGE_GRAPH_LIMITS.mastery);
    if (mastery) result.mastery = mastery;
    if (level === "topic") result.parentKey = domainKey;
    if (level === "point") result.parentKey = text(node.parentKey, 120);
    if (level === "domain") result.color = HEX_COLOR.test(String(node.color ?? "")) ? String(node.color).toLowerCase() : KNOWLEDGE_GRAPH_PALETTE[domainCount % KNOWLEDGE_GRAPH_PALETTE.length];
    if (level === "domain") domainCount += 1;
    const mergedInto = text(node.mergedInto, 120);
    if (result.status === "archived" && mergedInto) result.mergedInto = mergedInto;
    return result;
  });
  const edges = (Array.isArray(source.edges) ? source.edges : []).filter((edge) => edge && typeof edge === "object").map((edge) => {
    const relationship = edge.relationship === "supports" ? "supports" : "prerequisite";
    return { sourceKey: text(edge.sourceKey, 120), targetKey: text(edge.targetKey, 120), relationship,
      strength: relationship === "prerequisite" ? "hard" : "soft", reason: text(edge.reason, KNOWLEDGE_GRAPH_LIMITS.reason) };
  });
  const editions = (Array.isArray(source.editions) ? source.editions : []).filter((item) => item && typeof item === "object")
    .map((item) => ({ key: text(item.key, 40), label: text(item.label, 40), publisher: text(item.publisher, 80) }));
  const mappings = (Array.isArray(source.mappings) ? source.mappings : []).filter((item) => item && typeof item === "object")
    .map((item) => ({ nodeKey: text(item.nodeKey, 120), editionKey: text(item.editionKey, 40), grade: Math.round(finite(item.grade, stages[0]?.value ?? 1)),
      volume: text(item.volume, 40), unitLabel: text(item.unitLabel, 80), alignmentStatus: item.alignmentStatus === "verified" ? "verified" : "framework" }));
  return {
    schemaVersion: KNOWLEDGE_GRAPH_SCHEMA_VERSION, graphId, title: text(source.title, 60) || "知识图谱", scope: text(source.scope, 120),
    status: source.status === "verified" ? "verified" : "foundation", stages, nodes, edges, editions, mappings,
  };
}

function findCycle(keys, outgoing) {
  const state = new Map();
  for (const start of keys) {
    if (state.get(start)) continue;
    const stack = [[start, 0]]; const path = [start]; state.set(start, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1]; const targets = outgoing.get(frame[0]) ?? [];
      if (frame[1] >= targets.length) { state.set(frame[0], 2); stack.pop(); path.pop(); continue; }
      const next = targets[frame[1]]; frame[1] += 1;
      if (state.get(next) === 1) return [...path.slice(path.indexOf(next)), next];
      if (!state.get(next)) { state.set(next, 1); stack.push([next, 0]); path.push(next); }
    }
  }
  return null;
}

function hierarchyChain(key, byKey) {
  const chain = []; const seen = new Set([key]); let current = byKey.get(key);
  while (current?.parentKey && !seen.has(current.parentKey)) { seen.add(current.parentKey); chain.push(current.parentKey); current = byKey.get(current.parentKey); }
  return chain;
}

// Errors are written for teachers: every message names the knowledge points involved.
export function validateKnowledgeGraph(document, options = {}) {
  const errors = []; const add = (code, message, extra = {}) => errors.push({ code, message, ...extra });
  const nodes = Array.isArray(document?.nodes) ? document.nodes : []; const edges = Array.isArray(document?.edges) ? document.edges : [];
  const stageValues = new Set((document?.stages ?? []).map((stage) => stage.value));
  if (!stageValues.size) add("stages", "图谱至少需要一个年级层");
  if (!nodes.some((node) => node.level === "domain" && node.status !== "archived")) add("empty", "图谱至少需要一个领域");
  if (nodes.length > KNOWLEDGE_GRAPH_LIMITS.nodes) add("limit", `知识点数量超过上限 ${KNOWLEDGE_GRAPH_LIMITS.nodes}`);
  if (edges.length > KNOWLEDGE_GRAPH_LIMITS.edges) add("limit", `关系数量超过上限 ${KNOWLEDGE_GRAPH_LIMITS.edges}`);
  const byKey = new Map();
  for (const node of nodes) {
    if (!KEY_PATTERN.test(node.key)) add("key", `知识点编号无效：${node.key || "（空）"}`, { nodeKey: node.key });
    else if (byKey.has(node.key)) add("duplicate-key", `知识点编号重复：${node.key}`, { nodeKey: node.key });
    else byKey.set(node.key, node);
  }
  const name = (key) => byKey.get(key)?.label || key;
  const labels = new Map();
  for (const node of byKey.values()) {
    const label = node.label || node.key;
    if (!String(node.label ?? "").trim()) add("label", `有知识点缺少名称（${node.key}）`, { nodeKey: node.key });
    if (!stageValues.has(node.stage)) add("stage", `「${label}」所在的年级层不存在`, { nodeKey: node.key });
    if (node.level !== "domain") {
      const domain = byKey.get(node.domainKey); const parent = byKey.get(node.parentKey);
      if (!domain || domain.level !== "domain") add("domain", `「${label}」所属的领域不存在`, { nodeKey: node.key });
      if (node.level === "topic" && node.parentKey !== node.domainKey) add("parent", `主题「${label}」必须直接属于一个领域`, { nodeKey: node.key });
      if (node.level === "point" && (!parent || parent.level !== "topic")) add("parent", `知识点「${label}」必须属于一个主题`, { nodeKey: node.key });
      else if (node.level === "point" && parent.domainKey !== node.domainKey) add("parent", `知识点「${label}」与上级主题不在同一领域`, { nodeKey: node.key });
      if (node.status === "active" && parent?.status === "archived") add("archived-parent", `「${label}」的上级「${parent.label}」已停用`, { nodeKey: node.key });
    }
    if (node.status === "archived" && node.mergedInto) {
      let target = byKey.get(node.mergedInto); const seen = new Set([node.key]);
      while (target?.status === "archived" && target.mergedInto && !seen.has(target.key)) { seen.add(target.key); target = byKey.get(target.mergedInto); }
      if (!target || target.status === "archived") add("merge", `「${label}」的合并目标不存在或已停用`, { nodeKey: node.key });
    }
    if (node.status === "active" && node.label) {
      const scope = node.level === "point" ? `point:${node.parentKey}` : node.level;
      const identity = `${scope}:${normalizedText(node.label)}`;
      if (labels.has(identity)) add("duplicate-label", `名称重复：「${node.label}」`, { nodeKey: node.key });
      labels.set(identity, node.key);
    }
  }
  const outgoing = new Map(); const pairs = new Set();
  for (const edge of edges) {
    const source = byKey.get(edge.sourceKey); const target = byKey.get(edge.targetKey);
    const extra = { sourceKey: edge.sourceKey, targetKey: edge.targetKey };
    if (!source || !target) { add("edge-missing", `关系引用了不存在的知识点：${name(edge.sourceKey)} → ${name(edge.targetKey)}`, extra); continue; }
    if (source.key === target.key) { add("edge-self", `「${source.label}」不能以自己为前驱`, extra); continue; }
    if (source.level === "domain" || target.level === "domain") { add("edge-domain", `领域之间不设前后关系：${source.label} → ${target.label}`, extra); continue; }
    if (source.status === "archived" || target.status === "archived") { add("edge-archived", `已停用的知识点不能保留关系：${source.label} → ${target.label}`, extra); continue; }
    if (hierarchyChain(source.key, byKey).includes(target.key) || hierarchyChain(target.key, byKey).includes(source.key)) {
      add("edge-hierarchy", `上下级之间不需要前后关系：${source.label} → ${target.label}`, extra); continue;
    }
    const pair = `${source.key}>${target.key}`;
    if (pairs.has(pair)) { add("edge-duplicate", `关系重复：${source.label} → ${target.label}`, extra); continue; }
    pairs.add(pair); outgoing.set(source.key, [...(outgoing.get(source.key) ?? []), target.key]);
  }
  const cycle = findCycle([...byKey.keys()], outgoing);
  if (cycle) add("cycle", `形成循环：${cycle.map(name).join(" → ")}`, { cycle });
  const editionKeys = new Set((document?.editions ?? []).map((edition) => edition.key));
  for (const mapping of document?.mappings ?? []) {
    if (!byKey.has(mapping.nodeKey)) add("mapping", `教材定位引用了不存在的知识点：${mapping.nodeKey}`, { nodeKey: mapping.nodeKey });
    else if (!editionKeys.has(mapping.editionKey)) add("mapping", `「${name(mapping.nodeKey)}」的教材版本不存在：${mapping.editionKey}`, { nodeKey: mapping.nodeKey });
  }
  for (const node of options.previous?.nodes ?? []) {
    const current = byKey.get(node.key);
    if (!current) add("removed-published", `已发布的「${node.label}」不能删除，请改为停用`, { nodeKey: node.key });
    else if ((current.level === "domain") !== (node.level === "domain")) add("level-change", `已发布的「${node.label}」不能在领域与知识点之间切换层级`, { nodeKey: node.key });
  }
  return { errors };
}

export function createKnowledgeGraphIndex(document, options = {}) {
  const version = Math.max(1, Math.round(finite(options.version, 1)));
  const nodeByKey = new Map(document.nodes.map((node) => [node.key, node]));
  const activeNodes = document.nodes.filter((node) => node.status !== "archived");
  const activeKeys = new Set(activeNodes.map((node) => node.key));
  const edges = document.edges.filter((edge) => activeKeys.has(edge.sourceKey) && activeKeys.has(edge.targetKey) && edge.sourceKey !== edge.targetKey);
  const outgoing = new Map(); const incoming = new Map(); const children = new Map();
  for (const edge of edges) {
    outgoing.set(edge.sourceKey, [...(outgoing.get(edge.sourceKey) ?? []), edge]);
    incoming.set(edge.targetKey, [...(incoming.get(edge.targetKey) ?? []), edge]);
  }
  for (const node of [...activeNodes].sort(byOrder)) if (node.parentKey && node.level !== "domain") children.set(node.parentKey, [...(children.get(node.parentKey) ?? []), node]);
  const editions = new Map(document.editions.map((edition) => [edition.key, edition]));
  const matchable = activeNodes.filter((node) => node.level !== "domain")
    .map((node) => ({ node, aliases: [...new Set([node.label, ...node.aliases].map(normalizedText).filter(Boolean))] }));
  const domains = activeNodes.filter((node) => node.level === "domain").sort(byOrder);
  const matchableDomains = domains.map((node) => ({ node, aliases: [node.label, ...node.aliases].map(normalizedText).filter(Boolean) }));
  const fallbackDomain = domains.find((node) => node.key.endsWith(":integrated-application") || node.label === "综合与应用") ?? null;

  function walk(key, map, pick) {
    const result = new Set(); const queue = [key];
    while (queue.length) {
      for (const edge of map.get(queue.shift()) ?? []) {
        const next = pick(edge);
        if (next !== key && !result.has(next)) { result.add(next); queue.push(next); }
      }
    }
    return result;
  }
  function resolveKey(key) {
    let current = nodeByKey.get(String(key));
    for (let hop = 0; current && hop < 8; hop += 1) {
      if (current.status !== "archived") return current.key;
      current = current.mergedInto ? nodeByKey.get(current.mergedInto) : undefined;
    }
    return null;
  }
  function hierarchy(key) { return hierarchyChain(key, nodeByKey); }
  function resolveLabels(labels, stem = "") {
    const inputs = [...(Array.isArray(labels) ? labels : []), stem].map(normalizedText).filter(Boolean);
    const matches = new Map();
    for (const input of inputs) {
      const scored = [];
      for (const { node, aliases } of matchable) {
        let score = 0;
        for (const alias of aliases) if (input.includes(alias)) score = Math.max(score, alias.length);
        if (score) scored.push({ key: node.key, score, stage: node.stage, level: LEVEL_RANK[node.level] });
      }
      const best = Math.max(0, ...scored.map((item) => item.score));
      for (const item of scored) if (item.score === best && (matches.get(item.key)?.score ?? 0) <= item.score) matches.set(item.key, item);
    }
    const exact = [...matches.values()].sort((left, right) => right.score - left.score || right.level - left.level || right.stage - left.stage)
      .slice(0, 4).map((item) => item.key);
    if (exact.length) return exact;
    const domain = matchableDomains.find(({ aliases }) => aliases.some((alias) => inputs.some((input) => input.includes(alias))));
    return domain ? [domain.node.key] : fallbackDomain ? [fallbackDomain.key] : [];
  }
  function mappingsFor(key) {
    const exact = document.mappings.filter((mapping) => mapping.nodeKey === key)
      .map((mapping) => ({ ...mapping, editionLabel: editions.get(mapping.editionKey)?.label ?? mapping.editionKey }));
    if (exact.length) return exact;
    const node = nodeByKey.get(key); if (!node) return [];
    // Fine-grained points inherit the textbook position of their topic until a teacher calibrates them.
    if (node.level === "point" && node.parentKey && node.parentKey !== key) {
      const inherited = mappingsFor(node.parentKey).filter((mapping) => mapping.nodeKey === node.parentKey && mapping.volume !== "待校准");
      if (inherited.length) return inherited.map((mapping) => ({ ...mapping, nodeKey: key }));
    }
    return document.editions.map((edition) => ({ nodeKey: key, editionKey: edition.key, editionLabel: edition.label,
      grade: node.stage, volume: "待校准", unitLabel: `${node.label} · 章节待校准`, alignmentStatus: "framework" }));
  }
  function edgesAround(keys, depth = 2) {
    const selected = new Set((Array.isArray(keys) ? keys : []).filter((key) => activeKeys.has(key)));
    const steps = Math.max(0, Math.min(4, Math.round(finite(depth, 2))));
    for (let step = 0; step < steps; step += 1) {
      for (const edge of edges) if (selected.has(edge.sourceKey) || selected.has(edge.targetKey)) { selected.add(edge.sourceKey); selected.add(edge.targetKey); }
    }
    return edges.filter((edge) => selected.has(edge.sourceKey) && selected.has(edge.targetKey));
  }
  function nodesAround(keys, depth = 2) {
    const selected = new Set((Array.isArray(keys) ? keys : []).filter((key) => activeKeys.has(key)));
    for (const edge of edgesAround([...selected], depth)) { selected.add(edge.sourceKey); selected.add(edge.targetKey); }
    for (const key of [...selected]) for (const parent of hierarchy(key)) selected.add(parent);
    return [...selected].map((key) => nodeByKey.get(key)).filter(Boolean);
  }
  return {
    document, version, frameworkVersion: `${document.graphId}-v${version}`, nodeByKey, activeNodes, activeKeys, domains, edges, outgoing, incoming, children,
    node: (key) => { const resolved = resolveKey(key); return resolved ? nodeByKey.get(resolved) : null; },
    resolveKey, hierarchy, resolveLabels, mappingsFor, edgesAround, nodesAround,
    ancestors: (key) => walk(key, incoming, (edge) => edge.sourceKey),
    descendants: (key) => walk(key, outgoing, (edge) => edge.targetKey),
  };
}

function hashUnit(value, salt = 0) {
  let hash = (2166136261 ^ salt) >>> 0;
  for (let position = 0; position < value.length; position += 1) { hash ^= value.charCodeAt(position); hash = Math.imul(hash, 16777619); }
  hash ^= hash >>> 13; hash = Math.imul(hash, 0x5bd1e995); hash ^= hash >>> 15;
  return (hash >>> 0) / 4294967296;
}

function hexToHsl(hex) {
  const value = Number.parseInt(String(hex).slice(1), 16) || 0;
  const red = (value >> 16) / 255; const green = ((value >> 8) & 255) / 255; const blue = (value & 255) / 255;
  const max = Math.max(red, green, blue); const min = Math.min(red, green, blue); const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];
  const delta = max - min; const saturation = lightness > .5 ? delta / (2 - max - min) : delta / (max + min);
  const hue = max === red ? (green - blue) / delta + (green < blue ? 6 : 0) : max === green ? (blue - red) / delta + 2 : (red - green) / delta + 4;
  return [hue * 60, saturation, lightness];
}

function hslToHex(hue, saturation, lightness) {
  const h = ((hue % 360) + 360) % 360 / 360; const s = Math.max(0, Math.min(1, saturation)); const l = Math.max(0, Math.min(1, lightness));
  const channel = (offset) => {
    const t = ((h + offset) % 1 + 1) % 1; const q = l < .5 ? l * (1 + s) : l + s - l * s; const p = 2 * l - q;
    const value = t < 1 / 6 ? p + (q - p) * 6 * t : t < .5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
    return Math.round(value * 255).toString(16).padStart(2, "0");
  };
  return `#${channel(1 / 3)}${channel(0)}${channel(-1 / 3)}`;
}

// Like Marble's domain shades inside one subject colour: neighbouring topics of a
// domain get interleaved lightness/hue so adjacent layers stay distinguishable.
export function knowledgeGraphShade(color, index, count) {
  if (count <= 1) return color;
  const [hue, saturation, lightness] = hexToHsl(color);
  const step = ((index * .618034) % 1) - .5;
  return hslToHex(hue + step * 16, saturation + (index / (count - 1) - .5) * .08, lightness + step * .2);
}

function popcount(value) {
  let bits = value - ((value >>> 1) & 0x55555555);
  bits = (bits & 0x33333333) + ((bits >>> 2) & 0x33333333);
  return (((bits + (bits >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// Number of everything downstream of each node. Descendant sets are unioned as
// bitsets in reverse topological order, so a 2,500-node graph stays in milliseconds;
// a draft that still contains a cycle falls back to walking each node.
function descendantCounts(index, nodes) {
  const position = new Map(nodes.map((node, offset) => [node.key, offset]));
  const size = nodes.length; const words = Math.max(1, Math.ceil(size / 32));
  const targets = nodes.map(() => []); const indegree = new Int32Array(size);
  for (const edge of index.edges) {
    const source = position.get(edge.sourceKey); const target = position.get(edge.targetKey);
    if (source === undefined || target === undefined) continue;
    targets[source].push(target); indegree[target] += 1;
  }
  const order = []; const queue = [];
  for (let offset = 0; offset < size; offset += 1) if (!indegree[offset]) queue.push(offset);
  while (queue.length) { const offset = queue.pop(); order.push(offset); for (const target of targets[offset]) if (--indegree[target] === 0) queue.push(target); }
  if (order.length !== size) return nodes.map((node) => index.descendants(node.key).size);
  const bits = new Uint32Array(size * words); const counts = new Array(size).fill(0);
  for (let step = size - 1; step >= 0; step -= 1) {
    const offset = order[step]; const base = offset * words;
    for (const target of targets[offset]) {
      bits[base + (target >>> 5)] |= 1 << (target & 31);
      const from = target * words; for (let word = 0; word < words; word += 1) bits[base + word] |= bits[from + word];
    }
    let count = 0; for (let word = 0; word < words; word += 1) count += popcount(bits[base + word]);
    counts[offset] = count;
  }
  return counts;
}

// Foundational knowledge unlocks more: size follows the number of everything downstream.
export function knowledgeGraphCentrality(index) {
  const nodes = index.activeNodes.filter((node) => node.level !== "domain");
  const counts = descendantCounts(index, nodes);
  const scale = Math.log(1 + Math.max(1, ...counts));
  return new Map(nodes.map((node, offset) => [node.key, Math.max(.02, Math.log(1 + counts[offset]) / scale)]));
}

function circularMean(angles) {
  let x = 0; let y = 0;
  for (const angle of angles) { x += Math.cos(angle); y += Math.sin(angle); }
  return Math.atan2(y, x);
}

// Funnel layout after Marble: height is the learning sequence (one band per grade,
// chapters stacked inside it by textbook order), the funnel widens upward, each
// domain owns a wedge, and points drift toward the angles of what they connect to.
export function layoutKnowledgeFunnel(document, options = {}) {
  const index = options.index ?? createKnowledgeGraphIndex(document);
  const geometry = { ...KNOWLEDGE_GRAPH_FUNNEL, ...options.spacing };
  const stageIndex = new Map(document.stages.map((stage, position) => [stage.value, position]));
  const height = Math.max(1, stageIndex.size) * geometry.bandHeight;
  const radiusAt = (y) => geometry.baseRadius + (geometry.topRadius - geometry.baseRadius) * Math.max(0, Math.min(1, y / height));
  const topics = index.activeNodes.filter((node) => node.level === "topic" && stageIndex.has(node.stage));
  const pointsOf = new Map(topics.map((topic) => [topic.key, (index.children.get(topic.key) ?? []).filter((child) => child.level === "point")]));
  const weight = (topic) => 1 + pointsOf.get(topic.key).length;
  const domains = index.domains;
  const domainWeights = domains.map((domain) => Math.max(1, topics.filter((topic) => topic.domainKey === domain.key).reduce((sum, topic) => sum + weight(topic), 0)));
  const total = domainWeights.reduce((sum, value) => sum + value, 0);
  const usable = Math.PI * 2 - geometry.domainGap * domains.length;
  let cursor = -Math.PI / 2 - (domains.length ? usable * domainWeights[0] / total / 2 : 0);
  const sectors = domains.map((domain, domainIndex) => {
    const span = usable * domainWeights[domainIndex] / total;
    const sector = { domainKey: domain.key, label: domain.label, color: domain.color ?? KNOWLEDGE_GRAPH_PALETTE[domainIndex % KNOWLEDGE_GRAPH_PALETTE.length], start: cursor, end: cursor + span };
    cursor += span + geometry.domainGap; return sector;
  });
  const sectorOf = new Map(sectors.map((sector) => [sector.domainKey, sector]));
  const slices = new Map(); const colors = new Map();
  for (const sector of sectors) {
    const domainTopics = topics.filter((topic) => topic.domainKey === sector.domainKey).sort((left, right) => left.stage - right.stage || byOrder(left, right));
    domainTopics.forEach((topic, topicIndex) => {
      const shade = knowledgeGraphShade(sector.color, topicIndex, domainTopics.length);
      colors.set(topic.key, shade);
      for (const point of pointsOf.get(topic.key)) colors.set(point.key, shade);
    });
    for (const [stage, position] of stageIndex) {
      const cell = domainTopics.filter((topic) => topic.stage === stage);
      const cellWeight = cell.reduce((sum, topic) => sum + weight(topic), 0) || 1;
      const cellHeight = geometry.bandHeight * (1 - geometry.bandPadding * 2);
      let y = position * geometry.bandHeight + geometry.bandHeight * geometry.bandPadding;
      for (const topic of cell) { const span = cellHeight * weight(topic) / cellWeight; slices.set(topic.key, { y0: y, y1: y + span }); y += span; }
    }
  }
  const angles = new Map(); const heights = new Map(); const bounds = new Map();
  for (const topic of topics) {
    const sector = sectorOf.get(topic.domainKey); const slice = slices.get(topic.key);
    if (!sector || !slice) continue;
    const margin = Math.min(.05, (sector.end - sector.start) * .08); const low = sector.start + margin; const high = sector.end - margin;
    const points = pointsOf.get(topic.key); const span = slice.y1 - slice.y0;
    points.forEach((point, rank) => {
      angles.set(point.key, low + (high - low) * ((rank * .618034 + hashUnit(point.key, 5) * .5) % 1));
      heights.set(point.key, slice.y0 + span * ((rank + .5) / points.length + (hashUnit(point.key, 3) - .5) * .5 / points.length));
      bounds.set(point.key, [low, high]);
    });
    angles.set(topic.key, (low + high) / 2 + (hashUnit(topic.key, 9) - .5) * (high - low) * .3);
    heights.set(topic.key, (slice.y0 + slice.y1) / 2);
    bounds.set(topic.key, [low, high]);
  }
  const neighbours = new Map();
  for (const edge of index.edges) {
    if (!angles.has(edge.sourceKey) || !angles.has(edge.targetKey)) continue;
    neighbours.set(edge.sourceKey, [...(neighbours.get(edge.sourceKey) ?? []), edge.targetKey]);
    neighbours.set(edge.targetKey, [...(neighbours.get(edge.targetKey) ?? []), edge.sourceKey]);
  }
  const movable = [...angles.keys()].filter((key) => index.nodeByKey.get(key)?.level === "point" && neighbours.has(key)).sort();
  for (let round = 0; round < geometry.relaxRounds; round += 1) {
    for (const key of movable) {
      const own = angles.get(key); const target = circularMean(neighbours.get(key).map((other) => angles.get(other)));
      const delta = Math.atan2(Math.sin(target - own), Math.cos(target - own));
      const [low, high] = bounds.get(key);
      angles.set(key, Math.max(low, Math.min(high, own + delta * geometry.relaxStrength)));
    }
  }
  for (const topic of topics) {
    const points = pointsOf.get(topic.key).filter((point) => angles.has(point.key));
    if (!points.length) continue;
    angles.set(topic.key, circularMean(points.map((point) => angles.get(point.key))));
    heights.set(topic.key, points.reduce((sum, point) => sum + heights.get(point.key), 0) / points.length);
  }
  const centrality = knowledgeGraphCentrality(index);
  const positions = new Map();
  for (const [key, angle] of angles) {
    const node = index.nodeByKey.get(key); const y = heights.get(key);
    const radius = radiusAt(y) * (node.level === "topic" ? 1.04 : .58 + .42 * Math.sqrt(hashUnit(key, 11)));
    positions.set(key, { x: Math.cos(angle) * radius, y, z: Math.sin(angle) * radius, centrality: centrality.get(key) ?? .02 });
  }
  const bands = document.stages.map((stage, position) => ({ stage: stage.value, label: stage.label, y0: position * geometry.bandHeight, y1: (position + 1) * geometry.bandHeight }));
  return { positions, colors, sectors, bands, height, radius: { base: geometry.baseRadius, top: geometry.topRadius } };
}

// The chain behind one node, laid out to be read rather than located: every prerequisite down to the
// starting points, plus the nearest successors (whole steps, up to a budget). Each node's rank is its
// longest distance to the focus, so every drawn relation points upward; shortcuts already implied by a
// longer route are returned separately so the drawing reads like a Hasse diagram.
export function layoutKnowledgeChain(index, focusKey, options = {}) {
  const focus = index.resolveKey(focusKey); if (!focus) return null;
  const limit = Number.isFinite(options.descendantLimit) ? Math.max(1, options.descendantLimit) : Infinity;
  const ancestors = index.ancestors(focus); const totalDescendants = index.descendants(focus).size;
  const kept = new Set(); const seen = new Set([focus]); let frontier = [focus];
  while (frontier.length) {
    const next = [];
    for (const key of frontier) for (const edge of index.outgoing.get(key) ?? []) if (!seen.has(edge.targetKey)) { seen.add(edge.targetKey); next.push(edge.targetKey); }
    if (!next.length || (kept.size && kept.size + next.length > limit)) break;
    for (const key of next) kept.add(key);
    frontier = next;
  }
  const members = new Set([focus, ...ancestors, ...kept]);
  const edges = index.edges.filter((edge) => members.has(edge.sourceKey) && members.has(edge.targetKey));
  const outgoing = new Map([...members].map((key) => [key, []])); const incoming = new Map([...members].map((key) => [key, []]));
  for (const edge of edges) { outgoing.get(edge.sourceKey).push(edge.targetKey); incoming.get(edge.targetKey).push(edge.sourceKey); }
  const indegree = new Map([...members].map((key) => [key, incoming.get(key).length]));
  const order = []; const queue = [...members].filter((key) => !indegree.get(key)).sort();
  while (queue.length) { const key = queue.shift(); order.push(key); for (const next of outgoing.get(key)) { indegree.set(next, indegree.get(next) - 1); if (!indegree.get(next)) queue.push(next); } }
  if (order.length !== members.size) return null;
  const reach = new Map();
  for (const key of [...order].reverse()) {
    const set = new Set(); for (const next of outgoing.get(key)) { set.add(next); for (const further of reach.get(next)) set.add(further); }
    reach.set(key, set);
  }
  const reduced = []; const shortcuts = [];
  for (const edge of edges) {
    const implied = outgoing.get(edge.sourceKey).some((next) => next !== edge.targetKey && reach.get(next).has(edge.targetKey));
    (implied ? shortcuts : reduced).push(edge);
  }
  const rank = new Map([[focus, 0]]);
  for (const key of [...order].reverse()) {
    if (!ancestors.has(key)) continue;
    rank.set(key, Math.min(...outgoing.get(key).filter((next) => next === focus || ancestors.has(next)).map((next) => rank.get(next) - 1)));
  }
  for (const key of order) {
    if (!kept.has(key)) continue;
    rank.set(key, Math.max(...incoming.get(key).filter((previous) => previous === focus || kept.has(previous)).map((previous) => rank.get(previous) + 1)));
  }
  const levels = new Map();
  for (const key of members) { const value = rank.get(key); if (!levels.has(value)) levels.set(value, []); levels.get(value).push(key); }
  const sortKey = (key) => {
    const node = index.nodeByKey.get(key); const topic = node.level === "topic" ? node : index.nodeByKey.get(node.parentKey);
    return [node.stage, topic?.order ?? 0, node.level === "topic" ? -1 : node.order, node.label];
  };
  const compare = (left, right) => { const a = sortKey(left); const b = sortKey(right); return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || String(a[3]).localeCompare(String(b[3]), "zh-CN"); };
  const ranks = [...levels.keys()].sort((left, right) => left - right);
  for (const value of ranks) levels.get(value).sort(compare);
  // Barycentre sweeps over the reduced relations keep connected nodes near each other and cut crossings.
  const below = new Map([...members].map((key) => [key, []])); const above = new Map([...members].map((key) => [key, []]));
  for (const edge of reduced) { below.get(edge.targetKey).push(edge.sourceKey); above.get(edge.sourceKey).push(edge.targetKey); }
  const place = new Map();
  const remember = () => { for (const value of ranks) levels.get(value).forEach((key, position, list) => place.set(key, (position + .5) / list.length)); };
  remember();
  for (let sweep = 0; sweep < 4; sweep += 1) {
    for (const [sequence, neighbours] of [[ranks.slice(1), below], [ranks.slice(0, -1).reverse(), above]]) {
      for (const value of sequence) {
        const list = levels.get(value);
        const weight = new Map(list.map((key) => {
          const linked = neighbours.get(key);
          return [key, linked.length ? linked.reduce((sum, other) => sum + place.get(other), 0) / linked.length : place.get(key)];
        }));
        list.sort((left, right) => weight.get(left) - weight.get(right) || place.get(left) - place.get(right));
        list.forEach((key, position) => place.set(key, (position + .5) / list.length));
      }
    }
  }
  return {
    focus, levels: ranks.map((value) => ({ rank: value, keys: levels.get(value) })), edges: reduced, shortcuts,
    ancestors: ancestors.size, descendants: { shown: kept.size, total: totalDescendants },
  };
}

// Restoring or importing an older document must not drop keys that were published
// since: they come back as archived history so references keep resolving.
export function preservePublishedNodes(document, published) {
  const keys = new Set(document.nodes.map((node) => node.key));
  const missing = (published?.nodes ?? []).filter((node) => !keys.has(node.key)).map((node) => {
    const archived = { ...node, status: "archived" }; delete archived.mergedInto; return archived;
  });
  return missing.length ? { ...document, nodes: [...document.nodes, ...missing] } : document;
}

function sameValue(left, right) { return JSON.stringify(left ?? null) === JSON.stringify(right ?? null); }

export function diffKnowledgeGraphs(before, after) {
  const beforeNodes = new Map((before?.nodes ?? []).map((node) => [node.key, node]));
  const afterNodes = new Map((after?.nodes ?? []).map((node) => [node.key, node]));
  const nodes = { added: [], updated: [], archived: [], restored: [], removed: [] };
  const mappingKey = (document, key) => JSON.stringify((document?.mappings ?? []).filter((mapping) => mapping.nodeKey === key)
    .sort((left, right) => left.editionKey.localeCompare(right.editionKey)));
  for (const node of afterNodes.values()) {
    const previous = beforeNodes.get(node.key);
    if (!previous) { nodes.added.push(node); continue; }
    if (previous.status !== node.status) { (node.status === "archived" ? nodes.archived : nodes.restored).push(node); continue; }
    const fields = NODE_FIELDS.filter((field) => !sameValue(previous[field], node[field]));
    if (mappingKey(before, node.key) !== mappingKey(after, node.key)) fields.push("mappings");
    if (fields.length) nodes.updated.push({ node, fields });
  }
  for (const node of beforeNodes.values()) if (!afterNodes.has(node.key)) nodes.removed.push(node);
  const edgeKey = (edge) => `${edge.sourceKey}>${edge.targetKey}`;
  const beforeEdges = new Map((before?.edges ?? []).map((edge) => [edgeKey(edge), edge]));
  const afterEdges = new Map((after?.edges ?? []).map((edge) => [edgeKey(edge), edge]));
  const edges = {
    added: [...afterEdges.values()].filter((edge) => !beforeEdges.has(edgeKey(edge))),
    removed: [...beforeEdges.values()].filter((edge) => !afterEdges.has(edgeKey(edge))),
    updated: [...afterEdges.values()].filter((edge) => beforeEdges.has(edgeKey(edge)) && !sameValue(beforeEdges.get(edgeKey(edge)), edge)),
  };
  const meta = ["title", "scope", "status", "stages", "editions"].filter((field) => !sameValue(before?.[field], after?.[field]));
  const count = Object.values(nodes).reduce((sum, list) => sum + list.length, 0) + Object.values(edges).reduce((sum, list) => sum + list.length, 0) + meta.length;
  return { nodes, edges, meta, count, changed: count > 0 };
}

export function summarizeKnowledgeGraphDiff(diff) {
  return {
    nodesAdded: diff.nodes.added.length, nodesUpdated: diff.nodes.updated.length + diff.nodes.restored.length,
    nodesArchived: diff.nodes.archived.length, nodesRemoved: diff.nodes.removed.length,
    edgesAdded: diff.edges.added.length, edgesUpdated: diff.edges.updated.length, edgesRemoved: diff.edges.removed.length, meta: diff.meta.length,
  };
}

// Weak points are traced back along prerequisite edges: a weak topic whose own
// prerequisites are healthy is a root cause and becomes a "先补" priority.
export function diagnoseKnowledgeGaps(index, profileNodes) {
  const byKey = new Map((Array.isArray(profileNodes) ? profileNodes : []).map((node) => [node.key, node]));
  const learnable = index.activeNodes.filter((node) => node.level !== "domain");
  const statusOf = (key) => { const node = byKey.get(key); return !node || !node.evidenceCount ? "unassessed" : node.status; };
  const counts = { stable: 0, developing: 0, attention: 0, insufficient: 0, unassessed: 0 };
  for (const node of learnable) counts[statusOf(node.key)] += 1;
  const rootsFor = (status) => learnable.filter((node) => statusOf(node.key) === status)
    .filter((node) => ![...index.ancestors(node.key)].some((key) => statusOf(key) === "attention" || (status === "developing" && statusOf(key) === "developing")))
    .map((node) => {
      const descendants = [...index.descendants(node.key)];
      return {
        key: node.key, label: node.label, stage: node.stage, domainKey: node.domainKey, status,
        evidenceCount: byKey.get(node.key)?.evidenceCount ?? 0, impact: descendants.length,
        weakDescendants: descendants.filter((key) => ["attention", "developing"].includes(statusOf(key))),
        untestedPrerequisites: (index.incoming.get(node.key) ?? []).map((edge) => edge.sourceKey).filter((key) => statusOf(key) === "unassessed"),
      };
    })
    .sort((left, right) => right.weakDescendants.length - left.weakDescendants.length || right.impact - left.impact
      || right.evidenceCount - left.evidenceCount || left.stage - right.stage || left.label.localeCompare(right.label, "zh-CN"));
  const stages = index.document.stages.map((stage) => {
    const summary = { stage: stage.value, label: stage.label, total: 0, stable: 0, developing: 0, attention: 0, insufficient: 0, unassessed: 0 };
    for (const node of learnable.filter((item) => item.stage === stage.value)) { summary.total += 1; summary[statusOf(node.key)] += 1; }
    return summary;
  });
  return { counts, roots: rootsFor("attention"), developing: rootsFor("developing"), stages };
}

// New keys take the prefix the graph's domains use: a course graph's topics and points are keyed
// by their handouts (lesson:, module:), which a node added in the editor must never look like.
export function knowledgeGraphKeyPrefix(document) {
  const counts = new Map();
  for (const node of document.nodes.filter((item) => item.level === "domain")) { const prefix = node.key.split(":")[0]; if (prefix) counts.set(prefix, (counts.get(prefix) ?? 0) + 1); }
  return [...counts].sort((left, right) => right[1] - left[1])[0]?.[0] || document.graphId.split("-")[0] || "kg";
}

export function createKnowledgeGraphKey(document, level = "topic", random = () => Math.random()) {
  const prefix = knowledgeGraphKeyPrefix(document); const used = new Set(document.nodes.map((node) => node.key));
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const suffix = Array.from({ length: 8 }, () => "abcdefghijkmnpqrstuvwxyz23456789"[Math.floor(random() * 32)]).join("");
    const key = `${prefix}:${level}:${suffix}`;
    if (!used.has(key)) return key;
  }
  throw new Error("无法生成唯一的知识点编号");
}
