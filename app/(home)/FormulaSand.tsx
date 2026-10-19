"use client";
import { useEffect, useRef, type RefObject } from "react";
import katex from "katex";
import { LiquidEngine, type EngineOptions, type Rect, type SculptureMorph, type SculpturePiece, type SculptureShape } from "../components/LiquidSculptureHero";

// Behind the login window: the formulas that changed the world (Ian Stewart's seventeen equations and a few more),
// drawn in the metal of the ∞ and made of the same sand by the same engine. They gather out of the dust when the
// window opens, float on their own, and come apart into swirling grains under the cursor, the way the ∞ does: every
// formula is the work of countless people, grain by grain.

type Depth = 0 | 1 | 2; // near, middle, far
// in order of placement: whatever no longer fits on a small screen is left out from the end of its depth
const FORMULAS: { tex: string; depth: Depth }[] = [
  { tex: "E = mc^2", depth: 0 }, // 质能方程
  { tex: "e^{i\\pi} + 1 = 0", depth: 0 }, // 欧拉恒等式
  { tex: "i\\hbar \\frac{\\partial}{\\partial t} \\Psi = \\hat{H} \\Psi", depth: 0 }, // 薛定谔方程
  { tex: "F = G \\frac{m_1 m_2}{r^2}", depth: 0 }, // 万有引力
  { tex: "a^2 + b^2 = c^2", depth: 0 }, // 勾股定理
  { tex: "\\nabla \\times \\mathbf{B} = \\mu_0 \\mathbf{J} + \\mu_0 \\varepsilon_0 \\frac{\\partial \\mathbf{E}}{\\partial t}", depth: 1 }, // 麦克斯韦方程组
  { tex: "\\frac{df}{dt} = \\lim_{h \\to 0} \\frac{f(t + h) - f(t)}{h}", depth: 1 }, // 微积分
  { tex: "\\hat{f}(\\xi) = \\int_{-\\infty}^{\\infty} f(x)\\, e^{-2\\pi i x \\xi}\\, dx", depth: 1 }, // 傅里叶变换
  { tex: "G_{\\mu\\nu} + \\Lambda g_{\\mu\\nu} = \\frac{8\\pi G}{c^4} T_{\\mu\\nu}", depth: 1 }, // 广义相对论场方程
  { tex: "P(A \\mid B) = \\frac{P(B \\mid A)\\, P(A)}{P(B)}", depth: 1 }, // 贝叶斯定理
  { tex: "\\nabla \\cdot \\mathbf{E} = \\frac{\\rho}{\\varepsilon_0}", depth: 1 }, // 高斯定律
  { tex: "\\mathbf{F} = m\\mathbf{a}", depth: 1 }, // 牛顿第二定律
  { tex: "\\frac{\\partial^2 u}{\\partial t^2} = c^2 \\frac{\\partial^2 u}{\\partial x^2}", depth: 1 }, // 波动方程
  { tex: "\\Phi(x) = \\frac{1}{\\sqrt{2\\pi}\\,\\sigma} e^{-\\frac{(x - \\mu)^2}{2\\sigma^2}}", depth: 1 }, // 正态分布
  { tex: "H = -\\sum_i p_i \\log p_i", depth: 1 }, // 信息熵
  { tex: "dS \\geq 0", depth: 1 }, // 热力学第二定律
  { tex: "\\rho \\left( \\frac{\\partial \\mathbf{v}}{\\partial t} + \\mathbf{v} \\cdot \\nabla \\mathbf{v} \\right) = -\\nabla p + \\nabla \\cdot \\mathbf{T} + \\mathbf{f}", depth: 2 }, // 纳维–斯托克斯方程
  { tex: "\\frac{1}{2} \\sigma^2 S^2 \\frac{\\partial^2 V}{\\partial S^2} + rS \\frac{\\partial V}{\\partial S} + \\frac{\\partial V}{\\partial t} - rV = 0", depth: 2 }, // 布莱克–斯科尔斯方程
  { tex: "\\int_a^b f'(x)\\, dx = f(b) - f(a)", depth: 2 }, // 微积分基本定理
  { tex: "\\Delta x\\, \\Delta p \\geq \\frac{\\hbar}{2}", depth: 2 }, // 不确定性原理
  { tex: "(i\\gamma^\\mu \\partial_\\mu - m)\\psi = 0", depth: 2 }, // 狄拉克方程
  { tex: "S = k_B \\ln W", depth: 2 }, // 玻尔兹曼熵
  { tex: "x_{t+1} = k\\, x_t (1 - x_t)", depth: 2 }, // 逻辑斯谛映射
  { tex: "\\log xy = \\log x + \\log y", depth: 2 }, // 对数
  { tex: "V - E + F = 2", depth: 2 }, // 欧拉多面体公式
  { tex: "E = h\\nu", depth: 2 }, // 普朗克关系
  { tex: "i^2 = -1", depth: 2 }, // 虚数单位
  { tex: "\\varphi = \\frac{1 + \\sqrt{5}}{2}", depth: 2 }, // 黄金分割
];

const SIZE = [44, 30, 21]; // font size per depth, px
const FADE = [0, 0.22, 0.44]; // how far each depth recedes into the page
const WANDER = [32, 24, 16]; // how far a formula floats from its place, px
const GAP = 40; // free space kept around every formula, px
const PAD = 4; // room around the ink in a formula's own piece of the picture

// the metal of the ∞ (scripts/intro-infinity.html), top to bottom of a formula: darker than the ribbon on the light
// page so thin strokes still read, the same highlights on the dark one
const METAL = {
  light: { page: "#EBE9E5", stops: ["#6A655C", "#989183", "#BDB7A9", "#8C8579", "#5E5950"] },
  dark: { page: "#111110", stops: ["#A39E94", "#D6D3CA", "#F4F2ED", "#BAB6AA", "#8C877D"] },
};
const STOP_AT = [0, 0.3, 0.46, 0.62, 1];

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toward = (hex: string, page: string, amount: number) => {
  const a = rgb(hex), b = rgb(page);
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * amount)).join(",")})`;
};

function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// What a typeset formula is drawn from: its glyphs (each at its baseline), its rules and its SVG paths (the √), in px
// from the formula's top left.
type Ink =
  | { kind: "text"; ch: string; font: string; x: number; y: number }
  | { kind: "rule"; x: number; y: number; w: number; h: number }
  | { kind: "path"; paths: string[]; x: number; y: number; scaleX: number; scaleY: number; clip: Rect };
type Traced = { ink: Ink[]; box: Rect };

const union = (a: Rect | null, b: Rect): Rect => {
  if (!a) return b;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/** Reads KaTeX's layout back out of the page: where every glyph, rule and path of a formula sits. */
function trace(node: HTMLElement, measure: CanvasRenderingContext2D): Traced {
  const origin = node.getBoundingClientRect();
  const ink: Ink[] = [];
  let box: Rect | null = null;
  const range = document.createRange();
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const content = text.textContent ?? "";
    const style = getComputedStyle(text.parentElement!);
    const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    measure.font = font;
    for (let i = 0; i < content.length; i++) {
      const wide = content.charCodeAt(i) >= 0xd800 && content.charCodeAt(i) < 0xdc00;
      const ch = content.slice(i, i + (wide ? 2 : 1));
      range.setStart(text, i);
      range.setEnd(text, i + ch.length);
      if (wide) i++;
      const at = range.getBoundingClientRect();
      if (!at.width || !ch.trim()) continue;
      // the text box runs from the font's ascent above the baseline to its descent below
      const metrics = measure.measureText(ch);
      const x = at.left - origin.left, y = at.bottom - origin.top - metrics.fontBoundingBoxDescent;
      ink.push({ kind: "text", ch, font, x, y });
      box = union(box, {
        x: x - metrics.actualBoundingBoxLeft, y: y - metrics.actualBoundingBoxAscent,
        w: metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight, h: metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent,
      });
    }
  }
  for (const rule of node.querySelectorAll(".frac-line, .overline-line, .underline-line, .hline, .rule")) {
    const at = rule.getBoundingClientRect();
    if (!at.width || !at.height) continue;
    const r = { x: at.left - origin.left, y: at.top - origin.top, w: at.width, h: at.height };
    ink.push({ kind: "rule", ...r });
    box = union(box, r);
  }
  for (const svg of node.querySelectorAll("svg")) {
    const at = svg.getBoundingClientRect();
    const view = svg.viewBox.baseVal;
    if (!at.width || !at.height || !view?.width || !view.height) continue;
    // KaTeX's paths are as wide as a line and cut back by the box around them
    let clip = { x: at.left, y: at.top, w: at.width, h: at.height };
    for (let parent = svg.parentElement; parent && parent !== node; parent = parent.parentElement) {
      if (getComputedStyle(parent).overflow === "visible") continue;
      const p = parent.getBoundingClientRect();
      const x = Math.max(clip.x, p.left), y = Math.max(clip.y, p.top);
      clip = { x, y, w: Math.min(clip.x + clip.w, p.right) - x, h: Math.min(clip.y + clip.h, p.bottom) - y };
    }
    if (clip.w <= 0 || clip.h <= 0) continue;
    const slice = (svg.getAttribute("preserveAspectRatio") ?? "").includes("slice");
    const scale = (slice ? Math.max : Math.min)(at.width / view.width, at.height / view.height);
    const own = { x: clip.x - origin.left, y: clip.y - origin.top, w: clip.w, h: clip.h };
    ink.push({
      kind: "path", paths: [...svg.querySelectorAll("path")].map((path) => path.getAttribute("d") ?? ""),
      x: at.left - origin.left - view.x * scale, y: at.top - origin.top - view.y * scale, scaleX: scale, scaleY: scale, clip: own,
    });
    box = union(box, own);
  }
  return { ink, box: box ?? { x: 0, y: 0, w: 1, h: 1 } };
}

type Placed = { index: number; x: number; y: number; traced: Traced };

/** Lays the formulas out around the window, as many as fit, spread evenly (best of many random tries). */
function place(traced: Traced[], width: number, height: number, clear: Rect | null): Placed[] {
  const random = seeded(17);
  const placed: Placed[] = [];
  const margin = 28;
  const hits = (a: Rect, b: Rect, gap: number) =>
    a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
  for (const [index, formula] of traced.entries()) {
    const { w, h } = formula.box;
    if (w > width - margin * 2 || h > height - margin * 2) continue;
    let best: Rect | null = null, bestDistance = -1;
    for (let attempt = 0; attempt < 240 && (attempt < 40 || !best); attempt++) {
      const spot = { x: margin + random() * (width - margin * 2 - w), y: margin + random() * (height - margin * 2 - h), w, h };
      if (clear && hits(spot, clear, 0)) continue;
      if (placed.some((other) => hits(spot, { x: other.x, y: other.y, w: other.traced.box.w, h: other.traced.box.h }, GAP))) continue;
      const cx = spot.x + w / 2, cy = spot.y + h / 2;
      const distance = Math.min(Infinity, ...placed.map((other) => Math.hypot(other.x + other.traced.box.w / 2 - cx, other.y + other.traced.box.h / 2 - cy)));
      if (distance > bestDistance) { best = spot; bestDistance = distance; }
    }
    if (best) placed.push({ index, x: best.x, y: best.y, traced: formula });
  }
  return placed;
}

/** Draws the field the engine samples its grains from: every formula in metal, a dusting of loose sand around them. */
function paint(placed: Placed[], width: number, height: number, mode: "light" | "dark", scale: number) {
  const metal = METAL[mode];
  const picture = document.createElement("canvas");
  picture.width = Math.round(width * scale);
  picture.height = Math.round(height * scale);
  const field = picture.getContext("2d", { willReadFrequently: true })!;
  const random = seeded(29);
  for (const { index, x, y, traced } of placed) {
    const { box, ink } = traced;
    const own = document.createElement("canvas");
    own.width = Math.ceil((box.w + PAD * 2) * scale);
    own.height = Math.ceil((box.h + PAD * 2) * scale);
    const pen = own.getContext("2d")!;
    pen.scale(scale, scale);
    pen.translate(PAD - box.x, PAD - box.y);
    pen.fillStyle = "#fff";
    for (const item of ink) {
      if (item.kind === "text") {
        pen.font = item.font;
        pen.fillText(item.ch, item.x, item.y);
      } else if (item.kind === "rule") pen.fillRect(item.x, item.y, item.w, item.h);
      else {
        pen.save();
        pen.beginPath();
        pen.rect(item.clip.x, item.clip.y, item.clip.w, item.clip.h);
        pen.clip();
        pen.translate(item.x, item.y);
        pen.scale(item.scaleX, item.scaleY);
        for (const d of item.paths) pen.fill(new Path2D(d));
        pen.restore();
      }
    }
    // the glyphs take the metal, banded top to bottom like the ribbon, receding with depth
    pen.setTransform(1, 0, 0, 1, 0, 0);
    pen.globalCompositeOperation = "source-in";
    const fade = FADE[FORMULAS[index].depth];
    const band = pen.createLinearGradient(0, 0, own.width * 0.12, own.height);
    metal.stops.forEach((stop, k) => band.addColorStop(STOP_AT[k], toward(stop, metal.page, fade)));
    pen.fillStyle = band;
    pen.fillRect(0, 0, own.width, own.height);
    // grain to grain the metal varies, as the ribbon's does
    const pixels = pen.getImageData(0, 0, own.width, own.height);
    const data = pixels.data;
    for (let i = 0; i < data.length; i += 4) {
      if (!data[i + 3]) continue;
      const f = 0.84 + random() * 0.32;
      data[i] = Math.min(255, data[i] * f);
      data[i + 1] = Math.min(255, data[i + 1] * f);
      data[i + 2] = Math.min(255, data[i + 2] * f);
    }
    pen.putImageData(pixels, 0, 0);
    field.drawImage(own, Math.round((x - PAD) * scale), Math.round((y - PAD) * scale));
  }
  // loose sand all over the page, the faintest metal
  for (let k = 0, count = Math.round((width * height) / 1100); k < count; k++) {
    field.fillStyle = toward(metal.stops[1 + Math.floor(random() * 3)], metal.page, 0.45 + random() * 0.15);
    field.beginPath();
    field.arc(random() * picture.width, random() * picture.height, (0.5 + random() * 0.6) * scale, 0, Math.PI * 2);
    field.fill();
  }
  return picture;
}

// the work of drawing the field is spread over frames, so the ∞ keeps flowing meanwhile
const nextFrame = () => new Promise((done) => requestAnimationFrame(done));

/** Typesets every formula off screen and reads it back once KaTeX's fonts are in. */
async function typeset(measure: CanvasRenderingContext2D) {
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;white-space:nowrap;line-height:normal;z-index:-1";
  document.body.appendChild(host);
  try {
    const nodes = FORMULAS.map((formula) => {
      const node = document.createElement("div");
      // KaTeX sets its formulas at 1.21em
      node.style.cssText = `position:absolute;left:0;top:0;font-size:${SIZE[formula.depth] / 1.21}px`;
      node.innerHTML = katex.renderToString(`\\displaystyle ${formula.tex}`, { throwOnError: false, output: "html" });
      host.appendChild(node);
      return node;
    });
    // laid out, the formulas ask for their fonts; wait until every face they use is in
    const faces = new Set<string>();
    for (const element of host.querySelectorAll<HTMLElement>(".katex *")) {
      if (!element.firstChild || element.firstChild.nodeType !== Node.TEXT_NODE) continue;
      const style = getComputedStyle(element);
      faces.add(`${style.fontStyle} ${style.fontWeight} 16px ${style.fontFamily}`);
    }
    await Promise.all([...faces].map((face) => document.fonts.load(face).catch(() => [])));
    await document.fonts.ready;
    return nodes.map((node) => trace(node, measure));
  } finally {
    host.remove();
  }
}

const options = (mode: "light" | "dark", reducedMotion: boolean): EngineOptions => ({
  interactive: true,
  strength: 1,
  radius: 170,
  density: 2,
  dotSize: 1,
  spread: 1,
  turbulence: 1,
  liquid: 1,
  streaks: true,
  restStyle: "particles",
  returnSpeed: 1,
  ambient: false,
  ambientIntensity: 1,
  speed: 1,
  intro: true,
  reducedMotion,
  bg: mode === "dark" ? [0.067, 0.067, 0.063] : [0.922, 0.914, 0.898],
  imgBg: null,
});

/** The field of formulas, a canvas fixed behind the login window (`clear` is kept free of formulas). */
export default function FormulaSand({ mode, clear }: { mode: "light" | "dark"; clear: RefObject<HTMLElement | null> }) {
  const layer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = layer.current;
    if (!host) return;
    const canvas = document.createElement("canvas");
    canvas.className = "mp-formulas-canvas";
    host.appendChild(canvas);
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let engine: LiquidEngine | null = null;
    try {
      engine = new LiquidEngine(canvas, options(mode, motion.matches), () => { delete host.dataset.ready; });
    } catch {
      canvas.remove();
      return;
    }
    const sand = engine;
    let cancelled = false;
    let field: SculptureShape = { kind: "image", rect: { x: 0, y: 0, w: 1, h: 1 } };
    let drift: { piece: SculpturePiece; reach: number; speed: number[]; phase: number[] }[] = [];
    const start = performance.now();
    sand.onFirstFrame = () => { if (!cancelled) host.dataset.ready = "1"; };
    sand.morph = (): SculptureMorph => {
      // every formula floats on its own, slowly, two swells on each axis
      const t = (performance.now() - start) / 1000;
      const still = motion.matches;
      for (const { piece, reach, speed, phase } of drift) {
        piece.x = still ? 0 : reach * (0.75 * Math.sin(speed[0] * t + phase[0]) + 0.25 * Math.sin(speed[1] * t + phase[1]));
        piece.y = still ? 0 : reach * 0.8 * (0.75 * Math.sin(speed[2] * t + phase[2]) + 0.25 * Math.sin(speed[3] * t + phase[3]));
      }
      return { from: field, to: field, mix: 0, moving: !still };
    };

    const measure = document.createElement("canvas").getContext("2d")!;
    let built: Traced[] | null = null;
    const build = async () => {
      built ??= await typeset(measure);
      await nextFrame();
      if (cancelled) return;
      const width = host.clientWidth, height = host.clientHeight;
      const glass = clear.current?.getBoundingClientRect();
      const keep = glass ? { x: glass.left - 56, y: glass.top - 40, w: glass.width + 112, h: glass.height + 80 } : null;
      const placed = place(built, width, height, keep);
      const random = seeded(41);
      drift = placed.map(({ x, y, traced: { box }, index }) => ({
        piece: {
          box: { x: (x - PAD) / width, y: (y - PAD) / height, w: (box.w + PAD * 2) / width, h: (box.h + PAD * 2) / height },
          x: 0, y: 0,
        },
        reach: WANDER[FORMULAS[index].depth],
        speed: Array.from({ length: 4 }, () => (Math.PI * 2) / (16 + random() * 22)),
        phase: Array.from({ length: 4 }, () => random() * Math.PI * 2),
      }));
      const picture = paint(placed, width, height, mode, Math.min(1.5, Math.max(1, devicePixelRatio || 1)));
      await nextFrame();
      if (cancelled) return;
      field = { kind: "image", rect: { x: 0, y: 0, w: width, h: height }, pieces: drift.map((d) => d.piece) };
      sand.resize(width, height, field.rect);
      sand.setImage(picture);
    };
    build().catch(() => {});

    // a new window size lays the formulas out again; they no longer gather out of the dust for it
    let relayout = 0;
    const onResize = () => {
      window.clearTimeout(relayout);
      relayout = window.setTimeout(() => { sand.setOptions({ intro: false }); build().catch(() => {}); }, 250);
    };
    const onMove = (event: PointerEvent) => sand.pointer("move", event.clientX, event.clientY, event.pointerType === "touch");
    const onDown = (event: PointerEvent) => sand.pointer("down", event.clientX, event.clientY, event.pointerType === "touch");
    const onUp = (event: PointerEvent) => sand.pointer("up", event.clientX, event.clientY, event.pointerType === "touch");
    const onLeave = (event: PointerEvent) => sand.pointer("leave", event.clientX, event.clientY, event.pointerType === "touch");
    const onVisible = () => sand.setVisible(!document.hidden);
    const onMotion = () => sand.setOptions({ reducedMotion: motion.matches });
    const page = document.documentElement;
    window.addEventListener("resize", onResize);
    page.addEventListener("pointermove", onMove, { passive: true });
    page.addEventListener("pointerdown", onDown, { passive: true });
    page.addEventListener("pointerup", onUp, { passive: true });
    page.addEventListener("pointercancel", onUp, { passive: true });
    page.addEventListener("pointerleave", onLeave, { passive: true });
    document.addEventListener("visibilitychange", onVisible);
    motion.addEventListener?.("change", onMotion);
    return () => {
      cancelled = true;
      window.clearTimeout(relayout);
      window.removeEventListener("resize", onResize);
      page.removeEventListener("pointermove", onMove);
      page.removeEventListener("pointerdown", onDown);
      page.removeEventListener("pointerup", onUp);
      page.removeEventListener("pointercancel", onUp);
      page.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("visibilitychange", onVisible);
      motion.removeEventListener?.("change", onMotion);
      sand.destroy();
      canvas.remove();
      delete host.dataset.ready;
    };
  }, [mode, clear]);

  return <div ref={layer} className="mp-formulas" aria-hidden="true" />;
}
