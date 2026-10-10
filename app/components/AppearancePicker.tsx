"use client";

import { type CSSProperties, useEffect, useRef, useState } from "react";
import { APPEARANCES, type AppearanceId, readAppearance, saveAppearance } from "../../lib/appearance";

// 首页顶栏的“外观”入口：点开是 6 张风格卡片，选中立即生效（弹层保持打开，方便对比），Esc 或点外部关闭。
export function AppearancePicker({ label, locale = "zh" }: { label: string; locale?: "zh" | "en" }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<AppearanceId>("light");
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setCurrent(readAppearance()));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!open) return;
    rootRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const outside = (event: Event) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      toggleRef.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  function choose(id: AppearanceId) {
    saveAppearance(id);
    setCurrent(id);
  }

  return <div ref={rootRef} className="appearance-picker">
    <button ref={toggleRef} className="appearance-toggle" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen(!open)}>
      <span className="appearance-dot" aria-hidden="true" />{label}
    </button>
    {open && <div className="appearance-panel" role="radiogroup" aria-label={label}>
      {APPEARANCES.map((item) => {
        const [page, surface, accent, first, second] = item.swatches;
        const preview = { "--preview-page": page, "--preview-surface": surface, "--preview-accent": accent, "--preview-first": first, "--preview-second": second } as CSSProperties;
        return <button key={item.id} className="appearance-option" role="radio" aria-checked={item.id === current} onClick={() => choose(item.id)}>
          <span className="appearance-preview" style={preview} aria-hidden="true"><i /><i /><i /><i /></span>
          <b>{item.label[locale]}</b>
        </button>;
      })}
    </div>}
  </div>;
}
