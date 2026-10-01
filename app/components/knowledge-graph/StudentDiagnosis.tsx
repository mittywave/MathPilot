"use client";

import type { KnowledgeGapDiagnosis, KnowledgeGapRoot, KnowledgeGraphIndex } from "../../../lib/knowledge-graph-core.mjs";
import type { CapabilityProfileNode } from "../../../lib/types";
import { STATUS_META, STATUS_ORDER, learningStatus, stageShort } from "./graph-model";

type Props = {
  studentName: string;
  diagnosis: KnowledgeGapDiagnosis;
  index: KnowledgeGraphIndex;
  skills: CapabilityProfileNode[];
  onSelect: (key: string) => void;
};

function rootLine(root: KnowledgeGapRoot, index: KnowledgeGraphIndex) {
  const stage = index.document.stages.find((item) => item.value === root.stage)?.label ?? "";
  const weak = root.weakDescendants.length ? ` · 牵连 ${root.weakDescendants.length} 个不稳` : "";
  return `${stageShort(stage)} · 影响后续 ${root.impact} 个${weak}`;
}

// Replaces the hero while a student is overlaid: state, then what to fix first.
export default function StudentDiagnosis({ studentName, diagnosis, index, skills, onSelect }: Props) {
  const { counts } = diagnosis; const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const assessed = total - counts.unassessed;
  return <section className="kg-diagnosis" aria-label={`${studentName}的学情诊断`} data-inset="auto">
    <p className="kg-diagnosis-eyebrow">学情诊断 · 已检测 {assessed}/{total}</p>
    <h2>{studentName}<span className="kg-red" aria-hidden="true">。</span></h2>
    <div className="kg-status-bar" aria-hidden="true">
      {STATUS_ORDER.map((status) => counts[status] ? <i key={status} style={{ flexGrow: counts[status], background: STATUS_META[status].color }} /> : null)}
    </div>
    <ul className="kg-status-legend">
      {STATUS_ORDER.filter((status) => counts[status] && status !== "unassessed").map((status) => <li key={status}><i style={{ background: STATUS_META[status].color }} />{STATUS_META[status].short} {counts[status]}</li>)}
    </ul>
    {!assessed ? <p className="kg-diagnosis-empty">还没有批改证据。作业批改发布后，这里会自动标出薄弱环节和建议先补的知识点。</p> : <>
      <h3>建议先补</h3>
      {diagnosis.roots.length ? <ol className="kg-root-list">
        {diagnosis.roots.slice(0, 3).map((root) => <li key={root.key}><button type="button" onClick={() => onSelect(root.key)}>
          <b>{root.label}</b><small>{rootLine(root, index)}</small>
        </button></li>)}
      </ol> : <p className="kg-diagnosis-empty">目前没有“需要关注”的知识点。</p>}
      {diagnosis.developing.length > 0 && <p className="kg-diagnosis-secondary"><span>待巩固</span>
        {diagnosis.developing.slice(0, 4).map((root) => <button key={root.key} type="button" onClick={() => onSelect(root.key)}>{root.label}</button>)}
      </p>}
      <ul className="kg-stage-summary">
        {diagnosis.stages.filter((stage) => stage.total).map((stage) => <li key={stage.stage}>
          <span>{stage.label}</span><b>{stage.stable}</b><small>/ {stage.total} 稳定{stage.attention ? ` · 需关注 ${stage.attention}` : ""}</small>
        </li>)}
      </ul>
    </>}
    {skills.length > 0 && <details className="kg-diagnosis-skills">
      <summary>核心能力 {skills.length}</summary>
      <ul>{skills.map((skill) => { const status = learningStatus(skill); return <li key={skill.key} title={STATUS_META[status].label}>
        <i style={{ background: STATUS_META[status].color }} />{skill.label}<small>{STATUS_META[status].short}</small>
      </li>; })}</ul>
    </details>}
  </section>;
}
