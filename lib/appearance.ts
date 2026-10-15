// 外观设置：基调（html[data-theme]：light/dark）+ 风格（html[data-style]）。颜色定义在 app/globals.css 顶部。
export type AppearanceId = "light" | "tech";
export type AppearanceTheme = "light" | "dark";

export type Appearance = {
  id: AppearanceId;
  theme: AppearanceTheme;
  style: "classic" | "tech";
};

export const APPEARANCES: readonly Appearance[] = [
  { id: "light", theme: "light", style: "classic" },
  { id: "tech", theme: "dark", style: "tech" },
];

export const APPEARANCE_KEY = "mitty-appearance";
// 继续同步旧版浅色/深色设置；原经典深色转为科技风，已移除的浅色风格转为经典浅色。
export const LEGACY_THEME_KEY = "mitty-color-theme";

export function findAppearance(id: string | null | undefined): Appearance | undefined {
  return APPEARANCES.find((item) => item.id === id);
}

export function resolveAppearance(saved: string | null, legacyTheme: string | null, prefersDark: boolean): AppearanceId {
  if (findAppearance(saved)) return saved as AppearanceId;
  if (saved === "dark") return "tech";
  if (saved === "dopamine" || saved === "cute" || saved === "eyecare") return "light";
  if (legacyTheme === "light" || legacyTheme === "dark") return legacyTheme === "dark" ? "tech" : "light";
  return prefersDark ? "tech" : "light";
}

export function applyAppearance(id: AppearanceId, root: HTMLElement = document.documentElement) {
  const appearance = findAppearance(id) ?? APPEARANCES[0];
  root.dataset.theme = appearance.theme;
  root.dataset.style = appearance.style;
}

export function readAppearance(): AppearanceId {
  try {
    return resolveAppearance(window.localStorage.getItem(APPEARANCE_KEY), window.localStorage.getItem(LEGACY_THEME_KEY), window.matchMedia("(prefers-color-scheme: dark)").matches);
  } catch {
    return document.documentElement.dataset.theme === "dark" ? "tech" : "light";
  }
}

export function saveAppearance(id: AppearanceId) {
  const appearance = findAppearance(id) ?? APPEARANCES[0];
  applyAppearance(appearance.id);
  try {
    window.localStorage.setItem(APPEARANCE_KEY, appearance.id);
    window.localStorage.setItem(LEGACY_THEME_KEY, appearance.theme);
  } catch { /* 浏览器禁用本地存储时仍保留本次切换 */ }
}

// 首屏脚本：在绘制前设置两个属性，切换后刷新不闪烁。与 resolveAppearance 同一套规则。
const bootstrapTable = Object.fromEntries(APPEARANCES.map((item) => [item.id, [item.theme, item.style]]));
export const appearanceBootstrapScript = `(() => {
  const table = ${JSON.stringify(bootstrapTable)};
  const root = document.documentElement;
  try {
    const saved = window.localStorage.getItem(${JSON.stringify(APPEARANCE_KEY)});
    const legacy = window.localStorage.getItem(${JSON.stringify(LEGACY_THEME_KEY)});
    const id = Object.hasOwn(table, saved) ? saved : saved === "dark" ? "tech"
      : saved === "dopamine" || saved === "cute" || saved === "eyecare" ? "light"
      : legacy === "dark" ? "tech" : legacy === "light" ? "light"
      : window.matchMedia("(prefers-color-scheme: dark)").matches ? "tech" : "light";
    root.dataset.theme = table[id][0];
    root.dataset.style = table[id][1];
  } catch {
    root.dataset.theme = "light";
    root.dataset.style = "classic";
  }
})();`;
