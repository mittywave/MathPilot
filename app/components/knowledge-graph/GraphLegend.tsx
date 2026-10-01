"use client";

import type { KnowledgeGapDiagnosis, KnowledgeGraphFunnel, KnowledgeGraphIndex } from "../../../lib/knowledge-graph-core.mjs";
import { STATUS_META, STATUS_ORDER, stageShort, type GraphFilters } from "./graph-model";

type Props = {
  index: KnowledgeGraphIndex;
  funnel: KnowledgeGraphFunnel;
  filters: GraphFilters;
  onChange: (filters: GraphFilters) => void;
  diagnosis: KnowledgeGapDiagnosis | null;
};

export default function GraphLegend({ index, funnel, filters, onChange, diagnosis }: Props) {
  // Count points once the graph has them; a topic-only skeleton counts its topics.
  const level = index.activeNodes.some((node) => node.level === "point") ? "point" : "topic";
  const counts = new Map<string, number>();
  for (const node of index.activeNodes) if (node.level === level) counts.set(node.domainKey, (counts.get(node.domainKey) ?? 0) + 1);
  const toggle = (domainKey: string) => onChange({
    ...filters, hiddenDomains: filters.hiddenDomains.includes(domainKey) ? filters.hiddenDomains.filter((key) => key !== domainKey) : [...filters.hiddenDomains, domainKey],
  });
  return <div className="kg-legend" data-inset="auto">
    {diagnosis && <div className="kg-legend-block status">
      <p className="kg-legend-title">掌握状态</p>
      <ul className="kg-legend-status">
        {STATUS_ORDER.map((status) => <li key={status}><i style={{ background: STATUS_META[status].color }} aria-hidden="true" />{STATUS_META[status].short}<small>{diagnosis.counts[status]}</small></li>)}
      </ul>
      <label className="kg-legend-check"><input type="checkbox" checked={filters.evidenceOnly} onChange={(event) => onChange({ ...filters, evidenceOnly: event.target.checked })} />只看有证据</label>
    </div>}
    <div className="kg-legend-block">
      <p className="kg-legend-title">领域 · 点击筛选{filters.hiddenDomains.length > 0 && <button type="button" onClick={() => onChange({ ...filters, hiddenDomains: [] })}>全部显示</button>}</p>
      <ul className="kg-legend-domains">
        {funnel.sectors.map((sector) => {
          const hidden = filters.hiddenDomains.includes(sector.domainKey);
          return <li key={sector.domainKey}>
            <button type="button" aria-pressed={!hidden} className={hidden ? "off" : ""} onClick={() => toggle(sector.domainKey)}>
              <i style={{ background: diagnosis ? "transparent" : sector.color, borderColor: sector.color }} aria-hidden="true" />{sector.label}<small>{counts.get(sector.domainKey) ?? 0}</small>
            </button>
          </li>;
        })}
      </ul>
    </div>
    <div className="kg-legend-stages" role="group" aria-label="年级">
      <button type="button" aria-pressed={filters.stage === "all"} className={filters.stage === "all" ? "active" : ""} onClick={() => onChange({ ...filters, stage: "all" })}>全部</button>
      {index.document.stages.map((stage) => <button key={stage.value} type="button" aria-pressed={filters.stage === stage.value} className={filters.stage === stage.value ? "active" : ""}
        onClick={() => onChange({ ...filters, stage: stage.value })}>{stageShort(stage.label)}</button>)}
    </div>
  </div>;
}
