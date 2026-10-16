"use client";

import "../../knowledge-graph/knowledge-graph.css";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createKnowledgeGraphIndex, layoutKnowledgeChain, layoutKnowledgeFunnel } from "../../../lib/knowledge-graph-core.mjs";
import { DEFAULT_KNOWLEDGE_GRAPH } from "../../../lib/knowledge-graph-course.mjs";
import { knowledgeGraphApi } from "../../../lib/knowledge-graph-api-client";
import type { PublishedKnowledgeGraph, Question } from "../../../lib/types";
import GraphCloud, { type CloudCommand, type CloudTip } from "./GraphCloud";
import { buildChainView, buildCloudView, buildHighlight, stageName, stageShort, type GraphFilters } from "./graph-model";

const FILTERS: GraphFilters = { stage: "all", hiddenDomains: [], evidenceOnly: false };
// The side panel is narrow: a long successor tree is folded so the prerequisites stay readable.
const CHAIN_SUCCESSORS = 18;

// 组卷篮 · 右栏: the question selected in the middle column, placed on the published 知识图谱 with
// what it rests on (below) and what it opens (above). Clicking a dot follows the chain from there.
export default function BasketKnowledgeMap({ question, number }: { question: Question | null; number: number }) {
  const shellRef = useRef<HTMLElement>(null);
  const [graph, setGraph] = useState<PublishedKnowledgeGraph | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<{ questionId: string; key: string } | null>(null);
  const [command, setCommand] = useState<CloudCommand | null>(null);

  useEffect(() => {
    let live = true;
    knowledgeGraphApi.overview(DEFAULT_KNOWLEDGE_GRAPH).then((overview) => { if (live) setGraph(overview.graph); })
      .catch((reason) => { if (live) setError(reason instanceof Error ? reason.message : "知识图谱读取失败"); });
    return () => { live = false; };
  }, []);

  const index = useMemo(() => graph ? createKnowledgeGraphIndex(graph.document, { version: graph.version }) : null, [graph]);
  const funnel = useMemo(() => index ? layoutKnowledgeFunnel(index.document, { index }) : null, [index]);
  const view = useMemo(() => index && funnel ? buildCloudView({ index, funnel, filters: FILTERS, profile: null }) : null, [funnel, index]);

  // The question's own tags, as saved by the library. A question tagged only with a domain lights that domain's topics.
  const tagged = useMemo(() => {
    if (!index || !question) return [];
    return [...new Set((question.taxonomyKeys ?? []).map((key) => index.resolveKey(key)).filter((key): key is string => Boolean(key)))];
  }, [index, question]);
  const points = useMemo(() => tagged.filter((key) => view?.indexOf.has(key)), [tagged, view]);
  const domainOnly = !points.length && tagged.length ? index?.nodeByKey.get(tagged[0]) ?? null : null;
  const focus = question && picked?.questionId === question.id ? picked.key : points[0] ?? "";

  const chain = useMemo(() => index && focus ? layoutKnowledgeChain(index, focus, { descendantLimit: CHAIN_SUCCESSORS }) : null, [focus, index]);
  const cloudChain = useMemo(() => view ? buildChainView(view, chain) : null, [chain, view]);
  const marked = useMemo(() => domainOnly ? (index?.children.get(domainOnly.key) ?? []).map((node) => node.key) : points.filter((key) => key !== focus), [domainOnly, focus, index, points]);
  const highlight = useMemo(() => view && index ? buildHighlight({ view, index, selectedKey: focus, marked, linkSourceKey: "" }) : null, [focus, index, marked, view]);

  // Leaving a chain (a question without points) turns the funnel back to its overview.
  const hadChain = useRef(false);
  useEffect(() => {
    if (hadChain.current && !cloudChain) setCommand({ kind: "reset", token: Date.now() });
    hadChain.current = Boolean(cloudChain);
  }, [cloudChain]);

  const pick = useCallback((position: number) => {
    const key = position >= 0 ? view?.keys[position] ?? "" : "";
    if (key && question) setPicked({ questionId: question.id, key });
  }, [question, view]);

  const colorOf = useCallback((key: string) => {
    const node = index?.nodeByKey.get(key);
    return funnel?.colors.get(key) ?? (node ? index?.nodeByKey.get(node.domainKey)?.color : undefined) ?? "#8a94a6";
  }, [funnel, index]);

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

  const node = focus ? index?.nodeByKey.get(focus) : null;
  const topic = node?.level === "point" ? index?.nodeByKey.get(node.parentKey ?? "") : null;
  const domain = node ? index?.nodeByKey.get(node.domainKey) : null;
  const relation = (keys: string[]) => keys.map((key) => index?.nodeByKey.get(key)).filter((item) => item && item.status !== "archived")
    .sort((left, right) => left!.stage - right!.stage || left!.order - right!.order);
  const before = node && index ? relation((index.incoming.get(node.key) ?? []).map((edge) => edge.sourceKey)) : [];
  const after = node && index ? relation((index.outgoing.get(node.key) ?? []).map((edge) => edge.targetKey)) : [];
  const relationList = (title: string, items: typeof before, arrow: string) => <div className="kgb-relation">
    <h3><span aria-hidden="true">{arrow}</span>{title}<small>{items.length}</small></h3>
    {items.length ? <ul>{items.slice(0, 6).map((item) => <li key={item!.key}>
      <button type="button" title={`${item!.label} · ${index ? stageName(index, item!.stage) : ""}`} onClick={() => question && setPicked({ questionId: question.id, key: item!.key })}>
        <i style={{ background: colorOf(item!.key) }} aria-hidden="true" /><span>{item!.label}</span><small>{index ? stageShort(stageName(index, item!.stage)) : ""}</small>
      </button></li>)}
      {items.length > 6 && <li className="kgb-more">另 {items.length - 6} 个见图中</li>}</ul> : <p>{arrow === "↓" ? "起点知识，无前置" : "暂无后续"}</p>}
  </div>;

  return <aside ref={shellRef} className={`kg-shell kgb-shell ${cloudChain ? "has-chain" : ""}`} aria-label="本题知识图谱">
    {view && highlight && <GraphCloud model={view.model} highlight={highlight} chain={cloudChain} spin={!cloudChain} command={command} shellRef={shellRef}
      describe={describe} onPick={pick} onUnavailable={setError} />}
    <header className="kgb-head" data-inset="auto">
      <p className="kgb-eyebrow"><span>知识图谱</span>{question && <b key={question.id}>第 {number} 题</b>}</p>
      {question && <div className="kgb-tags" key={question.id}>
        {points.map((key, position) => <button type="button" key={key} className={key === focus ? "active" : ""} aria-pressed={key === focus}
          style={{ "--kgb-color": colorOf(key), animationDelay: `${position * 60}ms` } as CSSProperties} onClick={() => setPicked({ questionId: question.id, key })}>
          <i aria-hidden="true" />{index?.nodeByKey.get(key)?.label}
        </button>)}
        {domainOnly && <span className="kgb-domain">只标到领域「{domainOnly.label}」</span>}
        {!tagged.length && index && <span className="kgb-domain">这道题还没有知识点标签</span>}
      </div>}
    </header>
    {(error || !graph) && <p className="kgb-status" role={error ? "alert" : "status"}>{error || "正在载入知识图谱…"}</p>}
    {node && index && <footer className="kgb-card" data-inset="auto" key={node.key}>
      <p className="kgb-path"><i style={{ background: colorOf(node.key) }} aria-hidden="true" />{[domain?.label, topic?.label].filter(Boolean).join(" › ")} · {stageName(index, node.stage)}</p>
      <h2>{node.label}</h2>
      {(node.mastery || node.description) && <p className="kgb-desc">{node.mastery || node.description}</p>}
      <div className="kgb-relations">{relationList("前置", before, "↓")}{relationList("后续", after, "↑")}</div>
    </footer>}
  </aside>;
}
