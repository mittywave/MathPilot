"use client";

import { useEffect, useState } from "react";
import { type AppearanceId, readAppearance, saveAppearance } from "../../lib/appearance";
import { MoonIcon, SunIcon } from "./ThemeIcons";

// 顶栏外观按钮：直接在浅色和深色之间切换，样子和介绍页顶栏的切换按钮一样。
// 两个图标都渲染，由 html[data-theme] 决定显示哪个，首屏脚本设好基调后图标就对，不会先闪一下月亮。
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
      <MoonIcon className="theme-moon" /><SunIcon className="theme-sun" />
    </button>
  </div>;
}
