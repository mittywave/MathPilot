// 可切换的知识图谱。人教版通用图谱是独立编辑的知识点体系；课程图谱的节点来自课程体系的讲义：
// 一讲是一个主题，讲里的一个知识模块是一个知识点。图谱自己只保存领域归属、前后关系、描述和学会的标志。
import { KNOWLEDGE_GRAPH_LIMITS } from "./knowledge-graph-core.mjs";
import { HANDOUT_DOMAINS, HANDOUT_GRADES, moduleHeading } from "./handout-rules.mjs";

export const KNOWLEDGE_GRAPHS = [
  { id: "cn-math-junior", title: "人教版通用", course: false },
  { id: "sz-innovation-course", title: "深圳创新班课程", course: true },
];
export const DEFAULT_KNOWLEDGE_GRAPH = KNOWLEDGE_GRAPHS[0].id;
export const knowledgeGraphInfo = (id) => KNOWLEDGE_GRAPHS.find((graph) => graph.id === id) ?? null;

// Course nodes are keyed by the handout and module they come from, so renaming never changes a key.
export const lessonKey = (handoutId) => `lesson:${handoutId}`;
export const moduleKey = (sectionId) => `module:${sectionId}`;
export const isCourseNodeKey = (key) => /^(lesson|module):/.test(String(key ?? ""));
export const handoutIdOf = (key) => String(key ?? "").startsWith("lesson:") ? String(key).slice(7) : "";
export const sectionIdOf = (key) => String(key ?? "").startsWith("module:") ? String(key).slice(7) : "";
// Where a course node is edited: its lesson's handout, opened at the module for a point.
export function handoutHref(node) {
  const handoutId = handoutIdOf(node.level === "point" ? node.parentKey : node.key);
  if (!handoutId) return "";
  const sectionId = sectionIdOf(node.key);
  return `/tools/handouts?id=${encodeURIComponent(handoutId)}${sectionId ? `&module=${encodeURIComponent(sectionId)}` : ""}`;
}

// The course graph before anything is published: the five 板块 of the 专题库 as domains and the three grades.
export function courseGraphSeed() {
  return {
    schemaVersion: 2, graphId: KNOWLEDGE_GRAPHS[1].id, title: KNOWLEDGE_GRAPHS[1].title, scope: "初一至初三 · 课程体系的讲次与知识模块", status: "foundation",
    stages: HANDOUT_GRADES.map((grade) => ({ value: grade.value, label: grade.label })),
    nodes: HANDOUT_DOMAINS.map((domain, index) => ({
      key: `course:${domain.value}`, label: domain.label, level: "domain", domainKey: `course:${domain.value}`, stage: HANDOUT_GRADES[0].value,
      description: "", aliases: [], order: index, status: "active",
    })),
    edges: [], editions: [], mappings: [],
  };
}

// Brings a course graph in line with the 课程体系. lessons: the course handouts in teaching order,
// each { id, title, grade, modules: [{ id, title }] }. A lesson keeps the domain it was given; a new one
// starts in the domain of the lesson before it. Names, grades and order always follow the handouts.
// Course nodes that left the course stay as archived history once published (published: the published document),
// and are dropped otherwise; relations touching them go with them.
export function syncCourseGraph(document, lessons, published = null) {
  const kept = new Map([...(published?.nodes ?? []), ...document.nodes].map((node) => [node.key, node]));
  const domains = document.nodes.filter((node) => node.level === "domain" && node.status !== "archived").map((node) => node.key);
  const label = (value) => String(value ?? "").trim().slice(0, KNOWLEDGE_GRAPH_LIMITS.label);
  // Course nodes are never merged: a module belongs to its handout.
  const unmerged = (node) => { const copy = { ...node }; delete copy.mergedInto; return copy; };
  const fresh = (key) => unmerged(kept.get(key) ?? { description: "", aliases: [] });
  const course = []; let domainKey = domains[0] ?? "";
  lessons.forEach((lesson, lessonIndex) => {
    const key = lessonKey(lesson.id); const before = kept.get(key);
    if (before && domains.includes(before.domainKey)) domainKey = before.domainKey;
    course.push({ ...fresh(key), key, label: label(lesson.title) || "未命名讲义", level: "topic", parentKey: domainKey, domainKey, stage: lesson.grade, order: lessonIndex, status: "active" });
    lesson.modules.forEach((module, moduleIndex) => {
      const heading = moduleHeading(module.title, moduleIndex); const pointKey = moduleKey(module.id);
      course.push({ ...fresh(pointKey), key: pointKey, label: label(heading.title) || `模块${heading.numeral}`, level: "point", parentKey: key, domainKey, stage: lesson.grade, order: moduleIndex, status: "active" });
    });
  });
  const present = new Set(course.map((node) => node.key));
  const publishedKeys = new Set((published?.nodes ?? []).map((node) => node.key));
  const history = [...kept.values()].filter((node) => isCourseNodeKey(node.key) && !present.has(node.key) && publishedKeys.has(node.key))
    .map((node) => ({ ...unmerged(node), status: "archived" }));
  const nodes = [...document.nodes.filter((node) => !isCourseNodeKey(node.key)), ...course, ...history];
  const active = new Set(nodes.filter((node) => node.status !== "archived").map((node) => node.key));
  const stages = [...new Map([...document.stages, ...HANDOUT_GRADES.map((grade) => ({ value: grade.value, label: grade.label }))].map((stage) => [stage.value, stage])).values()]
    .sort((left, right) => left.value - right.value);
  return {
    ...document, stages, nodes,
    edges: document.edges.filter((edge) => active.has(edge.sourceKey) && active.has(edge.targetKey)),
    mappings: document.mappings.filter((mapping) => active.has(mapping.nodeKey)),
  };
}
