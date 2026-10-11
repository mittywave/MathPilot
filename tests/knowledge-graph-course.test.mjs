import test from "node:test";
import assert from "node:assert/strict";
import { validateKnowledgeGraph } from "../lib/knowledge-graph-core.mjs";
import { KNOWLEDGE_GRAPHS, courseGraphSeed, handoutHref, isCourseNodeKey, knowledgeGraphInfo, syncCourseGraph } from "../lib/knowledge-graph-course.mjs";
import { addKnowledgeEdge, addKnowledgeNode, updateKnowledgeNode } from "../lib/knowledge-graph-edit.mjs";

const lessons = [
  { id: "h1", title: "正负数的五则运算", grade: 7, modules: [{ id: "s1", title: "正负数、相反数与绝对值" }, { id: "s2", title: "" }] },
  { id: "h2", title: "开方运算", grade: 7, modules: [{ id: "s3", title: "1. 平方根与立方根" }] },
  { id: "h3", title: "平行四边形", grade: 8, modules: [{ id: "s4", title: "性质与判定" }] },
];
const node = (document, key) => document.nodes.find((item) => item.key === key);

test("the course graph is one of the switchable graphs and starts from the five 专题 domains", () => {
  assert.deepEqual(KNOWLEDGE_GRAPHS.map((graph) => [graph.id, graph.course]), [["cn-math-junior", false], ["sz-innovation-course", true]]);
  assert.equal(knowledgeGraphInfo("nope"), null);
  const seed = courseGraphSeed();
  assert.deepEqual(seed.nodes.map((item) => item.label), ["函数", "几何", "代数", "数论", "数学思想"]);
  assert.deepEqual(seed.stages.map((stage) => stage.label), ["初一", "初二", "初三"]);
  assert.deepEqual(validateKnowledgeGraph(seed).errors, []);
});

test("every lesson becomes a topic and every module a point, named, graded and ordered by the handouts", () => {
  const graph = syncCourseGraph(courseGraphSeed(), lessons);
  assert.deepEqual(graph.nodes.filter((item) => isCourseNodeKey(item.key)).map((item) => [item.key, item.level, item.label, item.stage, item.order, item.parentKey]), [
    ["lesson:h1", "topic", "正负数的五则运算", 7, 0, "course:function"],
    ["module:s1", "point", "正负数、相反数与绝对值", 7, 0, "lesson:h1"],
    ["module:s2", "point", "模块二", 7, 1, "lesson:h1"],
    ["lesson:h2", "topic", "开方运算", 7, 1, "course:function"],
    ["module:s3", "point", "平方根与立方根", 7, 0, "lesson:h2"],
    ["lesson:h3", "topic", "平行四边形", 8, 2, "course:function"],
    ["module:s4", "point", "性质与判定", 8, 0, "lesson:h3"],
  ], "an untitled module is named by its number and a typed number is dropped");
  assert.deepEqual(validateKnowledgeGraph(graph).errors, []);
});

test("the graph keeps its own domains, mastery and relations while names follow the handouts", () => {
  let graph = syncCourseGraph(courseGraphSeed(), lessons);
  graph = updateKnowledgeNode(graph, "lesson:h1", { domainKey: "course:algebra" });
  graph = updateKnowledgeNode(graph, "module:s1", { mastery: "能用数轴比较有理数的大小" });
  graph = addKnowledgeEdge(graph, "module:s1", "module:s3");
  const renamed = [{ ...lessons[0], modules: [{ id: "s1", title: "正负数基础" }, lessons[0].modules[1]] },
    { id: "h9", title: "数轴动点", grade: 7, modules: [{ id: "s9", title: "动点表示" }] }, ...lessons.slice(1)];
  const next = syncCourseGraph(graph, renamed);
  assert.equal(node(next, "module:s1").label, "正负数基础");
  assert.equal(node(next, "module:s1").mastery, "能用数轴比较有理数的大小");
  assert.equal(node(next, "module:s1").domainKey, "course:algebra", "points follow their lesson's domain");
  assert.equal(node(next, "lesson:h9").domainKey, "course:algebra", "a new lesson starts in the domain of the lesson before it");
  assert.deepEqual([node(next, "lesson:h9").order, node(next, "lesson:h2").order], [1, 2], "order follows the course");
  assert.deepEqual(next.edges.map((edge) => `${edge.sourceKey}>${edge.targetKey}`), ["module:s1>module:s3"]);
  assert.deepEqual(validateKnowledgeGraph(next).errors, []);
});

test("modules that leave the course disappear, or stay archived once published, without their relations", () => {
  let graph = syncCourseGraph(courseGraphSeed(), lessons);
  graph = addKnowledgeEdge(graph, "module:s1", "module:s3");
  graph = addKnowledgeEdge(graph, "module:s3", "module:s4");
  const withoutS3 = [lessons[0], { ...lessons[1], modules: [] }, lessons[2]];
  const draft = syncCourseGraph(graph, withoutS3);
  assert.equal(node(draft, "module:s3"), undefined, "never published: gone");
  assert.deepEqual(draft.edges, []);
  const published = syncCourseGraph(graph, withoutS3, graph);
  assert.equal(node(published, "module:s3").status, "archived", "published: kept as history");
  assert.deepEqual(published.edges, [], "an archived node keeps no relations");
  assert.deepEqual(validateKnowledgeGraph(published, { previous: graph }).errors, []);
  const lessonGone = syncCourseGraph(graph, lessons.slice(0, 2), graph);
  assert.deepEqual(["lesson:h3", "module:s4"].map((key) => node(lessonGone, key).status), ["archived", "archived"]);
  assert.deepEqual(validateKnowledgeGraph(lessonGone, { previous: graph }).errors, []);
});

test("course nodes link to their handout, and nodes added in the editor never look like course nodes", () => {
  assert.equal(handoutHref({ key: "lesson:h1", level: "topic" }), "/tools/handouts?id=h1");
  assert.equal(handoutHref({ key: "module:s 1", level: "point", parentKey: "lesson:h1" }), "/tools/handouts?id=h1&module=s%201");
  assert.equal(handoutHref({ key: "cn-math:topic:x", level: "topic" }), "");
  const graph = syncCourseGraph(courseGraphSeed(), lessons);
  const added = addKnowledgeNode(graph, { level: "domain", label: "综合" });
  assert.match(added.key, /^course:domain:/);
  assert.ok(!isCourseNodeKey(added.key));
  assert.ok(node(syncCourseGraph(added.document, lessons), added.key), "a new domain survives the next sync");
});
