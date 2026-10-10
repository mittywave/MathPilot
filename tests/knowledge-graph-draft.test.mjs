import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CHINA_MATH_SEED_DOCUMENT } from "../lib/china-curriculum-taxonomy.mjs";
import { createKnowledgeGraphIndex, layoutKnowledgeChain, layoutKnowledgeFunnel, validateKnowledgeGraph } from "../lib/knowledge-graph-core.mjs";
import { buildFineGrainedDraft, draftStatistics } from "../scripts/build-knowledge-graph-draft.mjs";

const seed = CHINA_MATH_SEED_DOCUMENT;
const draft = buildFineGrainedDraft();

test("the committed fine-grained draft is the build output of its source", async () => {
  const committed = JSON.parse(await readFile(new URL("../data/drafts/china-math-junior-fine-draft.json", import.meta.url), "utf8"));
  assert.deepEqual(committed, draft, "run `node scripts/build-knowledge-graph-draft.mjs` after editing the source");
});

test("the draft is a valid successor of the published V1 graph", () => {
  assert.deepEqual(validateKnowledgeGraph(draft, { previous: seed }).errors, []);
  const keys = new Map(draft.nodes.map((node) => [node.key, node]));
  for (const node of seed.nodes) assert.equal(keys.get(node.key)?.status, "active", `「${node.label}」keeps its published key`);
  const stats = draftStatistics(draft);
  assert.equal(stats.domains, 4);
  assert.equal(stats.topics, 33);
  assert.ok(stats.points >= 400, `${stats.points} points`);
  assert.ok(stats.edges >= 600, `${stats.edges} relations`);
  assert.ok(new TextEncoder().encode(JSON.stringify(draft)).length < 1_900_000, "fits the draft size limit");
});

test("every point is reviewable: described, testable and placed under a real topic", () => {
  const index = createKnowledgeGraphIndex(draft);
  const topics = index.activeNodes.filter((node) => node.level === "topic");
  const topicNames = new Set(topics.flatMap((topic) => [topic.label, ...topic.aliases]));
  for (const topic of topics) {
    const points = index.children.get(topic.key) ?? [];
    assert.ok(points.length >= 3, `「${topic.label}」has ${points.length} points`);
    assert.ok(index.mappingsFor(topic.key).some((mapping) => mapping.editionKey === "pep" && mapping.volume !== "待校准"), `「${topic.label}」has a textbook volume`);
    for (const point of points) {
      assert.ok(point.description && point.mastery, `「${point.label}」has a description and a mastery statement`);
      assert.equal(point.stage, topic.stage);
      assert.ok(!point.aliases.includes(point.label), `「${point.label}」does not alias itself`);
      for (const alias of point.aliases) assert.ok(!topicNames.has(alias), `point alias「${alias}」would hijack a topic`);
    }
  }
  const names = new Map();
  for (const node of index.activeNodes.filter((item) => item.level !== "domain")) {
    for (const name of [node.label, ...node.aliases]) {
      assert.ok(!names.has(name) || names.get(name) === node.key, `「${name}」names two nodes`);
      names.set(name, node.key);
    }
  }
});

test("existing question tags still resolve after the split", () => {
  const index = createKnowledgeGraphIndex(draft);
  for (const topic of seed.nodes.filter((node) => node.level === "topic")) {
    for (const name of [topic.label, ...topic.aliases]) {
      const [resolved] = index.resolveLabels([name]);
      assert.ok(resolved && index.nodeByKey.get(resolved)?.level !== "domain", `tag「${name}」resolves to a topic or point`);
    }
  }
  assert.deepEqual(index.resolveLabels(["配方法"]), ["cn-math:point:quadratic-equation-04"]);
  assert.equal(index.nodeByKey.get(index.resolveLabels(["直角三角形"])[0]).label, "勾股定理");
});

test("prerequisites mostly point upward in the funnel", () => {
  const funnel = layoutKnowledgeFunnel(draft);
  const edges = draft.edges.filter((edge) => funnel.positions.has(edge.sourceKey) && funnel.positions.has(edge.targetKey));
  const upward = edges.filter((edge) => funnel.positions.get(edge.targetKey).y >= funnel.positions.get(edge.sourceKey).y).length;
  assert.ok(upward / edges.length > 0.95, `${upward}/${edges.length} relations point upward`);
});

test("every point's chain view reads strictly upward and stays within the successor budget", () => {
  const index = createKnowledgeGraphIndex(draft);
  for (const node of index.activeNodes.filter((item) => item.level !== "domain")) {
    const chain = layoutKnowledgeChain(index, node.key, { descendantLimit: 40 });
    const rank = new Map(chain.levels.flatMap((level) => level.keys.map((key) => [key, level.rank])));
    assert.equal(rank.get(node.key), 0);
    assert.equal(chain.ancestors, index.ancestors(node.key).size, `「${node.label}」shows every prerequisite`);
    assert.ok([...chain.edges, ...chain.shortcuts].every((edge) => rank.get(edge.targetKey) > rank.get(edge.sourceKey)), `「${node.label}」has no downward relation`);
    const firstStep = (index.outgoing.get(node.key) ?? []).length;
    assert.ok(chain.descendants.shown <= Math.max(40, firstStep), `「${node.label}」folds far successors`);
  }
});
