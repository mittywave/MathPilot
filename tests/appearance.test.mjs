import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadSource } from "./load-source.mjs";
import { CLASSIC } from "../scripts/tokenize-colors.mjs";

const { APPEARANCES, APPEARANCE_KEY, LEGACY_THEME_KEY, appearanceBootstrapScript, resolveAppearance, saveAppearance } = await loadSource("lib/appearance.ts");
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

function fakeBrowser({ stored = {}, prefersDark = false, storageThrows = false } = {}) {
  const data = { ...stored };
  const storage = {
    getItem: (key) => { if (storageThrows) throw new Error("blocked"); return key in data ? data[key] : null; },
    setItem: (key, value) => { if (storageThrows) throw new Error("blocked"); data[key] = String(value); },
  };
  const documentElement = { dataset: {} };
  const window = { localStorage: storage, matchMedia: () => ({ matches: prefersDark }) };
  return { window, document: { documentElement }, data, dataset: documentElement.dataset };
}

function runBootstrap(options) {
  const browser = fakeBrowser(options);
  new Function("window", "document", appearanceBootstrapScript)(browser.window, browser.document);
  return browser.dataset;
}

test("a saved appearance wins; the old light/dark setting migrates; otherwise the system preference decides", () => {
  assert.equal(resolveAppearance("tech", "light", false), "tech");
  assert.equal(resolveAppearance(null, "dark", false), "dark");
  assert.equal(resolveAppearance("unknown-style", "light", true), "light");
  assert.equal(resolveAppearance(null, null, true), "dark");
  assert.equal(resolveAppearance(null, null, false), "light");
});

test("the first-paint script sets both attributes before the page draws", () => {
  assert.deepEqual({ ...runBootstrap({ stored: { [APPEARANCE_KEY]: "dopamine" } }) }, { theme: "light", style: "dopamine" });
  assert.deepEqual({ ...runBootstrap({ stored: { [APPEARANCE_KEY]: "tech" } }) }, { theme: "dark", style: "tech" });
  assert.deepEqual({ ...runBootstrap({ stored: { [LEGACY_THEME_KEY]: "dark" } }) }, { theme: "dark", style: "classic" }, "old dark setting becomes classic dark");
  assert.deepEqual({ ...runBootstrap({ prefersDark: true }) }, { theme: "dark", style: "classic" });
  assert.deepEqual({ ...runBootstrap({ storageThrows: true }) }, { theme: "light", style: "classic" });
  for (const item of APPEARANCES) assert.deepEqual({ ...runBootstrap({ stored: { [APPEARANCE_KEY]: item.id } }) }, { theme: item.theme, style: item.style });
});

test("choosing an appearance applies it and remembers it under both keys", () => {
  const browser = fakeBrowser({ stored: { [LEGACY_THEME_KEY]: "light" } });
  globalThis.window = browser.window; globalThis.document = browser.document;
  try {
    saveAppearance("cute");
    assert.deepEqual({ ...browser.dataset }, { theme: "light", style: "cute" });
    assert.equal(browser.data[APPEARANCE_KEY], "cute");
    assert.equal(browser.data[LEGACY_THEME_KEY], "light", "pages that only know light/dark keep working");
    saveAppearance("tech");
    assert.equal(browser.data[LEGACY_THEME_KEY], "dark");
  } finally { delete globalThis.window; delete globalThis.document; }
});

// Token blocks at the top of globals.css.
function tokenBlock(selector) {
  const start = css.indexOf(`${selector} {`); assert.ok(start >= 0, `${selector} block exists`);
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):([^;]+);/g)].map(([, name, value]) => [name, value.trim().toLowerCase()]));
}
const long = (hex) => hex.replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/, "#$1$1$2$2$3$3");
const light = tokenBlock(":root"); const dark = tokenBlock('html[data-theme="dark"]');
const styles = Object.fromEntries(APPEARANCES.filter((item) => item.style !== "classic").map((item) => [item.id, { ...(item.theme === "dark" ? dark : light), ...tokenBlock(`html[data-style="${item.style}"]`) }]));

test("the classic styles keep their exact colours", () => {
  for (const [name, value] of Object.entries(CLASSIC.light)) assert.equal(long(light[name]), value, `light --${name}`);
  for (const [name, value] of Object.entries(CLASSIC.dark)) assert.equal(long(dark[name]), value, `dark --${name}`);
});

test("every style sets every colour token", () => {
  const names = Object.keys(CLASSIC.light);
  for (const item of APPEARANCES.filter((entry) => entry.style !== "classic")) {
    const own = tokenBlock(`html[data-style="${item.style}"]`);
    assert.deepEqual(names.filter((name) => !own[name]), [], `${item.id} defines all tokens`);
  }
});

const luminance = (hex) => {
  const n = Number.parseInt(long(hex).slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255].map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
    .reduce((sum, c, index) => sum + c * [0.2126, 0.7152, 0.0722][index], 0);
};
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test("text, buttons and status colours stay readable in every appearance", () => {
  const pairs = [
    ["ink", "page", 7], ["ink", "surface", 7], ["ink", "surface-soft", 6], ["muted", "surface", 4.5], ["muted", "page", 4.5], ["muted", "surface-soft", 4.5],
    ["green", "surface", 4.5], ["green", "green-soft", 4.5], ["on-accent", "accent-strong", 4.5], ["on-inverse", "inverse", 4.5], ["on-fill", "danger-fill", 4.5],
    ["warn-strong", "surface", 4.5], ["warn-strong", "warn-soft", 4.5], ["danger-strong", "surface", 4.5], ["danger-strong", "danger-soft", 4.5], ["success", "surface", 3], ["danger", "surface", 3.5], ["amber", "surface", 3.5],
    ["info", "surface", 3.5], ["sky", "surface", 3.5], ["teal", "surface", 3.5], ["violet", "surface", 3.5],
    ["success", "success-soft", 3], ["danger", "danger-soft", 3.2], ["amber", "amber-soft", 3.2], ["info", "info-soft", 3.2], ["violet", "violet-soft", 3.2],
  ];
  for (const [id, palette] of Object.entries({ light, dark, ...styles })) {
    const failures = pairs.filter(([fg, bg, min]) => contrast(palette[fg], palette[bg]) < min).map(([fg, bg, min]) => `${fg}/${bg} ${contrast(palette[fg], palette[bg]).toFixed(2)} < ${min}`);
    assert.deepEqual(failures, [], id);
  }
});

test("picker previews show each style's real page, card and button colours", () => {
  for (const item of APPEARANCES) {
    const palette = item.style === "classic" ? (item.theme === "dark" ? dark : light) : styles[item.id];
    assert.deepEqual(item.swatches.slice(0, 3).map(long), [palette.page, palette.surface, palette["accent-strong"]].map(long), item.id);
  }
});

test("every colour variable the stylesheet uses is defined", () => {
  const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map(([, name]) => name));
  const used = new Set([...css.matchAll(/var\((--[\w-]+)\)/g)].map(([, name]) => name));
  const preview = /^--preview-/; // set inline by the picker
  assert.deepEqual([...used].filter((name) => !defined.has(name) && !preview.test(name)), []);
});
