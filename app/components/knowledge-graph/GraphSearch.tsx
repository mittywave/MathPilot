"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { KnowledgeGraphIndex } from "../../../lib/knowledge-graph-core.mjs";
import { LEVEL_LABEL, searchNodes, stageName } from "./graph-model";

type Props = {
  index: KnowledgeGraphIndex;
  colorOf: (key: string) => string;
  onPick: (key: string) => void;
  onPreview: (keys: string[]) => void;
};

export default function GraphSearch({ index, colorOf, onPick, onPreview }: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => searchNodes(index, query, 8), [index, query]);
  const showing = open && Boolean(query.trim());
  const previewRef = useRef(onPreview);
  useEffect(() => { previewRef.current = onPreview; }, [onPreview]);
  useEffect(() => { previewRef.current(showing ? results.map((node) => node.key) : []); }, [results, showing]);

  function choose(key: string) {
    onPick(key); setQuery(""); setActive(0); setOpen(false); inputRef.current?.blur();
  }

  return <div className="kg-search">
    <span aria-hidden="true">⌕</span>
    <input ref={inputRef} value={query} placeholder="搜索知识点，如：配方法" aria-label="搜索知识点" role="combobox" aria-autocomplete="list"
      aria-expanded={showing} aria-controls="kg-search-results" aria-activedescendant={showing && results[active] ? `kg-search-${active}` : undefined}
      onChange={(event) => { setQuery(event.target.value); setActive(0); setOpen(true); }}
      onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") { event.preventDefault(); setActive((value) => Math.min(results.length - 1, value + 1)); }
        else if (event.key === "ArrowUp") { event.preventDefault(); setActive((value) => Math.max(0, value - 1)); }
        else if (event.key === "Enter" && results[active]) { event.preventDefault(); choose(results[active].key); }
        else if (event.key === "Escape") { setQuery(""); inputRef.current?.blur(); }
      }} />
    {showing && <ul id="kg-search-results" className="kg-search-results" role="listbox" aria-label="搜索结果">
      {results.map((node, position) => {
        const parent = node.level === "point" ? index.nodeByKey.get(node.parentKey ?? "") : undefined;
        return <li key={node.key} role="presentation">
          <button type="button" id={`kg-search-${position}`} role="option" aria-selected={position === active} tabIndex={-1} className={position === active ? "active" : ""}
            onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setActive(position)} onClick={() => choose(node.key)}>
            <i style={{ background: colorOf(node.key) }} aria-hidden="true" />
            <span>{node.label}</span>
            <small>{parent ? parent.label : LEVEL_LABEL[node.level]} · {stageName(index, node.stage).replace(/年级$/, "")}</small>
          </button>
        </li>;
      })}
      {!results.length && <li className="kg-search-empty" role="presentation">没有找到“{query.trim()}”</li>}
    </ul>}
  </div>;
}
