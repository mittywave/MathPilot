"use client";
import { useState } from "react";
import type { TypesetRecord } from "../../../lib/types";

// 历史记录: the materials this teacher has typeset, last edited first. A row reopens the material as it was left.
const EDITION_LABELS: Record<string, string> = { none: "学生版", end: "附答案", each: "教师版" };

function sameDay(a: Date, b: Date) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }

// 今天 14:32 / 昨天 09:10 / 10月9日 16:05 / 2025年3月2日 16:05
export function historyTime(time: number, now: number) {
  const date = new Date(time); const today = new Date(now); const yesterday = new Date(now - 86_400_000);
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  if (sameDay(date, today)) return `今天 ${clock}`;
  if (sameDay(date, yesterday)) return `昨天 ${clock}`;
  const day = `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.getFullYear() === today.getFullYear() ? `${day} ${clock}` : `${date.getFullYear()}年${day} ${clock}`;
}

export function TypesetHistory({ records, current, now, busy, onOpen, onDelete, onClose }: {
  records: TypesetRecord[]; current: string | null; now: number; busy: boolean;
  onOpen: (record: TypesetRecord) => void; onDelete: (record: TypesetRecord) => void; onClose?: () => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  return <div className="typeset-history">
    <header>
      <b>历史记录</b><small>{records.length ? `${records.length} 份，最近编辑的在前` : "排过的资料会记在这里"}</small>
      {onClose && <button type="button" className="secondary" onClick={onClose}>返回预览</button>}
    </header>
    {records.length ? <ul>{records.map((record) => <li key={record.id} className={record.id === current ? "current" : ""}>
      <button type="button" className="typeset-history-open" disabled={busy} onClick={() => onOpen(record)}>
        <span className="typeset-history-name"><b>{record.title}</b>{record.id === current && <em>正在编辑</em>}</span>
        <small>{record.fileName} · {record.questionCount} 道题 · {EDITION_LABELS[record.settings.answers ?? "none"] ?? "学生版"}</small>
      </button>
      <span className="typeset-history-time"><b>{historyTime(record.updatedAt, now)} 编辑</b><small>{historyTime(record.createdAt, now)} 首次排版</small></span>
      <button type="button" className={`typeset-history-delete${confirming === record.id ? " confirming" : ""}`} disabled={busy}
        onBlur={() => setConfirming(null)} onClick={() => { if (confirming === record.id) { setConfirming(null); onDelete(record); } else setConfirming(record.id); }}>
        {confirming === record.id ? "确认删除" : "删除"}
      </button>
    </li>)}</ul> : <p className="typeset-history-empty">选择一份 Word 练习开始排版，排过的资料会按时间列在这里，点开就能接着调整。</p>}
  </div>;
}
