import assert from "node:assert/strict";
import test from "node:test";
import { CHINA_MATH_SEED_DOCUMENT } from "../lib/china-curriculum-taxonomy.mjs";
import { buildCapabilityProfile } from "../lib/homework-capability-framework.mjs";
import {
  createKnowledgeGraphIndex, diagnoseKnowledgeGaps, diffKnowledgeGraphs, knowledgeGraphCentrality, layoutKnowledgeChain, layoutKnowledgeFunnel, normalizeKnowledgeGraph, summarizeKnowledgeGraphDiff,
  validateKnowledgeGraph,
} from "../lib/knowledge-graph-core.mjs";
import {
  addKnowledgeEdge, addKnowledgeNode, addKnowledgeNodesFromLines, importKnowledgeGraphDraft, mergeKnowledgeNode, moveKnowledgeNode, removeKnowledgeEdge, removeKnowledgeNode,
  restoreKnowledgeNode, setKnowledgeMapping, updateKnowledgeEdge, updateKnowledgeNode,
} from "../lib/knowledge-graph-edit.mjs";

const seed = CHINA_MATH_SEED_DOCUMENT;
const key = (name) => `cn-math:topic:${name}`;
let counter = 0;
const random = () => ((counter += 7) % 32) / 32;

test("the bundled V1 taxonomy normalizes into an editable, valid graph document", () => {
  assert.equal(seed.graphId, "cn-math-junior");
  assert.deepEqual(seed.stages.map((stage) => [stage.value, stage.label]), [[7, "七年级"], [8, "八年级"], [9, "九年级"]]);
  assert.ok(seed.nodes.filter((node) => node.level !== "domain").every((node) => node.level === "topic" && node.parentKey === node.domainKey));
  assert.ok(seed.nodes.filter((node) => node.level === "domain").every((node) => /^#[0-9a-f]{6}$/.test(node.color)));
  assert.deepEqual(validateKnowledgeGraph(seed).errors, []);
  assert.deepEqual(normalizeKnowledgeGraph(seed), seed, "normalization must be idempotent so content hashes stay stable");
  assert.equal(createKnowledgeGraphIndex(seed, { version: 3 }).frameworkVersion, "cn-math-junior-v3");
});

test("validation explains cycles, hierarchy edges, duplicates and deleted published nodes in teacher language", () => {
  const cyclic = structuredClone(seed);
  cyclic.edges.push({ sourceKey: key("linear-equation"), targetKey: key("rational-numbers"), relationship: "prerequisite", strength: "hard", reason: "" });
  const cycle = validateKnowledgeGraph(cyclic).errors.find((issue) => issue.code === "cycle");
  assert.match(cycle.message, /^形成循环：.*有理数及其运算.*→.*一元一次方程/);
  assert.ok(cycle.cycle.includes(key("rational-numbers")));

  const withPoint = addKnowledgeNode(seed, { level: "point", parentKey: key("linear-function"), label: "一次函数的图象" }, random);
  const hierarchyEdge = structuredClone(withPoint.document);
  hierarchyEdge.edges.push({ sourceKey: key("linear-function"), targetKey: withPoint.key, relationship: "prerequisite", strength: "hard", reason: "" });
  assert.equal(validateKnowledgeGraph(hierarchyEdge).errors[0].code, "edge-hierarchy");

  const duplicate = structuredClone(seed); duplicate.nodes.find((node) => node.key === key("fractions")).label = "因式分解";
  assert.match(validateKnowledgeGraph(duplicate).errors[0].message, /名称重复：「因式分解」/);

  const deleted = structuredClone(seed); deleted.nodes = deleted.nodes.filter((node) => node.key !== key("circle"));
  deleted.edges = deleted.edges.filter((edge) => edge.sourceKey !== key("circle") && edge.targetKey !== key("circle"));
  assert.deepEqual(validateKnowledgeGraph(deleted).errors, [], "a draft may drop a node that was never published");
  assert.match(validateKnowledgeGraph(deleted, { previous: seed }).errors[0].message, /已发布的「圆」不能删除，请改为停用/);
});

test("the graph index resolves labels, merges and full prerequisite chains", () => {
  const index = createKnowledgeGraphIndex(seed);
  assert.deepEqual(index.resolveLabels(["一元一次方程"]), [key("linear-equation")]);
  assert.deepEqual(index.resolveLabels(["圆周角与切线"]), [key("circle")]);
  assert.deepEqual(index.resolveLabels(["完全无关"]), ["cn-math:domain:integrated-application"], "unmatched tags keep the legacy integrated fallback");
  assert.deepEqual([...index.ancestors(key("linear-function"))].sort(), [key("algebraic-expressions"), key("coordinate-plane"), key("linear-equation"), key("rational-numbers")].sort());
  assert.ok(index.descendants(key("rational-numbers")).has(key("integrated-inquiry")));
  const merged = mergeKnowledgeNode(seed, key("inverse-proportion"), key("linear-function"));
  const mergedIndex = createKnowledgeGraphIndex(merged);
  assert.equal(mergedIndex.resolveKey(key("inverse-proportion")), key("linear-function"));
  assert.equal(mergedIndex.node(key("inverse-proportion")).label, "一次函数");
  assert.deepEqual(mergedIndex.resolveLabels(["双曲线"]), [key("linear-function")], "aliases move with a merge so tagging keeps working");
});

test("funnel layout stacks grades upward, keeps domains in their wedges and is deterministic", () => {
  const withPoints = addKnowledgeNodesFromLines(seed, key("circle"), "垂径定理｜能用垂径定理求弦长\n圆周角定理｜能用圆周角定理求角", { chain: true }, random).document;
  const index = createKnowledgeGraphIndex(withPoints); const funnel = layoutKnowledgeFunnel(withPoints, { index });
  const snapshot = (layout) => JSON.stringify([[...layout.positions], [...layout.colors], layout.sectors, layout.bands]);
  assert.equal(snapshot(funnel), snapshot(layoutKnowledgeFunnel(withPoints)), "layout must be deterministic");
  assert.deepEqual(funnel.bands.map((band) => band.stage), [7, 8, 9]);
  assert.ok(funnel.bands.every((band, position) => band.y1 > band.y0 && (!position || band.y0 >= funnel.bands[position - 1].y1)));
  const radiusAt = (y) => funnel.radius.base + (funnel.radius.top - funnel.radius.base) * y / funnel.height;
  const turn = (angle, start) => start + ((((angle - start) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2));
  for (const node of index.activeNodes.filter((item) => item.level !== "domain")) {
    const point = funnel.positions.get(node.key); const band = funnel.bands.find((item) => item.stage === node.stage);
    const sector = funnel.sectors.find((item) => item.domainKey === node.domainKey);
    assert.ok([point.x, point.y, point.z, point.centrality].every(Number.isFinite), `${node.label} has finite coordinates`);
    assert.ok(point.y >= band.y0 && point.y <= band.y1, `${node.label} sits in its grade band`);
    assert.ok(turn(Math.atan2(point.z, point.x), sector.start) <= sector.end + 1e-9, `${node.label} stays inside its domain wedge`);
    assert.ok(Math.hypot(point.x, point.z) <= radiusAt(point.y) * 1.05, `${node.label} stays inside the funnel`);
  }
  const y = (name) => funnel.positions.get(key(name)).y;
  assert.ok(y("rational-numbers") < y("algebraic-expressions") && y("algebraic-expressions") < y("linear-equation"), "chapters stack in textbook order inside a grade");
  assert.ok(y("linear-equation") < y("linear-function") && y("linear-function") < y("quadratic-function"), "later grades sit higher");
  assert.ok(funnel.positions.get(key("rational-numbers")).centrality > funnel.positions.get(key("probability")).centrality, "foundations are drawn larger");
  assert.ok(funnel.colors.get(key("circle")) !== funnel.colors.get(key("triangles")), "topics of one domain get distinct shades");
  const [chord, angle] = index.children.get(key("circle"));
  assert.equal(funnel.colors.get(chord.key), funnel.colors.get(key("circle")), "points share their topic's shade");
  assert.ok(funnel.positions.get(chord.key).y <= funnel.positions.get(angle.key).y + 1e-9, "a chained prerequisite is placed no higher");
});

test("funnel layout and centrality scale to large graphs", () => {
  const document = structuredClone(seed); const topics = document.nodes.filter((node) => node.level === "topic");
  let state = 11; const next = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  const points = Array.from({ length: 1500 }, (_, position) => {
    const topic = topics[position % topics.length];
    return { key: `cn-math:point:synthetic-${position}`, label: `合成知识点 ${position}`, level: "point", parentKey: topic.key, domainKey: topic.domainKey, stage: topic.stage,
      description: "", aliases: [], order: position, status: "active" };
  }).sort((left, right) => left.stage - right.stage || left.order - right.order);
  document.nodes.push(...points);
  const pairs = new Set();
  while (pairs.size < 4000) {
    const source = Math.floor(next() * points.length); const target = Math.min(points.length - 1, source + 1 + Math.floor(next() * 150));
    if (source !== target) pairs.add(`${source}>${target}`);
  }
  for (const pair of pairs) { const [source, target] = pair.split(">").map(Number); document.edges.push({ sourceKey: points[source].key, targetKey: points[target].key, relationship: "prerequisite", strength: "hard", reason: "" }); }
  const index = createKnowledgeGraphIndex(document);
  const started = performance.now(); const funnel = layoutKnowledgeFunnel(document, { index }); const elapsed = performance.now() - started;
  assert.equal(funnel.positions.size, topics.length + points.length);
  assert.ok(elapsed < 1500, `1,500 points lay out quickly (${elapsed.toFixed(0)} ms)`);
  const centrality = knowledgeGraphCentrality(index); const largest = Math.max(...points.map((point) => index.descendants(point.key).size));
  for (const point of points.slice(0, 40)) {
    assert.ok(Math.abs(centrality.get(point.key) - Math.max(.02, Math.log(1 + index.descendants(point.key).size) / Math.log(1 + largest))) < 1e-9);
  }
});

test("chain layout puts every prerequisite below, the nearest successors above and shortcuts aside", () => {
  let state = 7; const unique = () => (state = (state * 48271) % 2147483647) / 2147483647;
  const added = addKnowledgeNodesFromLines(seed, key("quadratic-equation"), "甲\n乙\n丙\n焦点\n丁\n戊\n己", { chain: true }, unique);
  const [first, second, third, focus, fourth, fifth, sixth] = added.keys;
  let document = removeKnowledgeEdge(added.document, fifth, sixth);
  document = addKnowledgeEdge(addKnowledgeEdge(document, first, focus), focus, sixth);
  const index = createKnowledgeGraphIndex(document);
  const chain = layoutKnowledgeChain(index, focus);
  const rank = new Map(chain.levels.flatMap((level) => level.keys.map((nodeKey) => [nodeKey, level.rank])));
  assert.deepEqual([first, second, third, focus, fourth, fifth, sixth].map((nodeKey) => rank.get(nodeKey)), [-3, -2, -1, 0, 1, 2, 1]);
  assert.deepEqual(chain.levels.map((level) => level.rank), [-3, -2, -1, 0, 1, 2], "levels run from the earliest prerequisite upward");
  assert.deepEqual(chain.shortcuts.map((edge) => [edge.sourceKey, edge.targetKey]), [[first, focus]], "a relation implied by a longer route is set aside");
  assert.ok(chain.edges.every((edge) => rank.get(edge.targetKey) > rank.get(edge.sourceKey)), "every drawn relation points upward");
  assert.equal(chain.ancestors, 3);
  assert.deepEqual(chain.descendants, { shown: 3, total: 3 });
  const folded = layoutKnowledgeChain(index, focus, { descendantLimit: 2 });
  assert.deepEqual(folded.descendants, { shown: 2, total: 3 }, "successors come in whole steps up to the budget");
  assert.equal(folded.levels.at(-1).rank, 1);
  assert.deepEqual(layoutKnowledgeChain(index, focus), chain, "layout is deterministic");
  assert.equal(layoutKnowledgeChain(index, "cn-math:point:missing"), null);
});

test("mastery statements are normalized, diffed and editable", () => {
  const raw = structuredClone(seed);
  raw.nodes.find((node) => node.key === key("circle")).mastery = `  能用垂径定理求弦长${"。".repeat(200)}`;
  raw.nodes.find((node) => node.level === "domain").mastery = "领域不需要";
  const normalized = normalizeKnowledgeGraph(raw);
  assert.equal(normalized.nodes.find((node) => node.key === key("circle")).mastery.length, 120);
  assert.equal(normalized.nodes.find((node) => node.level === "domain").mastery, undefined);
  assert.equal(normalizeKnowledgeGraph(seed).nodes.some((node) => "mastery" in node), false, "empty mastery stays absent so published hashes do not change");
  const edited = updateKnowledgeNode(seed, key("circle"), { mastery: "能用圆周角定理求角" });
  assert.equal(edited.nodes.find((node) => node.key === key("circle")).mastery, "能用圆周角定理求角");
  assert.deepEqual(diffKnowledgeGraphs(seed, edited).nodes.updated.map((item) => item.fields), [["mastery"]]);
  assert.equal("mastery" in updateKnowledgeNode(edited, key("circle"), { mastery: "" }).nodes.find((node) => node.key === key("circle")), false);
});

test("batch entry adds points in order, skips duplicates and can chain prerequisites", () => {
  const result = addKnowledgeNodesFromLines(seed, key("quadratic-equation"), "配方法｜能用配方法解方程｜配方、配方解法\n\n公式法|能用求根公式解方程\n配方法｜重复", { chain: true }, random);
  assert.equal(result.keys.length, 2);
  assert.deepEqual(result.skipped, ["配方法"]);
  const [first, second] = result.keys.map((nodeKey) => result.document.nodes.find((node) => node.key === nodeKey));
  assert.deepEqual([first.label, first.mastery, first.aliases, first.parentKey, first.stage], ["配方法", "能用配方法解方程", ["配方", "配方解法"], key("quadratic-equation"), 9]);
  assert.ok(first.order < second.order);
  assert.ok(result.document.edges.some((edge) => edge.sourceKey === first.key && edge.targetKey === second.key && edge.relationship === "prerequisite"));
  assert.deepEqual(validateKnowledgeGraph(result.document, { previous: seed }).errors, []);
  assert.equal(addKnowledgeNodesFromLines(seed, key("circle"), "垂径定理", {}, random).document.edges.length, seed.edges.length, "no chain unless asked");
  assert.throws(() => addKnowledgeNodesFromLines(seed, "cn-math:domain:geometry", "垂径定理"), /先选中一个主题/);
  assert.throws(() => addKnowledgeNodesFromLines(seed, key("circle"), Array.from({ length: 201 }, (_, row) => `点${row}`).join("\n")), /200/);
});

test("importing a graph file keeps every published key as archived history", () => {
  const file = structuredClone(seed);
  file.nodes = file.nodes.filter((node) => node.key !== key("circle"));
  file.edges = file.edges.filter((edge) => edge.sourceKey !== key("circle") && edge.targetKey !== key("circle"));
  file.mappings = file.mappings.filter((mapping) => mapping.nodeKey !== key("circle"));
  const imported = importKnowledgeGraphDraft(seed, JSON.parse(JSON.stringify(file)));
  const circle = imported.nodes.find((node) => node.key === key("circle"));
  assert.equal(circle.status, "archived");
  assert.deepEqual(validateKnowledgeGraph(imported, { previous: seed }).errors, []);
  assert.equal(createKnowledgeGraphIndex(imported).activeKeys.has(key("circle")), false);
  assert.throws(() => importKnowledgeGraphDraft(seed, { ...file, graphId: "other-graph" }), /另一张图谱/);
  assert.throws(() => importKnowledgeGraphDraft(seed, { ...file, nodes: [] }), /没有知识点/);
});

test("points inherit their topic's textbook position until calibrated", () => {
  const mapped = setKnowledgeMapping(seed, key("circle"), "pep", { volume: "九上", unitLabel: "第二十四章 圆" });
  const point = addKnowledgeNode(mapped, { level: "point", parentKey: key("circle"), label: "垂径定理" }, random);
  const index = createKnowledgeGraphIndex(point.document);
  assert.deepEqual(index.mappingsFor(point.key).map((item) => [item.nodeKey, item.editionLabel, item.volume, item.unitLabel]), [[point.key, "人教版", "九上", "第二十四章 圆"]]);
  const own = setKnowledgeMapping(point.document, point.key, "pep", { volume: "九上", unitLabel: "24.1.2 垂直于弦的直径" });
  assert.equal(createKnowledgeGraphIndex(own).mappingsFor(point.key)[0].unitLabel, "24.1.2 垂直于弦的直径");
});

test("edit operations keep the graph valid and refuse changes that would break it", () => {
  const topic = addKnowledgeNode(seed, { level: "topic", domainKey: "cn-math:domain:number-algebra", stage: 9 }, random);
  assert.match(topic.key, /^cn-math:topic:[a-z0-9]{8}$/);
  assert.equal(topic.document.nodes.find((node) => node.key === topic.key).label, "新主题");
  assert.equal(addKnowledgeNode(topic.document, { level: "topic", domainKey: "cn-math:domain:number-algebra" }, random).document.nodes.at(-1).label, "新主题 2");
  assert.throws(() => addKnowledgeNode(seed, { level: "point", parentKey: "cn-math:domain:geometry" }), /主题下面/);

  const linked = addKnowledgeEdge(topic.document, key("quadratic-function"), topic.key, "supports", "  二次函数是基础  ");
  assert.deepEqual(linked.edges.at(-1), { sourceKey: key("quadratic-function"), targetKey: topic.key, relationship: "supports", strength: "soft", reason: "二次函数是基础" });
  assert.throws(() => addKnowledgeEdge(linked, topic.key, key("rational-numbers")), /会形成循环：新主题 → 有理数及其运算 → .* → 新主题/);
  assert.throws(() => addKnowledgeEdge(linked, key("quadratic-function"), topic.key), /已存在关系/);
  assert.throws(() => addKnowledgeEdge(linked, "cn-math:domain:geometry", topic.key), /领域之间不设前后关系/);
  const retyped = updateKnowledgeEdge(linked, key("quadratic-function"), topic.key, { relationship: "prerequisite" });
  assert.equal(retyped.edges.at(-1).strength, "hard");
  assert.equal(removeKnowledgeEdge(retyped, key("quadratic-function"), topic.key).edges.length, seed.edges.length);
  assert.deepEqual(validateKnowledgeGraph(retyped, { previous: seed }).errors, []);

  const published = new Set(seed.nodes.map((node) => node.key));
  const archived = removeKnowledgeNode(seed, key("circle"), published);
  assert.equal(archived.archived, true);
  assert.equal(archived.document.nodes.find((node) => node.key === key("circle")).status, "archived");
  assert.equal(archived.document.edges.some((edge) => edge.sourceKey === key("circle") || edge.targetKey === key("circle")), false);
  assert.deepEqual(validateKnowledgeGraph(archived.document, { previous: seed }).errors, []);
  const deleted = removeKnowledgeNode(topic.document, topic.key, published);
  assert.equal(deleted.archived, false);
  assert.equal(deleted.document.nodes.length, seed.nodes.length, "unpublished drafts are deleted outright");
  assert.throws(() => removeKnowledgeNode(seed, "cn-math:domain:geometry", published), /下的 11 个下级知识点/);
  assert.equal(restoreKnowledgeNode(archived.document, key("circle")).nodes.find((node) => node.key === key("circle")).status, "active");

  const moved = updateKnowledgeNode(seed, key("coordinate-plane"), { domainKey: "cn-math:domain:number-algebra", stage: 8, aliases: ["坐标", "坐标", " 象限 "] });
  const movedNode = moved.nodes.find((node) => node.key === key("coordinate-plane"));
  assert.deepEqual([movedNode.domainKey, movedNode.parentKey, movedNode.stage, movedNode.aliases], ["cn-math:domain:number-algebra", "cn-math:domain:number-algebra", 8, ["坐标", "象限"]]);
  const reordered = moveKnowledgeNode(seed, "cn-math:domain:geometry", -1);
  const domains = reordered.nodes.filter((node) => node.level === "domain").sort((left, right) => left.order - right.order).map((node) => node.label);
  assert.deepEqual(domains.slice(0, 2), ["图形与几何", "数与代数"]);
  const mapped = setKnowledgeMapping(seed, key("circle"), "pep", { volume: "九上", unitLabel: "第二十四章 圆" });
  assert.deepEqual(createKnowledgeGraphIndex(mapped).mappingsFor(key("circle")).map((item) => [item.editionLabel, item.volume, item.unitLabel]), [["人教版", "九上", "第二十四章 圆"]]);
  assert.equal(setKnowledgeMapping(mapped, key("circle"), "pep", null).mappings.length, seed.mappings.length);
});

test("merging moves relations, children and aliases, and never leaves a cycle", () => {
  const withPoint = addKnowledgeNode(seed, { level: "point", parentKey: key("fractions"), label: "分式方程" }, random);
  const merged = mergeKnowledgeNode(withPoint.document, key("fractions"), key("radicals"));
  const target = merged.nodes.find((node) => node.key === key("radicals"));
  assert.ok(target.aliases.includes("分式") && target.aliases.includes("分式方程"));
  assert.equal(merged.nodes.find((node) => node.key === withPoint.key).parentKey, key("radicals"));
  assert.ok(merged.edges.some((edge) => edge.sourceKey === key("factorization") && edge.targetKey === key("radicals")));
  assert.equal(merged.edges.some((edge) => edge.sourceKey === key("fractions") || edge.targetKey === key("fractions")), false);
  assert.deepEqual(validateKnowledgeGraph(merged, { previous: seed }).errors, []);
  assert.throws(() => mergeKnowledgeNode(seed, key("linear-function"), key("rational-numbers")), /形成循环：.*有理数及其运算/);
  assert.throws(() => mergeKnowledgeNode(seed, "cn-math:domain:geometry", "cn-math:domain:number-algebra"), /同一层级/);
});

test("draft diffs summarize what a publish will change", () => {
  const topic = addKnowledgeNode(seed, { level: "topic", domainKey: "cn-math:domain:geometry", label: "尺规作图", stage: 8 }, random);
  let draft = addKnowledgeEdge(topic.document, key("triangles"), topic.key);
  draft = updateKnowledgeNode(draft, key("circle"), { description: "圆的性质与计算" });
  draft = removeKnowledgeNode(draft, key("probability"), new Set(seed.nodes.map((node) => node.key))).document;
  const diff = diffKnowledgeGraphs(seed, draft);
  assert.deepEqual(diff.nodes.added.map((node) => node.label), ["尺规作图"]);
  assert.deepEqual(diff.nodes.updated.map(({ node, fields }) => [node.label, fields]), [["圆", ["description"]]]);
  assert.deepEqual(diff.nodes.archived.map((node) => node.label), ["概率初步"]);
  assert.equal(diff.edges.added.length, 1);
  assert.equal(diff.edges.removed.length, 1);
  assert.deepEqual(summarizeKnowledgeGraphDiff(diff), { nodesAdded: 1, nodesUpdated: 1, nodesArchived: 1, nodesRemoved: 0, edgesAdded: 1, edgesUpdated: 0, edgesRemoved: 1, meta: 0 });
  assert.equal(diffKnowledgeGraphs(seed, structuredClone(seed)).changed, false);
});

test("gap diagnosis traces weak topics back to their earliest weak prerequisite", () => {
  const index = createKnowledgeGraphIndex(seed);
  const profile = [
    { key: key("algebraic-expressions"), status: "attention", evidenceCount: 4 },
    { key: key("linear-equation"), status: "attention", evidenceCount: 3 },
    { key: key("inequality"), status: "developing", evidenceCount: 2 },
    { key: key("rational-numbers"), status: "stable", evidenceCount: 5 },
    { key: key("triangles"), status: "developing", evidenceCount: 2 },
    { key: key("congruence"), status: "insufficient", evidenceCount: 1 },
  ];
  const diagnosis = diagnoseKnowledgeGaps(index, profile);
  assert.deepEqual(diagnosis.roots.map((root) => root.label), ["整式与代数式"], "the downstream weak equation is not a separate root");
  assert.ok(diagnosis.roots[0].weakDescendants.includes(key("linear-equation")));
  assert.deepEqual(diagnosis.developing.map((root) => root.label), ["三角形"], "developing topics below an attention root are not repeated");
  assert.equal(diagnosis.counts.attention, 2);
  assert.equal(diagnosis.counts.unassessed, index.activeNodes.filter((node) => node.level !== "domain").length - profile.length);
  assert.deepEqual(diagnosis.stages.map((stage) => [stage.stage, stage.stable, stage.attention]), [[7, 1, 2], [8, 0, 0], [9, 0, 0]]);
});

test("capability profiles follow the published graph, including merged keys", () => {
  const merged = mergeKnowledgeNode(seed, key("inverse-proportion"), key("linear-function"));
  const graph = createKnowledgeGraphIndex(merged, { version: 2 });
  const now = 2_000_000_000_000;
  const profile = buildCapabilityProfile([
    { capabilityKey: key("inverse-proportion"), capabilityLabel: "反比例函数", verdict: "incorrect", confidence: .9, assignmentId: "a", questionNumber: "3", diagnosis: "", createdAt: now },
    { capabilityKey: key("inverse-proportion"), capabilityLabel: "反比例函数", verdict: "incorrect", confidence: .9, assignmentId: "a", questionNumber: "4", diagnosis: "", createdAt: now },
  ], { studentId: "s", now, includeAllKnowledge: true, graph });
  assert.equal(profile.frameworkVersion, "cn-math-junior-v2");
  assert.equal(profile.nodes.some((node) => node.key === key("inverse-proportion")), false, "archived nodes leave the visible graph");
  const target = profile.nodes.find((node) => node.key === key("linear-function"));
  assert.equal(target.evidenceCount, 2);
  assert.equal(target.status, "attention");
});
