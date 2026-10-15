// One-off migration helper (kept for review): rewrites hard-coded colours in a stylesheet as
// expressions over the appearance tokens, so every 外观 style recolours the whole page.
//
//   node scripts/tokenize-colors.mjs app/globals.css            # report only
//   node scripts/tokenize-colors.mjs app/globals.css --write --radius        # rewrite in place, scale radii
//   node scripts/tokenize-colors.mjs page.css --write --prefix=studio-       # namespaced exact-colour tokens
//
// Each literal is matched against the classic palette of its context (rules under
// html[data-theme="dark"] use the dark palette, everything else the light one) and replaced by the
// closest `color-mix()` of semantically allowed tokens. CLASSIC includes the approved readability adjustments.
import postcss from "postcss";
import { readFileSync, writeFileSync } from "node:fs";

export const CLASSIC = {
  light: {
    ink: "#24352f", muted: "#61706a", line: "#e4e9e6", page: "#f5f7f4", surface: "#ffffff", "surface-soft": "#eef3f0",
    green: "#2f6b53", "green-soft": "#edf5f0", "accent-strong": "#2f6b53", "on-accent": "#ffffff",
    inverse: "#203d31", "on-inverse": "#ffffff", "shadow-tint": "#1a2a22",
    success: "#2b8257", "success-soft": "#e5f2ea", warn: "#c18429", "warn-soft": "#fff0dc", "warn-strong": "#956227",
    danger: "#a34f39", "danger-soft": "#fff0e8", "danger-strong": "#b83229", "danger-fill": "#a34f39", "on-fill": "#ffffff", amber: "#8b7134", "amber-soft": "#fff8e6",
    info: "#6675c9", "info-soft": "#edf0fb", sky: "#287cad", "sky-soft": "#e8f2f9", teal: "#197b76", "teal-soft": "#eff9f7",
    violet: "#72558d", "violet-soft": "#f2edf7",
  },
  dark: {
    ink: "#eceef5", muted: "#9ba1b3", line: "#303544", page: "#0e1016", surface: "#171a22", "surface-soft": "#1f232d",
    green: "#a8b2ff", "green-soft": "#292e4b", "accent-strong": "#616fbf", "on-accent": "#ffffff",
    inverse: "#203d31", "on-inverse": "#ffffff", "shadow-tint": "#000000",
    success: "#9ac8ae", "success-soft": "#23382e", warn: "#e1ad70", "warn-soft": "#3d2d1e", "warn-strong": "#e8b678",
    danger: "#e4a083", "danger-soft": "#3a241f", "danger-strong": "#ff7b6e", "danger-fill": "#a34f39", "on-fill": "#ffffff", amber: "#dec57d", "amber-soft": "#382f1d",
    info: "#a9c7ff", "info-soft": "#1f2d46", sky: "#88bdf6", "sky-soft": "#1e3140", teal: "#6fcfc4", "teal-soft": "#17302d",
    violet: "#c9a8df", "violet-soft": "#2c2532",
  },
};

const FAMILIES = {
  neutral: ["ink", "muted", "line", "surface-soft", "surface", "page"],
  accent: ["green", "green-soft", "accent-strong"],
  success: ["success", "success-soft"], warn: ["warn", "warn-soft", "warn-strong"], danger: ["danger", "danger-soft", "danger-strong"],
  amber: ["amber", "amber-soft"], info: ["info", "info-soft"], sky: ["sky", "sky-soft"], teal: ["teal", "teal-soft"],
  violet: ["violet", "violet-soft"], inverse: ["inverse"], shadow: ["shadow-tint"],
  // Neutrals that stay dark in every dark-based style (veils in dark rules mix only with these).
  "dark-neutral": ["page", "surface", "surface-soft", "line"],
};
const BASES = ["surface", "page", "ink", "surface-soft"];
const COLOR = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black)\b/g;

export function parseColor(text) {
  const value = text.trim().toLowerCase();
  if (value === "white") return [255, 255, 255, 1]; if (value === "black") return [0, 0, 0, 1];
  if (value.startsWith("#")) {
    let hex = value.slice(1); if (hex.length <= 4) hex = [...hex].map((c) => c + c).join("");
    const n = Number.parseInt(hex.slice(0, 6), 16); return [n >> 16, (n >> 8) & 255, n & 255, hex.length === 8 ? Number.parseInt(hex.slice(6), 16) / 255 : 1];
  }
  const parts = value.match(/[\d.]+%?/g).map((part) => part.endsWith("%") ? Number.parseFloat(part) / 100 : Number.parseFloat(part));
  return [parts[0], parts[1], parts[2], parts[3] ?? 1];
}
const lab = ([r, g, b]) => {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const f = (t) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const x = f((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047), y = f(R * 0.2126 + G * 0.7152 + B * 0.0722), z = f((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
};
export const deltaE = (a, b) => { const p = lab(a), q = lab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
const mix = (a, b, amount) => a.map((value, index) => value * amount + b[index] * (1 - amount));
const hsl = ([r, g, b]) => {
  r /= 255; g /= 255; b /= 255; const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l]; const d = max - min;
  return [(max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60, l > 0.5 ? d / (2 - max - min) : d / (max + min), l];
};

function hueFamilies(rgb, context, selector) {
  const [hue] = hsl(rgb); const primary = hueFamily(rgb, context, selector); if (!primary) return [];
  const near = [hueFamily(rgb, context, selector, hue - 7), hueFamily(rgb, context, selector, hue + 7)].filter(Boolean);
  return [...new Set([primary, ...near])];
}

function hueFamily(rgb, context, selector, shifted) {
  const chroma = (Math.max(...rgb) - Math.min(...rgb)) / 255; const hue = shifted === undefined ? hsl(rgb)[0] : (shifted + 360) % 360;
  if (chroma < 0.025) return null;
  if (hue < 25 || hue >= 340) return "danger";
  if (hue < 40) return "warn";
  if (hue < 65) return "amber";
  // The dark accent is blue, so greens there are always status colours.
  if (hue < 170) return context === "dark" || /correct|mastered|stable|success|passed|\.easy/.test(selector) ? "success" : "accent";
  if (hue < 188) return "teal";
  if (hue < 215) return "sky";
  if (hue < 262) return context === "dark" && /active|checked|\.on\b|selected|current|primary|brand|focus|progress|export/.test(selector) ? "accent" : "info";
  return "violet";
}

// Best `color-mix()` over the allowed tokens, judged in the classic palette of the context.
function fit(rgb, families, palette, bases = BASES) {
  const anchors = [...new Set(families.flatMap((family) => FAMILIES[family]))];
  const tokens = Object.fromEntries(Object.entries(palette).map(([name, hex]) => [name, parseColor(hex)]));
  let best = { error: Infinity };
  const consider = (expression, color, cost) => { const error = deltaE(color, rgb) + cost; if (error < best.error) best = { expression, color, error }; };
  for (const name of anchors) consider(`var(--${name})`, tokens[name], 0);
  for (const name of anchors) for (const base of [...new Set([...bases, ...anchors])]) {
    if (base === name) continue;
    for (let amount = 1; amount < 100; amount += 1) consider(`color-mix(in srgb, var(--${name}) ${amount}%, var(--${base}))`, mix(tokens[name], tokens[base], amount / 100), 0.15);
  }
  if (best.error > 2.5 && anchors.length > 1 && bases.length) {
    for (const name of anchors) for (const base of bases) for (const outer of bases) {
      if (base === name || outer === base) continue;
      for (let inner = 4; inner < 100; inner += 4) for (let amount = 4; amount < 100; amount += 4) {
        consider(`color-mix(in srgb, color-mix(in srgb, var(--${name}) ${inner}%, var(--${base})) ${amount}%, var(--${outer}))`,
          mix(mix(tokens[name], tokens[base], inner / 100), tokens[outer], amount / 100), 0.4);
      }
    }
  }
  return best;
}

const evaluate = (expression, palette) => {
  const tokens = Object.fromEntries(Object.entries(palette).map(([name, hex]) => [name, parseColor(hex)]));
  const walk = (text) => {
    text = text.trim();
    const variable = /^var\(--([\w-]+)\)$/.exec(text); if (variable) return tokens[variable[1]];
    const inner = /^color-mix\(in srgb, (.+) (\d+)%, var\(--([\w-]+)\)\)$/.exec(text);
    if (inner) return mix(walk(inner[1]), tokens[inner[3]], Number(inner[2]) / 100);
    throw new Error(`cannot evaluate ${text}`);
  };
  return walk(expression);
};

export function convertLiteral(literal, { context, selector, prop, ruleBackground, onInverse = false }) {
  const [r, g, b, alpha] = parseColor(literal); const rgb = [r, g, b];
  const palette = CLASSIC[context]; const isWhite = r > 250 && g > 250 && b > 250;
  const hues = hueFamilies(rgb, context, selector);
  // Dark blues sit between the dark info colour and the deeper filled-button blue.
  const related = hues.includes("info") && context === "dark" ? [...hues, "accent"] : hues;
  const [, , lightness] = hsl(rgb);
  const plain = (r === 0 && g === 0 && b === 0) || isWhite;
  const background = /^background/.test(prop);
  const token = (name) => ({ expression: `var(--${name})`, color: parseColor(palette[name]), error: deltaE(rgb, parseColor(palette[name])) });
  const fixed = { expression: literal, core: literal, error: 0, visible: 0, families: ["fixed"] };
  // Pure black/white shadows and veils read the same in every style.
  if ((/shadow/.test(prop) || (alpha < 1 && lightness < 0.25)) && plain && alpha < 1) return fixed;
  let families; let best;
  if (onInverse) {
    // Dark panels that stay dark in every style: their fills follow --inverse, marks on them stay light.
    if (lightness < 0.32) { families = ["inverse", "shadow"]; best = fit(rgb, families, palette, []); }
    else if (isWhite) { families = ["on-inverse"]; best = token("on-inverse"); }
    else return fixed;
  } else if (alpha < 1 && lightness < 0.25) {
    // Dark veils, backdrops and shadows: never mixed with --ink, which turns light in dark styles.
    families = context === "dark" ? ["shadow", "dark-neutral"] : ["shadow", "inverse"];
    best = fit(rgb, families, palette, []);
  } else if (ruleBackground === "danger-fill" && background) { families = ["fill"]; best = token("danger-fill"); }
  else if (ruleBackground === "danger-fill" && isWhite) { families = ["fill"]; best = token("on-fill"); }
  else if (isWhite && !background && ruleBackground === "accent") { families = ["on-accent"]; best = token("on-accent"); }
  // Light-theme primary fills in another green (the studio's teal buttons) take the style's button colour.
  else if (context === "light" && ruleBackground === "accent" && (background || /border/.test(prop)) && hsl(rgb)[1] > 0.35 && lightness < 0.45 && hues.some((family) => ["accent", "teal", "success"].includes(family))) { families = ["accent"]; best = token("accent-strong"); }
  // White marks without their own fill sit on a coloured parent (button, panel, photo): keep them white.
  else if (isWhite && !background) { families = ["on-inverse"]; best = token("on-inverse"); }
  else if (background && ruleBackground === "inverse") { families = ["inverse", "shadow"]; best = fit(rgb, families, palette, []); }
  if (!best) { families = [...related, "neutral"]; best = fit(rgb, families, palette); }
  // What the eye sees: translucent colours are judged composited over the surface.
  const backdrop = parseColor(palette.surface);
  const visible = alpha < 1 ? deltaE(mix(best.color, backdrop, alpha), mix(rgb, backdrop, alpha)) : deltaE(best.color, rgb);
  const expression = alpha < 1 ? wrapAlpha(best.expression, alpha) : best.expression;
  return { expression, core: best.expression, error: best.error, visible, families };
}

const wrapAlpha = (expression, alpha) => `color-mix(in srgb, ${expression} ${Math.round(alpha * 100)}%, transparent)`;
const hex6 = ([r, g, b]) => [r, g, b].map((value) => Math.round(value).toString(16).padStart(2, "0")).join("");

// Background family of a rule, used to pick the text colour that belongs on it.
function backgroundFamily(rule, context) {
  const background = rule.nodes?.find((node) => node.type === "decl" && /^background(-color)?$/.test(node.prop));
  if (!background) return null;
  if (/var\(--green\)|var\(--accent-strong\)/.test(background.value)) return "accent";
  const literal = background.value.match(COLOR)?.[0]; if (!literal) return null;
  const rgb = parseColor(literal).slice(0, 3); const [, , lightness] = hsl(rgb);
  if (context === "dark" && /6675c9|6978cb/i.test(literal)) return "accent";
  if (deltaE(rgb, parseColor(CLASSIC[context].green)) < 8 || deltaE(rgb, parseColor(CLASSIC[context]["accent-strong"])) < 8) return "accent";
  const whiteText = rule.nodes?.some((node) => node.type === "decl" && /^color$/.test(node.prop) && /^(white|#fff|#ffffff)$/i.test(node.value.trim()));
  if (whiteText && hueFamily(rgb, context, rule.selector) === "danger") return "danger-fill";
  // A saturated green/teal fill under white text is a primary button in the accent's role.
  const [hue, saturation] = hsl(rgb);
  if (whiteText && !INVERSE_SCOPE.test(rule.selector) && hue >= 140 && hue < 190 && saturation > 0.35 && lightness < 0.45) return "accent";
  if (context === "light" && lightness < 0.32) return "inverse";
  const family = hueFamily(rgb, context, rule.selector);
  return family === "accent" ? "accent" : null;
}

// Photographic and camera surfaces keep fixed colours in every style.
const FIXED_RULES = /camera-sheet|scanner-editor-stage|grade-marker|crop-selection|graded-page/;
const IMAGE_BACKDROP = /img|diagram|photo|figure|graded|crop|picture|thumb/;
// Dark panels (selection dock, recognising banner, toast, photo captions) stay dark in every style;
// their own backgrounds follow --inverse and what sits on them keeps its light colours.
const INVERSE_SCOPE = /paper-dock|\.dock-|recognizing|\.toast|figcaption|manual-image-grid figure button/;
const darkSelector = (selector) => /data-theme=["']?dark/.test(selector);
const baseSelectors = (selector) => selector.split(",").map((part) => part.replace(/html\[data-theme=["']?dark["']?\]\s*/g, "").replace(/\s+/g, " ").trim()).filter(Boolean);

// Colours no token mix reproduces within this ΔE get an exact per-colour token in the classic styles.
export const EXACT_THRESHOLD = 2.5;

export function tokenizeStylesheet(css, options = {}) {
  const root = postcss.parse(css); const report = [];
  const exact = new Map();
  // Accent fills carrying white text use --accent-strong, the fill shade of the accent: identical in
  // classic light, the deeper button blue in dark styles (where --green is a light text colour).
  root.walkRules((rule) => {
    const decls = (rule.nodes ?? []).filter((node) => node.type === "decl");
    const filled = decls.some((node) => /^background(-color)?$/.test(node.prop) && node.value.trim() === "var(--green)");
    const whiteText = decls.some((node) => node.prop === "color" && /^(white|#fff|#ffffff)$/i.test(node.value.trim()));
    if (!filled || !(whiteText || /\.check\.on/.test(rule.selector))) return;
    for (const node of decls) if (/^(background(-color)?|border-color)$/.test(node.prop) && node.value.trim() === "var(--green)") node.value = "var(--accent-strong)";
  });
  const darkCovered = new Set();
  root.walkRules((rule) => { if (darkSelector(rule.selector)) for (const base of baseSelectors(rule.selector)) for (const node of rule.nodes ?? []) if (node.type === "decl") darkCovered.add(`${base}|${node.prop}`); });
  const backgrounds = new Map();
  root.walkRules((rule) => backgrounds.set(rule, backgroundFamily(rule, darkSelector(rule.selector) || options.context === "dark" ? "dark" : "light")));
  root.walkDecls((decl) => {
    if (decl.prop.startsWith("--") || !COLOR.test(decl.value)) { COLOR.lastIndex = 0; return; }
    COLOR.lastIndex = 0;
    const rule = decl.parent; if (rule.type !== "rule") return;
    if (options.skip?.(rule.selector)) return;
    if (FIXED_RULES.test(rule.selector)) return;
    const context = darkSelector(rule.selector) || options.context === "dark" ? "dark" : "light";
    const ruleBackground = backgrounds.get(rule);
    decl.value = decl.value.replace(COLOR, (literal, offset, whole) => {
      // `var(--token, #fallback)`: the fallback only applies when the token is missing; leave it.
      if (/var\(--[\w-]+,\s*$/.test(whole.slice(0, offset))) return literal;
      const [r, g, b, alpha] = parseColor(literal);
      if (/^background/.test(decl.prop) && r > 250 && g > 250 && b > 250 && IMAGE_BACKDROP.test(rule.selector)) return literal;
      const onInverse = context === "light" && INVERSE_SCOPE.test(rule.selector);
      const converted = convertLiteral(literal, { context, selector: rule.selector, prop: decl.prop, ruleBackground, onInverse });
      let darkShift = null;
      if (converted.families[0] !== "fixed" && context === "light" && !baseSelectors(rule.selector).some((base) => darkCovered.has(`${base}|${decl.prop}`))) {
        darkShift = deltaE(evaluate(converted.core, CLASSIC.dark), [r, g, b]);
      }
      let { expression } = converted;
      if (converted.visible > EXACT_THRESHOLD) {
        // Keep the classic colour exact; the other styles use the semantic mix.
        const key = `${context}|${hex6([r, g, b])}|${converted.core}`;
        if (!exact.has(key)) {
          const base = `--${options.prefix ?? ""}${context === "dark" ? "cd" : "c"}-${hex6([r, g, b])}`;
          const taken = [...exact.values()].filter((item) => item.name === base || item.name.startsWith(`${base}-`)).length;
          exact.set(key, { name: taken ? `${base}-${taken + 1}` : base, context, value: `#${hex6([r, g, b])}`, derived: converted.core });
        }
        const name = exact.get(key).name;
        expression = alpha < 1 ? wrapAlpha(`var(${name})`, alpha) : `var(${name})`;
      }
      report.push({ literal, selector: rule.selector.replace(/\s+/g, " ").slice(0, 90), prop: decl.prop, context, ...converted, expression, darkShift });
      return expression;
    });
  });
  return { css: root.toString(), report, exact: [...exact.values()] };
}

// Corner radii scale with the style (--radius-scale: classic 1, cute rounder, tech sharper).
// Pills (≥ 99px), zero and percentage radii are left alone.
export function scaleRadii(css) {
  const root = postcss.parse(css); let count = 0;
  root.walkDecls(/^border(-[a-z]+)*-radius$/, (decl) => {
    if (decl.value.includes("--radius-scale")) return;
    decl.value = decl.value.replace(/(?<![\w.-])(\d*\.?\d+)px\b/g, (match, size) => {
      const value = Number(size); if (!value || value >= 99) return match;
      count += 1; return `calc(${size}px*var(--radius-scale))`;
    });
  });
  return { css: root.toString(), count };
}

// Token block for the exact classic colours: literal in the classic style, derived everywhere else.
export function exactTokenBlock(exact) {
  if (!exact.length) return "";
  const lines = (items, value) => items.map((item) => `  ${item.name}:${value(item)};`).join("\n");
  const light = exact.filter((item) => item.context === "light"); const dark = exact.filter((item) => item.context === "dark");
  const blocks = [];
  if (light.length) blocks.push(`:root {\n${lines(light, (item) => item.value)}\n}`, `html[data-theme="dark"],html[data-style]:not([data-style="classic"]) {\n${lines(light, (item) => item.derived)}\n}`);
  if (dark.length) blocks.push(`html[data-theme="dark"] {\n${lines(dark, (item) => item.value)}\n}`, `html[data-theme="dark"][data-style]:not([data-style="classic"]) {\n${lines(dark, (item) => item.derived)}\n}`);
  return blocks.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [file] = process.argv.slice(2); const write = process.argv.includes("--write");
  const prefix = process.argv.find((arg) => arg.startsWith("--prefix="))?.slice(9);
  const { css, report, exact } = tokenizeStylesheet(readFileSync(file, "utf8"), { context: process.argv.includes("--dark") ? "dark" : "light", prefix });
  const errors = report.map((row) => row.visible).sort((a, b) => a - b);
  const pct = (p) => errors[Math.floor((errors.length - 1) * p)]?.toFixed(2);
  console.log(`${report.length} colours · visible ΔE median ${pct(0.5)} · p90 ${pct(0.9)} · p99 ${pct(0.99)} · max ${pct(1)} · ${exact.length} exact tokens`);
  for (const row of report.filter((item) => item.visible > EXACT_THRESHOLD).sort((a, b) => b.visible - a.visible).slice(0, 25)) console.log(`  exact ΔE ${row.visible.toFixed(1).padStart(5)}  ${row.literal.padEnd(22)} ${row.context} ${row.prop} @ ${row.selector}  →  ${row.core}`);
  const shifted = report.filter((row) => row.darkShift !== null && row.darkShift > 6);
  console.log(`\n${shifted.length} light-only colours would look different in classic dark (ΔE > 6):`);
  for (const row of shifted.sort((a, b) => b.darkShift - a.darkShift).slice(0, 60)) console.log(`  dark ΔE ${row.darkShift.toFixed(0).padStart(3)}  ${row.literal.padEnd(22)} ${row.prop} @ ${row.selector}`);
  if (process.argv.includes("--exact")) console.log(`\n${exactTokenBlock(exact)}`);
  const radii = process.argv.includes("--radius") ? scaleRadii(css) : { css, count: 0 };
  if (radii.count) console.log(`\nscaled ${radii.count} corner radii`);
  if (write) {
    // The exact-colour tokens go between the markers in the token section (added by hand once).
    const marker = /\/\* exact-classic:start \*\/[\s\S]*?\/\* exact-classic:end \*\//;
    let output = radii.css;
    if (exact.length) {
      if (!marker.test(output)) throw new Error("add /* exact-classic:start */ /* exact-classic:end */ to the token section first");
      output = output.replace(marker, `/* exact-classic:start */\n${exactTokenBlock(exact)}\n/* exact-classic:end */`);
    }
    writeFileSync(file, output);
    console.log(`\nrewrote ${file}`);
  }
}
