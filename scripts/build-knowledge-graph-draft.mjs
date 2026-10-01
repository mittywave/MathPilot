// Compiles the fine-grained curriculum source into a full knowledge-graph document
// that can be imported in /knowledge-graph as a draft for teacher review.
//
//   node scripts/build-knowledge-graph-draft.mjs           # writes data/drafts/china-math-junior-fine-draft.json
//   node scripts/build-knowledge-graph-draft.mjs --check   # validates only
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CHINA_MATH_SEED_DOCUMENT } from "../lib/china-curriculum-taxonomy.mjs";
import { normalizeKnowledgeGraph, validateKnowledgeGraph } from "../lib/knowledge-graph-core.mjs";
import { domains as domainOverrides, edgeReasons, meta, topicEdges, topics } from "../data/drafts/china-math-junior-fine.source.mjs";

const OUTPUT = new URL("../data/drafts/china-math-junior-fine-draft.json", import.meta.url);
const DOMAIN_PREFIX = "cn-math:domain:";

function list(value, separator) { return String(value ?? "").split(separator).map((item) => item.trim()).filter(Boolean); }

// One point per line: 名称｜描述｜学会的标志｜别名（、分隔）｜前置（；分隔）.
// Prerequisite references: "知识点"（同主题）、"主题/知识点"、"@主题"；前缀 "~" 表示支撑关系。
function parsePoints(topic) {
  return String(topic.points ?? "").split("\n").map((line) => line.trim()).filter(Boolean).map((line, index) => {
    const [label, description, mastery, aliases, prerequisites] = line.split("｜").map((part) => (part ?? "").trim());
    if (!label || !description || !mastery) throw new Error(`「${topic.label}」第 ${index + 1} 个知识点缺少名称、描述或学会的标志：${line}`);
    return { label, description, mastery, aliases: list(aliases, "、").filter((alias) => alias !== label), prerequisites: list(prerequisites, "；") };
  });
}

export function buildFineGrainedDraft(seed = CHINA_MATH_SEED_DOCUMENT) {
  const document = structuredClone(seed);
  document.title = meta.title; document.scope = meta.scope;
  const byKey = new Map(document.nodes.map((node) => [node.key, node]));
  for (const [key, override] of Object.entries(domainOverrides)) {
    const domain = byKey.get(key);
    if (!domain) throw new Error(`领域不存在：${key}`);
    if (override.label && override.label !== domain.label) domain.aliases = [...new Set([domain.label, ...domain.aliases])];
    Object.assign(domain, override);
  }
  const topicByLabel = new Map(); const pointKeys = new Map(); const lines = [];
  for (const source of topics) {
    const domainKey = `${DOMAIN_PREFIX}${source.domain}`;
    if (!byKey.has(domainKey)) throw new Error(`「${source.label}」的领域不存在：${domainKey}`);
    let topic = byKey.get(source.key);
    if (topic) {
      // Renamed topics keep their old label as an alias so existing tags still resolve.
      const previousLabels = topic.label !== source.label ? [topic.label] : [];
      Object.assign(topic, { label: source.label, stage: source.stage, order: source.order, domainKey, parentKey: domainKey,
        description: source.description ?? topic.description, aliases: [...new Set([...(source.aliases ?? topic.aliases), ...previousLabels])] });
    } else {
      topic = { key: source.key, label: source.label, level: "topic", domainKey, parentKey: domainKey, stage: source.stage, description: source.description,
        aliases: source.aliases ?? [], order: source.order, status: "active" };
      document.nodes.push(topic); byKey.set(topic.key, topic);
    }
    if (source.mastery) topic.mastery = source.mastery;
    topicByLabel.set(source.label, topic);
    const slug = source.key.split(":").pop();
    parsePoints(source).forEach((point, index) => {
      const key = `cn-math:point:${slug}-${String(index + 1).padStart(2, "0")}`;
      const node = { key, label: point.label, level: "point", domainKey, parentKey: topic.key, stage: source.stage,
        description: point.description, mastery: point.mastery, aliases: point.aliases, order: index, status: "active" };
      document.nodes.push(node); byKey.set(key, node);
      pointKeys.set(`${source.label}/${point.label}`, key);
      lines.push({ topic: source, point, key });
    });
    document.mappings = document.mappings.filter((mapping) => !(mapping.nodeKey === topic.key && mapping.editionKey === "pep"));
    document.mappings.push({ nodeKey: topic.key, editionKey: "pep", grade: source.stage, volume: source.volume, unitLabel: source.chapter, alignmentStatus: "framework" });
  }
  const resolve = (reference, topicLabel) => {
    const raw = reference.replace(/^~/, "");
    if (raw.startsWith("@")) {
      const topic = topicByLabel.get(raw.slice(1));
      if (!topic) throw new Error(`「${topicLabel}」引用了不存在的主题：${raw}`);
      return topic.key;
    }
    const key = pointKeys.get(raw.includes("/") ? raw : `${topicLabel}/${raw}`);
    if (!key) throw new Error(`「${topicLabel}」引用了不存在的知识点：${raw}`);
    return key;
  };
  const edgeKeys = new Set(document.edges.map((edge) => `${edge.sourceKey}>${edge.targetKey}`));
  const addEdge = (sourceKey, targetKey, relationship, reason = "") => {
    const pair = `${sourceKey}>${targetKey}`;
    if (edgeKeys.has(pair)) return;
    edgeKeys.add(pair);
    document.edges.push({ sourceKey, targetKey, relationship, strength: relationship === "prerequisite" ? "hard" : "soft", reason });
  };
  for (const { topic, point, key } of lines) {
    for (const reference of point.prerequisites) {
      const sourceKey = resolve(reference, topic.label);
      addEdge(sourceKey, key, reference.startsWith("~") ? "supports" : "prerequisite", edgeReasons[`${reference.replace(/^~/, "")}>${topic.label}/${point.label}`] ?? "");
    }
  }
  for (const [source, target, relationship, reason] of topicEdges) addEdge(source, target, relationship, reason);
  // Existing question tags resolve through names: an old topic alias moves to the point that now carries that name,
  // every other old alias stays on its topic.
  const claimed = new Set(document.nodes.filter((node) => node.level === "point").flatMap((node) => [node.label, ...node.aliases]));
  for (const previous of seed.nodes.filter((node) => node.level === "topic")) {
    const topic = byKey.get(previous.key);
    const kept = previous.aliases.filter((alias) => alias !== topic.label && !claimed.has(alias));
    topic.aliases = [...new Set([...topic.aliases, ...kept])].filter((alias) => alias !== topic.label);
  }
  return normalizeKnowledgeGraph(document);
}

export function draftStatistics(document) {
  const active = document.nodes.filter((node) => node.status !== "archived");
  return {
    domains: active.filter((node) => node.level === "domain").length, topics: active.filter((node) => node.level === "topic").length,
    points: active.filter((node) => node.level === "point").length, edges: document.edges.length,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const draft = buildFineGrainedDraft();
  const { errors } = validateKnowledgeGraph(draft, { previous: CHINA_MATH_SEED_DOCUMENT });
  if (errors.length) {
    for (const error of errors.slice(0, 40)) console.error(error.message);
    console.error(`${errors.length} 个问题，未写出草稿`); process.exitCode = 1;
  } else {
    const stats = draftStatistics(draft);
    console.log(`领域 ${stats.domains} · 主题 ${stats.topics} · 知识点 ${stats.points} · 关系 ${stats.edges}`);
    if (!process.argv.includes("--check")) {
      await writeFile(OUTPUT, `${JSON.stringify(draft, null, 1)}\n`);
      console.log(`已写出 ${fileURLToPath(OUTPUT)}`);
    }
  }
}
