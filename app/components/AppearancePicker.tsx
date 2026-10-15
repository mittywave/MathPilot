"use client";

import { useEffect, useState } from "react";
import { type AppearanceId, readAppearance, saveAppearance } from "../../lib/appearance";

// 顶栏外观按钮：直接在经典浅色和科技风之间切换。
export function AppearancePicker({ label, locale = "zh" }: { label: string; locale?: "zh" | "en" }) {
  const [current, setCurrent] = useState<AppearanceId>("light");

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setCurrent(readAppearance()));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  function toggle() {
    const id = readAppearance() === "tech" ? "light" : "tech";
    saveAppearance(id);
    setCurrent(id);
  }

  const title = locale === "en" ? (current === "tech" ? "Switch to light mode" : "Switch to dark mode") : (current === "tech" ? "切换到浅色" : "切换到深色");

  return <div className="appearance-picker">
    <button type="button" className="appearance-toggle" aria-label={label} title={title} aria-pressed={current === "tech"} onClick={toggle}>
      <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10 3a7 7 0 0 1 0 14Z" fill="currentColor" /></svg>
    </button>
  </div>;
}
