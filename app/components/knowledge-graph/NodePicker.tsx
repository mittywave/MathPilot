"use client";

import { useEffect, useMemo, useRef, useState } from "react";

export type PickerOption = { key: string; label: string; hint: string; search: string; disabledReason?: string };

type Props = { options: PickerOption[]; placeholder: string; onPick: (key: string) => void; onCancel: () => void };

export default function NodePicker({ options, placeholder, onPick, onCancel }: Props) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase().replace(/\s+/g, "");
    return (needle ? options.filter((option) => option.search.includes(needle)) : options).slice(0, 12);
  }, [options, query]);
  const firstEnabled = filtered.find((option) => !option.disabledReason);
  return <div className="kg-picker">
    <input ref={inputRef} value={query} placeholder={placeholder} aria-label={placeholder} onChange={(event) => setQuery(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Escape") onCancel();
        if (event.key === "Enter" && firstEnabled) { event.preventDefault(); onPick(firstEnabled.key); }
      }} />
    <ul role="listbox" aria-label="候选知识点">
      {filtered.map((option) => <li key={option.key}>
        <button type="button" role="option" aria-selected="false" disabled={Boolean(option.disabledReason)} onClick={() => onPick(option.key)}>
          <b>{option.label}</b><small>{option.disabledReason || option.hint}</small>
        </button>
      </li>)}
      {!filtered.length && <li className="kg-picker-empty">没有匹配的知识点</li>}
    </ul>
    <button type="button" className="kg-link-button" onClick={onCancel}>取消</button>
  </div>;
}
