// 外观设置：基调（html[data-theme]：light/dark）+ 风格（html[data-style]）。颜色定义在 app/globals.css 顶部。
export type AppearanceId = "light" | "dark" | "dopamine" | "tech" | "cute" | "eyecare";
export type AppearanceTheme = "light" | "dark";

export type Appearance = {
  id: AppearanceId;
  theme: AppearanceTheme;
  style: "classic" | "dopamine" | "tech" | "cute" | "eyecare";
  label: { zh: string; en: string };
  // 卡片预览：页面底色、卡片底色、主按钮色、两个点缀色（前三个与 globals.css 的 --page/--surface/--accent-strong 一致）
  swatches: [string, string, string, string, string];
};

export const APPEARANCES: readonly Appearance[] = [
  { id: "light", theme: "light", style: "classic", label: { zh: "经典浅色", en: "Classic light" }, swatches: ["#f5f7f4", "#ffffff", "#2f6b53", "#c18429", "#6675c9"] },
  { id: "dark", theme: "dark", style: "classic", label: { zh: "经典深色", en: "Classic dark" }, swatches: ["#0e1016", "#171a22", "#616fbf", "#a8b2ff", "#e1ad70"] },
  { id: "dopamine", theme: "light", style: "dopamine", label: { zh: "多巴胺", en: "Dopamine" }, swatches: ["#fff8ef", "#ffffff", "#e11d63", "#ff8a00", "#3f5bff"] },
  { id: "tech", theme: "dark", style: "tech", label: { zh: "科技风", en: "Tech" }, swatches: ["#060a13", "#0c1322", "#22d3ee", "#8b9dff", "#3ee6a0"] },
  { id: "cute", theme: "light", style: "cute", label: { zh: "可爱风", en: "Cute" }, swatches: ["#fff6f9", "#ffffff", "#c93a76", "#9a5ed3", "#f0a03c"] },
  { id: "eyecare", theme: "light", style: "eyecare", label: { zh: "护眼", en: "Eye care" }, swatches: ["#f3ecda", "#faf5e8", "#4c7448", "#b27a2c", "#3d6f8c"] },
];

export const APPEARANCE_KEY = "mitty-appearance";
// 旧版只存浅色/深色；继续同步写入，旧数据（dark）直接迁移为经典深色。
export const LEGACY_THEME_KEY = "mitty-color-theme";

export function findAppearance(id: string | null | undefined): Appearance | undefined {
  return APPEARANCES.find((item) => item.id === id);
}

export function resolveAppearance(saved: string | null, legacyTheme: string | null, prefersDark: boolean): AppearanceId {
  if (findAppearance(saved)) return saved as AppearanceId;
  if (legacyTheme === "light" || legacyTheme === "dark") return legacyTheme;
  return prefersDark ? "dark" : "light";
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
    return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
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
    const id = table[saved] ? saved : legacy === "light" || legacy === "dark" ? legacy
      : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    root.dataset.theme = table[id][0];
    root.dataset.style = table[id][1];
  } catch {
    root.dataset.theme = "light";
    root.dataset.style = "classic";
  }
})();`;
