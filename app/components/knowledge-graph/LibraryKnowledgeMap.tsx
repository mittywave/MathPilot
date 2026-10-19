"use client";

import "../../knowledge-graph/knowledge-graph.css";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createKnowledgeGraphIndex, layoutKnowledgeChain, layoutKnowledgeFunnel, type KnowledgeGraphIndex } from "../../../lib/knowledge-graph-core.mjs";
import { DEFAULT_KNOWLEDGE_GRAPH } from "../../../lib/knowledge-graph-course.mjs";
import { knowledgeGraphApi } from "../../../lib/knowledge-graph-api-client";
import type { Category, PublishedKnowledgeGraph, Question } from "../../../lib/types";
import type { CloudPalette } from "./cloud-renderer";
import type { TreeLight } from "../CategoryTree";
import GraphCloud, { type CloudCommand, type CloudTip } from "./GraphCloud";
import { buildChainView, buildCloudView, buildHighlight, stageName, stageShort, type GraphFilters } from "./graph-model";

export type KnowledgeMapFocus = { kind: "question"; question: Question; number: number } | { kind: "category"; id: string; name: string };

const FILTERS: GraphFilters = { stage: "all", hiddenDomains: [], evidenceOnly: false };
// The side panel is narrow: a long successor tree is folded so the prerequisites stay readable.
const CHAIN_SUCCESSORS = 18;
// One request per page load, so switching between 题库 and 组卷篮 does not fetch the graph again.
let graphRequest: Promise<PublishedKnowledgeGraph> | null = null;

const normalized = (value: string) => value.trim().toLowerCase().replace(/\s+/g, "");

// The panel is drawn in the site's own colours, so it follows 浅色/深色 and 风格: text and lines from the ink tokens,
// the four domains from the accent palette (数与代数, 图形与几何, 统计与概率, 综合与实践 in the graph's order).
type SitePalette = { cloud: CloudPalette; domains: string[] };
const DOMAIN_TOKENS = ["--green", "--sky", "--warn", "--violet"];
function readSitePalette(): SitePalette {
  const style = getComputedStyle(document.documentElement);
  const context = document.createElement("canvas").getContext("2d");
  const color = (token: string, fallback: string) => {
    if (!context) return fallback;
    context.fillStyle = fallback; context.fillStyle = style.getPropertyValue(token).trim() || fallback;
    return String(context.fillStyle);
  };
  const rgb = (hex: string) => [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) || 0);
  const ink = color("--ink", "#24352f"); const muted = color("--muted", "#61706a"); const surface = color("--surface", "#ffffff");
  const soft = rgb(ink).map((value, channel) => Math.round((value + rgb(muted)[channel]) / 2)).join(",");
  return {
    cloud: {
      ink, muted, soft: `rgb(${soft})`, halo: `rgba(${rgb(surface)},.92)`, shadow: surface,
      edge: rgb(muted).join(","), label: rgb(muted).join(","), band: rgb(ink).join(","), pill: `rgba(${rgb(surface)},.96)`, pillLine: `rgba(${rgb(muted)},.3)`,
    },
    domains: DOMAIN_TOKENS.map((token) => color(token, "#8a94a6")),
  };
}

// A teacher's category meets the graph through its name: the whole name (数与代数, 二次函数), else the categories
// under it (函数), else each part of a joined name (实数与代数式 → 实数, 代数式; 方程 → every topic named with it).
function categoryKnowledge(index: KnowledgeGraphIndex, categories: Category[]) {
  const named = index.activeNodes.map((node) => ({ node, names: [node.label, ...node.aliases].map(normalized).filter(Boolean) }));
  const topics = named.filter((item) => item.node.level === "topic");
  const exact = (text: string) => named.filter((item) => item.names.includes(text)).map((item) => item.node.key);
  const longestInside = (text: string) => {
    let best = 0; let keys: string[] = [];
    for (const item of topics) for (const name of item.names) {
      if (!text.includes(name) || name.length < best) continue;
      if (name.length > best) { best = name.length; keys = []; }
      if (!keys.includes(item.node.key)) keys.push(item.node.key);
    }
    return keys;
  };
  const around = (text: string) => topics.filter((item) => item.names.some((name) => name.includes(text))).map((item) => item.node.key);
  const known = new Map<string, string[]>();
  const keysFor = (category: Category): string[] => {
    const cached = known.get(category.id); if (cached) return cached;
    const name = normalized(category.name);
    let keys = exact(name);
    if (!keys.length) keys = categories.filter((child) => child.parentId === category.id).flatMap(keysFor);
    if (!keys.length) keys = name.split(/与|和|及|、|，|,|\//).filter(Boolean).flatMap((part) => {
      const own = exact(part); if (own.length) return own;
      const inside = longestInside(part); return inside.length ? inside : around(part);
    });
    const unique = [...new Set(keys)];
    known.set(category.id, unique);
    return unique;
  };
  for (const category of categories) keysFor(category);
  return known;
}

// 题库 · 右栏: the published 知识图谱 beside the questions. The question clicked, or else the category picked
// in the tree, opens its chain (prerequisites below, what it unlocks above); the tree lights the categories it belongs to.
function LibraryKnowledgeMap({ focus, moduleId, categories, onLight, onCollapse, onReset }: {
  focus: KnowledgeMapFocus; moduleId: string; categories: Category[]; onLight: (light: TreeLight | null) => void; onCollapse: () => void; onReset: () => void;
}) {
  const shellRef = useRef<HTMLElement>(null);
  const [graph, setGraph] = useState<PublishedKnowledgeGraph | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<{ focus: string; key: string } | null>(null);
  const [command, setCommand] = useState<CloudCommand | null>(null);
  // Read once on mount (the panel only renders in the browser) and again whenever the appearance changes.
  const [site, setSite] = useState<SitePalette>(readSitePalette);
  useEffect(() => {
    const observer = new MutationObserver(() => setSite(readSitePalette()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-style"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let live = true;
    graphRequest ??= knowledgeGraphApi.overview(DEFAULT_KNOWLEDGE_GRAPH).then((overview) => overview.graph);
    graphRequest.then((value) => { if (live) setGraph(value); }).catch((reason) => {
      graphRequest = null;
      if (live) setError(reason instanceof Error ? reason.message : "知识图谱读取失败");
    });
    return () => { live = false; };
  }, []);

  // The domains take the site palette; every topic and point is shaded from its domain as before.
  const index = useMemo(() => {
    if (!graph) return null;
    const domains = graph.document.nodes.filter((node) => node.level === "domain").sort((left, right) => left.order - right.order || left.key.localeCompare(right.key));
    const colors = new Map(domains.map((domain, position) => [domain.key, site.domains[position % site.domains.length]]));
    const nodes = graph.document.nodes.map((node) => colors.has(node.key) ? { ...node, color: colors.get(node.key) } : node);
    return createKnowledgeGraphIndex({ ...graph.document, nodes }, { version: graph.version });
  }, [graph, site]);
  const funnel = useMemo(() => index ? layoutKnowledgeFunnel(index.document, { index }) : null, [index]);
  const view = useMemo(() => index && funnel ? buildCloudView({ index, funnel, filters: FILTERS, profile: null }) : null, [funnel, index]);

  // The categories of this module, each matched to graph nodes once per graph and tree.
  const ownCategories = useMemo(() => {
    const ids = new Set([moduleId]); const own: Category[] = [];
    for (let grown = true; grown;) {
      grown = false;
      for (const category of categories) if (!ids.has(category.id) && category.parentId && ids.has(category.parentId)) { ids.add(category.id); own.push(category); grown = true; }
    }
    return own;
  }, [categories, moduleId]);
  const knowledgeOf = useMemo(() => index ? categoryKnowledge(index, ownCategories) : new Map<string, string[]>(), [index, ownCategories]);

  const focusId = focus.kind === "question" ? `q:${focus.question.id}` : `c:${focus.id}`;
  const rawKeys = focus.kind === "question" ? focus.question.taxonomyKeys : knowledgeOf.get(focus.id);
  const keys = useMemo(() => index ? [...new Set((rawKeys ?? []).map((key) => index.resolveKey(key)).filter((key): key is string => Boolean(key)))] : [], [index, rawKeys]);
  const points = useMemo(() => keys.filter((key) => view?.indexOf.has(key)), [keys, view]);
  const domain = points.length ? null : keys.map((key) => index?.nodeByKey.get(key)).find((node) => node?.level === "domain") ?? null;
  const focusKey = picked?.focus === focusId ? picked.key : points[0] ?? "";

  const chain = useMemo(() => index && focusKey ? layoutKnowledgeChain(index, focusKey, { descendantLimit: CHAIN_SUCCESSORS }) : null, [focusKey, index]);
  const cloudChain = useMemo(() => view ? buildChainView(view, chain) : null, [chain, view]);
  // Without a point to follow, a domain lights its topics in the turning funnel.
  const marked = useMemo(() => !focusKey && domain ? (index?.children.get(domain.key) ?? []).map((node) => node.key) : points.filter((key) => key !== focusKey),
    [domain, focusKey, index, points]);
  const highlight = useMemo(() => view && index ? buildHighlight({ view, index, selectedKey: focusKey, marked, linkSourceKey: "" }) : null, [focusKey, index, marked, view]);

  // Leaving a chain turns the funnel back to its overview.
  const hadChain = useRef(false);
  useEffect(() => {
    if (hadChain.current && !cloudChain) setCommand({ kind: "reset", token: Date.now() });
    hadChain.current = Boolean(cloudChain);
  }, [cloudChain]);

  const colorOf = useCallback((key: string) => {
    const node = index?.nodeByKey.get(key);
    return funnel?.colors.get(key) ?? (node ? index?.nodeByKey.get(node.domainKey)?.color : undefined) ?? "#8a94a6";
  }, [funnel, index]);

  // Graph → tree: the categories that hold the node on show, the most exact match winning (point, then topic, then
  // domain). A parent lights only when none of the categories under it does.
  const target = focusKey || domain?.key || "";
  useEffect(() => {
    const node = target ? index?.nodeByKey.get(target) : null;
    if (!node) { onLight(null); return; }
    const topicKey = node.level === "point" ? node.parentKey ?? "" : node.level === "topic" ? node.key : "";
    const scored = ownCategories.map((category) => {
      const own = knowledgeOf.get(category.id) ?? [];
      return { category, score: own.includes(node.key) ? 3 : topicKey && own.includes(topicKey) ? 2 : own.includes(node.domainKey) ? 1 : 0 };
    });
    const best = Math.max(0, ...scored.map((item) => item.score));
    const lit = scored.filter((item) => best && item.score === best).map((item) => item.category);
    const parentOf = new Map(ownCategories.map((category) => [category.id, category.parentId]));
    const holds = (ancestor: string, id: string) => { for (let at = parentOf.get(id); at; at = parentOf.get(at)) if (at === ancestor) return true; return false; };
    const ids = lit.filter((category) => !lit.some((other) => holds(category.id, other.id))).map((category) => category.id);
    onLight(ids.length ? { ids, color: colorOf(node.key) } : null);
  }, [colorOf, index, knowledgeOf, onLight, ownCategories, target]);
  useEffect(() => () => onLight(null), [onLight]);

  const pickKey = useCallback((key: string) => setPicked({ focus: focusId, key }), [focusId]);
  const pick = useCallback((position: number) => {
    if (position < 0) { setPicked(null); onReset(); return; }
    const key = view?.keys[position];
    if (key) pickKey(key);
  }, [onReset, pickKey, view]);

  const describe = useCallback((position: number): CloudTip | null => {
    const key = view?.keys[position]; const node = key ? index?.nodeByKey.get(key) : null;
    if (!index || !view || !node) return null;
    const parent = node.level === "point" ? index.nodeByKey.get(node.parentKey ?? "") : null;
    return {
      title: node.label, color: view.model.nodes[position].color,
      meta: `${parent?.label ?? index.nodeByKey.get(node.domainKey)?.label ?? ""} · ${stageName(index, node.stage)}`,
      detail: node.mastery || node.description,
    };
  }, [index, view]);

  const node = focusKey ? index?.nodeByKey.get(focusKey) : null;
  const topic = node?.level === "point" ? index?.nodeByKey.get(node.parentKey ?? "") : null;
  const nodeDomain = node ? index?.nodeByKey.get(node.domainKey) : null;
  const related = (relatedKeys: string[]) => relatedKeys.map((key) => index?.nodeByKey.get(key)).filter((item) => item && item.status !== "archived")
    .sort((left, right) => left!.stage - right!.stage || left!.order - right!.order);
  const before = node && index ? related((index.incoming.get(node.key) ?? []).map((edge) => edge.sourceKey)) : [];
  const after = node && index ? related((index.outgoing.get(node.key) ?? []).map((edge) => edge.targetKey)) : [];
  const relationList = (title: string, items: typeof before, arrow: string) => <div className="kgl-relation">
    <h3><span aria-hidden="true">{arrow}</span>{title}<small>{items.length}</small></h3>
    {items.length ? <ul>{items.slice(0, 6).map((item) => <li key={item!.key}>
      <button type="button" title={`${item!.label} · ${index ? stageName(index, item!.stage) : ""}`} onClick={() => pickKey(item!.key)}>
        <i style={{ background: colorOf(item!.key) }} aria-hidden="true" /><span>{item!.label}</span><small>{index ? stageShort(stageName(index, item!.stage)) : ""}</small>
      </button></li>)}
      {items.length > 6 && <li className="kgl-more">另 {items.length - 6} 个见图中</li>}</ul> : <p>{arrow === "↓" ? "起点知识，无前置" : "暂无后续"}</p>}
  </div>;

  const badge = focus.kind === "question" ? focus.question.code ? `ID ${focus.question.code}` : `第 ${focus.number} 题` : focus.id === moduleId ? "" : focus.name;
  const note = !index ? "" : domain ? `${focus.kind === "question" ? "这道题只标到领域" : "对应领域"}「${domain.label}」`
    : keys.length ? "" : focus.kind === "question" ? "这道题还没有知识点标签" : focus.id === moduleId ? "点击题目或左侧分类查看知识链，点击图谱空白处返回全景" : `「${focus.name}」没有对应的知识模块`;

  return <aside ref={shellRef} className="kgl-shell" aria-label="知识图谱">
    {view && highlight && <GraphCloud model={view.model} highlight={highlight} chain={cloudChain} spin={!cloudChain} palette={site.cloud} command={command} shellRef={shellRef}
      describe={describe} onPick={pick} onUnavailable={setError} />}
    <header className="kgl-head" data-inset="auto">
      <p className="kgl-eyebrow"><span>知识图谱</span>{badge && <b key={focusId}>{badge}</b>}
        <button type="button" className="kgl-toggle" title="收起知识图谱" aria-label="收起知识图谱" onClick={onCollapse}><PanelIcon open /></button></p>
      <div className="kgl-tags" key={focusId}>
        {points.map((key, position) => <button type="button" key={key} className={key === focusKey ? "active" : ""} aria-pressed={key === focusKey}
          style={{ "--kgl-color": colorOf(key), animationDelay: `${position * 60}ms` } as CSSProperties} onClick={() => pickKey(key)}>
          <i aria-hidden="true" />{index?.nodeByKey.get(key)?.label}
        </button>)}
        {note && <span className="kgl-note">{note}</span>}
      </div>
    </header>
    {(error || !graph) && <p className="kgl-status" role={error ? "alert" : "status"}>{error || "正在载入知识图谱…"}</p>}
    {node && index && <footer className="kgl-card" data-inset="auto" key={node.key}>
      <p className="kgl-path"><i style={{ background: colorOf(node.key) }} aria-hidden="true" />{[nodeDomain?.label, topic?.label].filter(Boolean).join(" › ")} · {stageName(index, node.stage)}</p>
      <h2>{node.label}</h2>
      {(node.mastery || node.description) && <p className="kgl-desc">{node.mastery || node.description}</p>}
      <div className="kgl-relations">{relationList("前置", before, "↓")}{relationList("后续", after, "↑")}</div>
    </footer>}
  </aside>;
}

// The library page re-renders on every keystroke and selection; the graph only follows its own inputs.
export default memo(LibraryKnowledgeMap);

function PanelIcon({ open }: { open: boolean }) {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <rect width="18" height="18" x="3" y="3" rx="2" /><path d="M15 3v18" /><path d={open ? "m8 9 3 3-3 3" : "m10 15-3-3 3-3"} />
  </svg>;
}

// The folded panel: a thin rail that keeps the graph one click away and leaves the questions the width.
export function KnowledgeMapRail({ open, onExpand }: { open: boolean; onExpand: () => void }) {
  return <aside className="kgl-rail" aria-label="知识图谱（已收起）" inert={open}>
    <button type="button" title="展开知识图谱" aria-label="展开知识图谱" onClick={onExpand}><PanelIcon open={false} /><span aria-hidden="true">知识图谱</span></button>
  </aside>;
}
