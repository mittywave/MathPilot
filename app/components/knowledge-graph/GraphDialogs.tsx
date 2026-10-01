"use client";

import { useMemo, useState, useEffect } from "react";
import { diffKnowledgeGraphs, normalizeKnowledgeGraph, validateKnowledgeGraph, type KnowledgeGraphDiff } from "../../../lib/knowledge-graph-core.mjs";
import { importKnowledgeGraphDraft } from "../../../lib/knowledge-graph-edit.mjs";
import { knowledgeGraphApi } from "../../../lib/knowledge-graph-api-client";
import type { KnowledgeGraphDocument, KnowledgeGraphIssue, KnowledgeGraphVersion } from "../../../lib/types";

const FIELD_LABEL: Record<string, string> = {
  label: "名称", level: "层级", parentKey: "上级", domainKey: "领域", stage: "年级", description: "描述", mastery: "学会的标志", aliases: "别名", order: "顺序", color: "颜色", mergedInto: "合并", mappings: "教材定位",
};

function DiffList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return <div className="kg-diff-group"><b>{title} {items.length}</b><ul>{items.slice(0, 30).map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>{items.length > 30 && <small>另有 {items.length - 30} 项</small>}</div>;
}

function diffCounts(diff: KnowledgeGraphDiff) {
  return [
    ["新增知识点", diff.nodes.added.length], ["修改", diff.nodes.updated.length + diff.nodes.restored.length], ["停用", diff.nodes.archived.length],
    ["新增关系", diff.edges.added.length], ["调整关系", diff.edges.updated.length], ["删除关系", diff.edges.removed.length],
  ] as const;
}

export function PublishDialog({ diff, nextVersion, labelOf, onCancel, onConfirm }: {
  diff: KnowledgeGraphDiff; nextVersion: number; labelOf: (key: string) => string; onCancel: () => void; onConfirm: (note: string) => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const edge = (item: { sourceKey: string; targetKey: string }) => `${labelOf(item.sourceKey)} → ${labelOf(item.targetKey)}`;
  const counts = diffCounts(diff);
  async function confirm() {
    setBusy(true); setError("");
    try { await onConfirm(note.trim()); } catch (reason) { setError(reason instanceof Error ? reason.message : "发布失败"); setBusy(false); }
  }
  return <div className="kg-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
    <div className="kg-modal" role="dialog" aria-modal="true" aria-labelledby="kg-publish-title">
      <h2 id="kg-publish-title">发布知识图谱 v{nextVersion}</h2>
      <div className="kg-diff-counts">{counts.filter(([, count]) => count).map(([label, count]) => <span key={label}><b>{count}</b>{label}</span>)}</div>
      <details className="kg-diff-detail">
        <summary>查看改动明细</summary>
        <DiffList title="新增知识点" items={diff.nodes.added.map((node) => node.label)} />
        <DiffList title="修改" items={[...diff.nodes.updated.map(({ node, fields }) => `${node.label}：${fields.map((field) => FIELD_LABEL[field] ?? field).join("、")}`), ...diff.nodes.restored.map((node) => `${node.label}：恢复启用`)]} />
        <DiffList title="停用" items={diff.nodes.archived.map((node) => node.mergedInto ? `${node.label} → 合并到 ${labelOf(node.mergedInto)}` : node.label)} />
        <DiffList title="新增关系" items={diff.edges.added.map(edge)} />
        <DiffList title="调整关系" items={diff.edges.updated.map(edge)} />
        <DiffList title="删除关系" items={diff.edges.removed.map(edge)} />
      </details>
      <label className="kg-field"><span>发布说明（可选）</span>
        <input value={note} maxLength={120} placeholder="例如：细化二次函数的知识点" onChange={(event) => setNote(event.target.value)} />
      </label>
      <p className="kg-muted">发布后，本地题库的自动打标签和学生学情分析立即使用新版本；线上站点会在下次“发布公共资源库”时同步。已发布的知识点编号保持不变，历史作业证据不受影响。</p>
      {error && <p className="kg-error" role="alert">{error}</p>}
      <footer><button type="button" className="kg-button" disabled={busy} onClick={onCancel}>取消</button>
        <button type="button" className="kg-button primary" disabled={busy} onClick={() => void confirm()}>{busy ? "正在发布…" : `发布 v${nextVersion}`}</button></footer>
    </div>
  </div>;
}

export function HistoryDrawer({ currentVersion, onClose, onRestore }: { currentVersion: number; onClose: () => void; onRestore: (version: number) => Promise<void> }) {
  const [versions, setVersions] = useState<KnowledgeGraphVersion[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(0);
  useEffect(() => {
    let cancelled = false;
    knowledgeGraphApi.versions().then((result) => { if (!cancelled) setVersions(result.versions); })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "版本记录读取失败"); });
    return () => { cancelled = true; };
  }, []);
  async function restore(version: number) {
    if (!window.confirm(`把 v${version} 载入为草稿？当前草稿会被替换，发布前不会影响线上与学情。`)) return;
    setBusy(version);
    try { await onRestore(version); onClose(); } catch (reason) { setError(reason instanceof Error ? reason.message : "载入失败"); setBusy(0); }
  }
  const summary = (item: KnowledgeGraphVersion) => {
    if (!item.summary) return item.version === 1 ? "初始课程骨架" : "";
    const parts = [["新增", item.summary.nodesAdded], ["修改", item.summary.nodesUpdated], ["停用", item.summary.nodesArchived],
      ["关系 +", item.summary.edgesAdded], ["关系 −", item.summary.edgesRemoved]].filter(([, count]) => count).map(([label, count]) => `${label}${count}`);
    return parts.join(" · ");
  };
  return <div className="kg-modal-backdrop drawer" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <aside className="kg-drawer" role="dialog" aria-modal="true" aria-labelledby="kg-history-title">
      <header><h2 id="kg-history-title">版本记录</h2><button type="button" className="kg-icon-button" aria-label="关闭版本记录" onClick={onClose}>×</button></header>
      {error && <p className="kg-error" role="alert">{error}</p>}
      {!versions ? <p className="kg-muted">正在读取…</p> : <ol className="kg-version-list">
        {versions.map((item) => <li key={item.version} className={item.version === currentVersion ? "current" : ""}>
          <div><b>v{item.version}</b>{item.version === currentVersion && <em>当前</em>}<small>{item.publishedAt ? new Date(item.publishedAt).toLocaleString("zh-CN") : "内置"}</small></div>
          {item.note && <p>{item.note}</p>}
          {summary(item) && <p className="kg-muted">{summary(item)}</p>}
          {item.version !== currentVersion && <button type="button" className="kg-button" disabled={Boolean(busy)} onClick={() => void restore(item.version)}>{busy === item.version ? "正在载入…" : "载入为草稿"}</button>}
        </li>)}
      </ol>}
    </aside>
  </div>;
}

type ImportPreview = { name: string; document: KnowledgeGraphDocument; diff: KnowledgeGraphDiff; errors: KnowledgeGraphIssue[]; preserved: number };

// Loads a full graph file (an export, or a prepared draft such as data/drafts/*-draft.json) as the shared draft.
export function ImportDialog({ published, current, onCancel, onConfirm }: {
  published: KnowledgeGraphDocument; current: KnowledgeGraphDocument; onCancel: () => void; onConfirm: (document: KnowledgeGraphDocument) => void;
}) {
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState("");
  const draftChanged = useMemo(() => diffKnowledgeGraphs(published, current).changed, [current, published]);
  async function read(file: File | undefined) {
    setError(""); setPreview(null);
    if (!file) return;
    if (file.size > 1_900_000) { setError("文件超过 1.9 MB，草稿无法保存；请精简描述或拆分后再导入"); return; }
    try {
      const raw = JSON.parse(await file.text()) as unknown;
      const document = importKnowledgeGraphDraft(published, raw);
      setPreview({
        name: file.name, document, diff: diffKnowledgeGraphs(published, document),
        errors: validateKnowledgeGraph(document, { previous: published }).errors, preserved: document.nodes.length - normalizeKnowledgeGraph(raw).nodes.length,
      });
    } catch (reason) { setError(reason instanceof SyntaxError ? "这不是有效的 JSON 文件" : reason instanceof Error ? reason.message : "文件读取失败"); }
  }
  return <div className="kg-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <div className="kg-modal" role="dialog" aria-modal="true" aria-labelledby="kg-import-title">
      <h2 id="kg-import-title">导入 JSON 为草稿</h2>
      <p className="kg-muted">选择导出的图谱或整理好的草稿文件。载入后仍是草稿，逐项审核无误再发布；已发布的知识点编号不会丢失。</p>
      <label className="kg-file">
        <input type="file" accept="application/json,.json" onChange={(event) => void read(event.target.files?.[0])} />
        <span>{preview ? preview.name : "选择文件"}</span><small>{preview ? "重新选择" : ".json"}</small>
      </label>
      {preview && <>
        <p className="kg-import-summary">相对已发布版本：</p>
        <div className="kg-diff-counts">{diffCounts(preview.diff).filter(([, count]) => count).map(([label, count]) => <span key={label}><b>{count}</b>{label}</span>)}
          {!preview.diff.changed && <span>与已发布版本一致</span>}</div>
        {preview.preserved > 0 && <p className="kg-muted">文件里缺少 {preview.preserved} 个已发布的知识点，已保留为“已停用”，历史题目与作业证据仍能追溯。</p>}
        {preview.errors.length > 0 && <div className="kg-issue-box"><b>载入后需要先处理 {preview.errors.length} 个问题才能发布</b>
          <ul>{preview.errors.slice(0, 5).map((issue, issueIndex) => <li key={`${issue.code}-${issueIndex}`}>{issue.message}</li>)}</ul>
        </div>}
        {draftChanged && <p className="kg-warning">当前草稿里的改动会被这份文件替换，载入后可以用“撤销”找回。</p>}
      </>}
      {error && <p className="kg-error" role="alert">{error}</p>}
      <footer><button type="button" className="kg-button" onClick={onCancel}>取消</button>
        <button type="button" className="kg-button primary" disabled={!preview} onClick={() => preview && onConfirm(preview.document)}>载入为草稿</button></footer>
    </div>
  </div>;
}
