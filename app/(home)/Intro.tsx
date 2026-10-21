"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import SculptureHero, { type Rect, type SculptureMorph, type SculptureShape, type SculptureStrands } from "../components/LiquidSculptureHero";
import TiltedGridHero from "../components/TiltedGridHero";
import WorksWheel, { type Vec3, type WheelGeometry } from "../components/WorksWheel";
import { BrandWordmark } from "../components/SiteHeader";
import { LoginForm } from "../components/LoginForm";
import { fetchMe, loginPath } from "../../lib/api-client";
import { saveAppearance } from "../../lib/appearance";
import FormulaSand from "./FormulaSand";
import "./intro.css";

// MathPilot product page, the site's home. The hero is the liquid particle sculpture, the ∞ of the tab icon (the
// pictures come from scripts/intro-infinity.html), beside the opening words. It stays where the page puts it: it
// leaves with the hero, runs through the teaching loop, which turns as a wheel, and at the end is the full stop of the
// last words. In between, the app's screens stream past in a curved row.
//
// 进入工作台 without an account stays on this page: the page gives way to the formulas that changed the world, made of
// the same sand, and the ∞ gathers into the frame of the login window (/login is this page with the window open).

const SANS = '"Helvetica Neue", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
const SERIF = '"Songti SC", "STSong", "Noto Serif SC", "Source Han Serif SC", serif';
const picture = (mode: "light" | "dark") => `/intro/infinity-${mode}.webp`;

// The ∞ as scripts/intro-infinity.html draws it in the 2400 × 960 picture: a lemniscate stretched 1.12× in height,
// its ribbons reaching 0.72·(34 + 74·cos²t) px either side of the line. The sculpture bends the ∞ along it.
const RIBBON = {
  at: (t: number): [number, number] => {
    const s = Math.sin(t), d = 1 + s * s;
    return [1200 + 860 * Math.cos(t) / d, 486 + 1.12 * 860 * s * Math.cos(t) / d];
  },
  halfWidth: (t: number) => 0.72 * (34 + 74 * Math.cos(t) ** 2),
};

// where the ∞'s line crosses itself, in a picture of it drawn in `rect`
const crossingOf = (r: Rect): [number, number] => {
  const [x, y] = RIBBON.at(Math.PI / 2);
  return [r.x + (x / 2400) * r.w, r.y + (y / 960) * r.h];
};

// The feature row: screens of the app (taken on an anonymised copy), each card labelled. The row is decoration, so the
// same names and lines are listed for screen readers.
const FEATURES = [
  { file: "transcribe", name: "文件转录", text: "题目或答案的照片、PDF，转成可编辑的 Word。" },
  { file: "library", name: "共享题库", text: "按模块整理题目，公式和图形原样排好。" },
  { file: "basket", name: "组卷篮", text: "从题库勾选题目、排好顺序，生成 Word 或 PDF。" },
  { file: "typeset", name: "快速排版", text: "一份练习，排成学生版、附答案版或教师版。" },
  { file: "handout", name: "讲义编撰", text: "所见即所得地写讲义，讲义、小测和作业放在一起。" },
  { file: "graph", name: "知识图谱", text: "知识点按年级排列，连线标出学习先后。" },
  { file: "grading", name: "作业批改", text: "上传作业照片或 PDF，按题号对上原题和答案。" },
  { file: "profile", name: "学生档案", text: "依据作答分析知识掌握与能力，错题进入错题本。" },
  { file: "report", name: "学情报告", text: "汇总一段时间的作业和能力诊断，写成报告。" },
  { file: "smart", name: "智能组卷", text: "说一句要什么练习，按学生档案挑题、按天排好。" },
];
const CARDS = FEATURES.map((feature) => ({ src: `/intro/${feature.file}.webp`, alt: feature.name }));
const ROW = { tile: 30, aspect: 16 / 9, axis: 60, curve: 80, fade: 12 };

// The teaching loop, turned as a wheel: the page's scroll brings the seven steps to the front one by one, each with its
// name and line beside it, and at the end they close into a ring round 教与学. A card is a recording of the step done
// in the app.
const STEPS = [
  { demo: "intake", name: "入库", text: "照片、PDF、Word 转成可编辑的题目，每道题一个永久编号。" },
  { demo: "paper", name: "组卷", text: "从题库勾选，或者说一句要什么练习，按学生档案挑题、按天排好。" },
  { demo: "handout", name: "讲义", text: "所见即所得地编讲义，排成学生版、附答案版和教师版 PDF。" },
  { demo: "assign", name: "布置", text: "在学生档案里布置作业，一份作业可以分几次交。" },
  { demo: "grading", name: "批改", text: "上传作业照片或 PDF 自动批改，按卷面上印的题号对上原题和答案。" },
  { demo: "profile", name: "定档", text: "依据作答分析知识掌握与能力，做错的题进入错题本。" },
  { demo: "report", name: "学情报告", text: "汇总每个学生的强项和薄弱处，带回下一轮组卷。" },
];
const REDUCE = "(prefers-reduced-motion: reduce)";
const followMotion = (changed: () => void) => {
  const query = window.matchMedia(REDUCE);
  query.addEventListener("change", changed);
  return () => query.removeEventListener("change", changed);
};
const motionReduced = () => window.matchMedia(REDUCE).matches;
// A step's demo: the real app doing it, recorded by scripts/record-intro-loop.mjs. The card shows its first frame;
// only the card resting at the centre plays it, from the start, and the cards beside it fetch it ahead. Reduced motion
// leaves it paused.
function StepDemo({ step, front, near, mode }: { step: (typeof STEPS)[number]; front: boolean; near: boolean; mode: "light" | "dark" }) {
  const video = useRef<HTMLVideoElement>(null);
  const reduced = useSyncExternalStore(followMotion, motionReduced, () => false);
  const [chosen, setChosen] = useState<boolean | null>(null); // the button's play/pause, over the default
  const playing = front && (chosen ?? !reduced);
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    if (playing) el.play().catch(() => {});
    else el.pause();
    if (!front) el.currentTime = 0; // back on the first frame, the card's cover
  }, [playing, front, mode]);
  const src = `/intro/loop/${step.demo}-${mode}`;
  return <>
    <video ref={video} key={mode} className="mp-step-demo" src={`${src}.mp4`} poster={`${src}.jpg`} muted loop playsInline
      preload={near ? "auto" : "none"} aria-hidden="true" />
    {front ? <button type="button" className="mp-step-demo-toggle" aria-label={playing ? "暂停演示" : "播放演示"} title={playing ? "暂停演示" : "播放演示"}
      onClick={() => setChosen(!playing)}>
      {playing
        ? <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 2v8M8.5 2v8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        : <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 2.2v7.6L10 6z" fill="currentColor" /></svg>}
    </button> : null}
  </>;
}
const DEPLOY = [
  { name: "局域网共享", text: "一台 Mac 就是服务器。同事在同一个网络里用浏览器打开，共用一套题库和讲义。" },
  { name: "账号与权限", text: "用邀请码给同事开账号；删除这类操作只有管理员能做。" },
  { name: "AI 按需接入", text: "在 AI 配置里接入模型服务；不接也能人工录题、浏览题库、生成 Word。" },
];

// The ∞ gathers into the login window, and scatters back into the page when it closes, over this long.
const GATHER_MS = 1800;
const SCATTER_MS = 1300;
// the window's frame of sand, round the outside of its glass (.mp-login-card has the same corner radius)
const FRAME = { radius: 26, halfWidth: 3.5, outset: 7, fill: 0.3 };
// The 闭环 wheel's sand is the ∞'s two lobes, 学 (the right one) and 教: round a card each runs from the middle of its top
// down its own side to the middle of its bottom, CARD_FRAME outside the card's rounded-lg edge; between two shapes they
// twist round each other into a cord, CORD.radius apart, a half turn every CORD.twist card heights, both ends crossings
// where the strands change sides as they do in the middle of the ∞.
const CARD_FRAME = { radius: 8, halfWidth: 2.5, outset: 5 };
const CORD = { radius: 7, halfWidth: 2, twist: 0.2 };
const EYE_POINTS = 240;
const plus = (a: Vec3, b: Vec3, k = 1): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const mixed = (a: Vec3, b: Vec3, t: number): Vec3 => plus(a, plus(b, a, -1), t);
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: Vec3): Vec3 => plus([0, 0, 0], a, 1 / (Math.hypot(...a) || 1));
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// which way a card's own right (x) or down (y) points in the wheel's space
const axis = (g: WheelGeometry, i: number, x: number, y: number, dx: number, dy: number) => unit(plus(g.at(i, x + dx, y + dy), g.at(i, x, y), -1));
// The frame of sand round card i as the wheel has it now, in px on the screen; `length` is a lobe's on the card itself.
function eyeOf(g: WheelGeometry, i: number) {
  const { w, h, face } = g.card;
  const { radius, outset, halfWidth } = CARD_FRAME;
  const R = radius + outset, a = w / 2 - radius, b = h / 2 - radius, arc = (Math.PI / 2) * R;
  const length = 2 * a + 2 * arc + 2 * b;
  const line = (side: number) => {
    const out = new Float32Array(EYE_POINTS * 4);
    for (let k = 0; k < EYE_POINTS; k++) {
      let d = (k / (EYE_POINTS - 1)) * length, x: number, y: number;
      if (d < a) [x, y] = [d, -h / 2 - outset];
      else if ((d -= a) < arc) [x, y] = [a + Math.sin(d / R) * R, -b - Math.cos(d / R) * R];
      else if ((d -= arc) < 2 * b) [x, y] = [w / 2 + outset, d - b];
      else if ((d -= 2 * b) < arc) [x, y] = [a + Math.cos(d / R) * R, b + Math.sin(d / R) * R];
      else [x, y] = [a - (d - arc), h / 2 + outset];
      const [sx, sy, near] = g.view(g.at(i, side * x, y));
      out.set([sx, sy, halfWidth * face * near, 0], k * 4);
    }
    return out;
  };
  const shape: SculptureShape = { kind: "path", strands: [line(1), line(-1)], span: (w + h) * face * g.view(g.at(i, 0, 0))[2] * 0.9 };
  return { shape, length: length * face };
}
// The cord from one shape into the next, in the wheel's space: from `start`, leaving along `out`, to `end`, arriving
// along `into`, `across` the way to the right at either end. The right lobe starts on the near side, so it comes out of
// the crossing to the left; `turns` half turns later (an odd number) it crosses back into the right of what is next.
function cordOf(g: WheelGeometry, start: Vec3, out: Vec3, across0: Vec3, end: Vec3, into: Vec3, across1: Vec3, turns?: number) {
  const reach = Math.hypot(...plus(end, start, -1));
  const c1 = plus(start, out, reach * 0.4), c2 = plus(end, into, -reach * 0.4);
  const point = (t: number) => mixed(mixed(mixed(start, c1, t), mixed(c1, c2, t), t), mixed(mixed(c1, c2, t), mixed(c2, end, t), t), t);
  const along = (t: number) => unit(mixed(mixed(plus(c1, start, -1), plus(c2, c1, -1), t), mixed(plus(c2, c1, -1), plus(end, c2, -1), t), t));
  // the curve measured, so that the points come evenly along it
  const N = 64, run = [0];
  for (let j = 1; j <= N; j++) run.push(run[j - 1] + Math.hypot(...plus(point(j / N), point((j - 1) / N), -1)));
  const length = run[N], pitch = CORD.twist * g.card.h;
  const half = turns ?? 2 * Math.max(0, Math.round((length / pitch - 1) / 2)) + 1;
  const count = Math.min(480, Math.max(32, Math.round(length / 2)));
  const radius = CORD.radius * g.card.face, taper = Math.min(0.3, (0.5 * pitch) / Math.max(length, 1));
  const strands: SculptureStrands = [new Float32Array(count * 4), new Float32Array(count * 4)];
  for (let k = 0, j = 0; k < count; k++) {
    const s = k / (count - 1), want = s * length;
    while (j < N - 1 && run[j + 1] < want) j++;
    const t = (j + (want - run[j]) / (run[j + 1] - run[j] || 1)) / N;
    const p = point(t), tangent = along(t);
    // the way to the right turns from one end's to the other's, square to the curve; the near side square to both
    const lean = mixed(across0, across1, s);
    const side = unit(plus(lean, tangent, -dot(lean, tangent)));
    const near = cross(side, tangent);
    const phase = Math.PI / 2 + half * Math.PI * s;
    const open = smooth(0, taper, s) * smooth(0, taper, 1 - s);
    [1, -1].forEach((sign, lobe) => {
      const [x, y, scale] = g.view(plus(plus(p, side, sign * radius * open * Math.cos(phase)), near, sign * radius * open * Math.sin(phase)));
      strands[lobe].set([x, y, CORD.halfWidth * g.card.face * scale, sign * Math.sin(phase) * open], k * 4);
    });
  }
  return { strands, length };
}
// from one shape into the next through `cord`, `length` being a lobe's in the first (SculptureMorph.cord)
const pour = (from: SculptureShape, to: SculptureShape, length: number, mix: number, cord: { strands: SculptureStrands; length: number }): SculptureMorph =>
  ({ from, to, mix, cord: { strands: cord.strands, share: cord.length / length } });

// The last words end on a full stop of sand. Coming in, the ∞'s two lobes lie scattered along two arms round it, half
// a turn apart and both turning clockwise, and as the page scrolls on they wind into it: 学 into its right half from
// the top, 教 into its left half from the bottom. There it keeps turning slowly, the way they came in. An arm winds
// STOP.arms turns from STOP.reach of the screen's height out, its band STOP.band of that wide either side out there,
// where only a few of its grains show; the stop's band is STOP.stroke of its radius, and it turns once in STOP.spin ms.
const STOP = { arms: 1.75, reach: 0.34, band: 0.22, stroke: 0.12, spin: 30000, points: 480 };
// Where the font draws "。" in `span`, in px on the screen: its ink, measured once per font on a canvas.
let stopInk: { font: string; box: [number, number, number, number] } | null = null;
function inkOf(span: HTMLElement): Rect {
  const style = getComputedStyle(span);
  const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  if (stopInk?.font !== font) {
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.font = font;
    const m = ctx.measureText("。");
    // from the left of the span and the top of its font's ascent, where the box's top is
    stopInk = { font, box: [-m.actualBoundingBoxLeft, m.fontBoundingBoxAscent - m.actualBoundingBoxAscent,
      m.actualBoundingBoxLeft + m.actualBoundingBoxRight, m.actualBoundingBoxAscent + m.actualBoundingBoxDescent] };
  }
  const r = span.getBoundingClientRect(), [x, y, w, h] = stopInk.box;
  return { x: r.left + x, y: r.top + y, w, h };
}
// The full stop of sand over the glyph's ink, the two arms that wind into it and where they meet, all turned by `spin`
// (radians). An arm runs from out in the page in to the stop, a half of the stop on from there clockwise.
function stopOf(ink: Rect, view: { w: number; h: number }, spin: number) {
  const cx = ink.x + ink.w / 2, cy = ink.y + ink.h / 2, outer = Math.min(ink.w, ink.h) / 2;
  const stroke = outer * STOP.stroke, r0 = outer - stroke, reach = Math.max(view.h * STOP.reach, outer * 4);
  const n = STOP.points;
  const round = (a: number) => [cx + r0 * Math.cos(a), cy + r0 * Math.sin(a), stroke, 0];
  const half = (a: number) => {
    const out = new Float32Array(n * 4);
    for (let k = 0; k < n; k++) out.set(round(a + (Math.PI * k) / (n - 1)), k * 4);
    return out;
  };
  // The radius closes in on the stop's as the arm comes round, so that it runs on into the stop along it, and the band
  // narrows to the stop's only near the end. Out there it lies far back (SculptureStrands), so that only a few grains
  // show, more and more of them as they come in. Its points are laid evenly along its length.
  const arm = (a: number) => {
    const N = 1024, fine: number[][] = [], run = [0];
    for (let j = 0; j <= N; j++) {
      const f = 1 - j / N, angle = a - 2 * Math.PI * STOP.arms * f, r = r0 + (reach - r0) * f ** 1.5;
      fine.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle), stroke + (reach * STOP.band - stroke) * f ** 0.6, -1.85 * f ** 0.4]);
      if (j) run.push(run[j - 1] + Math.hypot(fine[j][0] - fine[j - 1][0], fine[j][1] - fine[j - 1][1]));
    }
    const out = new Float32Array(n * 4);
    for (let k = 0, j = 0; k < n; k++) {
      const want = (k / (n - 1)) * run[N];
      while (j < N - 1 && run[j + 1] < want) j++;
      const t = (want - run[j]) / (run[j + 1] - run[j] || 1);
      out.set(fine[j].map((v, e) => v + (fine[j + 1][e] - v) * t), k * 4);
    }
    return out;
  };
  const top = spin - Math.PI / 2, bottom = spin + Math.PI / 2, span = view.h * 0.8;
  const arms: SculptureShape = { kind: "path", strands: [arm(top), arm(bottom)], span };
  const stop: SculptureShape = { kind: "path", strands: [half(top), half(bottom)], span };
  const meet: SculptureStrands = [new Float32Array([...round(top), ...round(top)]), new Float32Array([...round(bottom), ...round(bottom)])];
  return { arms, stop, meet: { strands: meet, length: 0 } };
}
type Gather = { from: number; to: number; start: number };
// how far the ∞ has gathered (0 … 1), taking `ms` there and SCATTER_MS back; a move starts on the first frame drawn
// after it was asked for
const gatheredAt = (g: Gather, now: number, ms = GATHER_MS) => {
  if (g.start < 0) return g.from;
  const t = Math.min(1, (now - g.start) / (g.to > g.from ? ms : SCATTER_MS));
  return g.from + (g.to - g.from) * t * t * (3 - 2 * t);
};
// 进入工作台 opens the library with its entrance (both side panels unfold once); a guest from here gets it too
const WORKBENCH = "/library?from=intro";
// On the way into the workbench the ∞ opens into its frame: the upper arcs along the top bar's rule and down the two
// folded rails the 题库 opens with, the lower arcs pouring off the bottom of the screen, a few grains left as
// dust where the questions will be. The workbench then fades in over the sand (a view transition across the two pages,
// opted into by app/layout.tsx), its lines where the sand lay. The page is left a little before the sand settles,
// which hides the time the next one takes to arrive.
const ENTER_MS = 1000;
const ENTER_LEAD_MS = 100;
const GATE = { radius: 0, halfWidth: 2.5, outset: 0, fill: 0.06 };
// the frame's insets from the top and the sides of the screen, in px (negative: just off the screen)
type Entry = Gather & { top: number; left: number; right: number };
const OFF_SCREEN = -8;
const viewTransition = "@view-transition{navigation:auto}";
// only paths on this site, never back to the login page
const nextOf = (value?: string | null) =>
  value && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\") && !value.startsWith("/login") ? value : "/library";
// the sculpture draws a new frame whenever the page moves
const redraw = () => window.dispatchEvent(new Event("scroll"));
// The page wears the site's light/dark setting, the one the workbench's switch keeps (lib/appearance.ts puts it on
// <html> before the first paint). The server knows nothing of it: the page is rendered light, and right after hydration
// takes the setting (intro.css keeps it out of sight on a dark setting until then).
const followTheme = (changed: () => void) => {
  const observer = new MutationObserver(changed);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
};
const themeNow = () => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");
const themeOnServer = () => null;

const number = (index: number) => String(index + 1).padStart(2, "0");

function Arrow() {
  return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <path d="M2 7h10M8 3l4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

/** The product page; with `login` (where to go once signed in) its login window is open from the start. */
export default function IntroPage({ login: opened }: { login?: string }) {
  const mode = useSyncExternalStore(followTheme, themeNow, themeOnServer);
  const shade = mode ?? "light";
  const reduced = useSyncExternalStore(followMotion, motionReduced, () => false);
  const [front, setFront] = useState(-1);
  const wheel = STEPS.map((step, i) => ({
    title: step.name,
    text: step.text,
    face: <StepDemo step={step} front={i === front} near={front >= 0 && Math.abs(i - front) <= 1} mode={shade} />,
  }));
  const root = useRef<HTMLDivElement>(null);
  const closing = useRef<HTMLElement>(null);
  const closingStop = useRef<HTMLSpanElement>(null);
  const ringArt = useRef<HTMLDivElement>(null);
  const loopRef = useRef<HTMLElement | null>(null);
  const scrolled = useRef(-1);
  const turned = useRef(-1);
  const wheelGeometry = useRef<(() => WheelGeometry) | null>(null);
  // 进入工作台 opens the 题库; whoever is not signed in gets the login window first
  const [workbench, setWorkbench] = useState(loginPath(WORKBENCH));
  const initial = opened === undefined ? null : { next: nextOf(opened), leaving: false };
  const [login, setLogin] = useState(initial);
  const shown = useRef(initial);
  const gather = useRef<Gather>({ from: 0, to: initial ? 1 : 0, start: -1 });
  const glass = useRef<HTMLDivElement>(null);
  // the window was opened here, over an entry of this page's own in the history
  const pushed = useRef(false);
  // what had the focus before the window opened, and gets it back afterwards
  const opener = useRef<HTMLElement | null>(null);
  const signedIn = useRef(false);
  // the ∞ opening into the workbench's frame, and where the page is going meanwhile
  const entry = useRef<Entry>({ from: 0, to: 0, start: -1, top: 0, left: 0, right: 0 });
  const [entering, setEntering] = useState(false);
  const leaving = useRef<{ href: string; replace: boolean; timer: number; optIn: HTMLStyleElement } | null>(null);

  // asked again (a click while the next page is slow to come, or after the browser stopped it), the page goes again
  const go = useCallback(() => {
    const away = leaving.current;
    if (!away) return;
    window.clearTimeout(away.timer);
    if (away.replace) window.location.replace(away.href);
    else window.location.assign(away.href);
  }, []);
  // staying after all (Esc, or back here with the page kept whole by the browser): the sand flows back from the frame
  // and the page returns
  const stay = useCallback(() => {
    const away = leaving.current;
    if (!away) return;
    window.clearTimeout(away.timer);
    away.optIn.remove();
    leaving.current = null;
    entry.current = { ...entry.current, from: gatheredAt(entry.current, performance.now(), ENTER_MS), to: 0, start: -1 };
    setEntering(false);
    redraw();
  }, []);
  // 进入工作台: the sand opens into the workbench's frame, then the page goes. Without the moving sand (no WebGL, or less
  // motion asked for) it goes at once.
  const enterWorkbench = useCallback((href: string, { replace = false, member = signedIn.current } = {}) => {
    if (leaving.current) return go();
    const page = root.current;
    if (page?.querySelector<HTMLElement>(".sh-root")?.dataset.gl !== "on" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      if (replace) window.location.replace(href);
      else window.location.assign(href);
      return;
    }
    const now = performance.now();
    // the login window's sand stays where it is now; the frame is drawn from there
    const into = gatheredAt(gather.current, now);
    gather.current = { from: into, to: into, start: -1 };
    // the 题库 opens with its rails folded (globals.css): the directory's on the left, and the knowledge map's on the
    // right for members; other pages, and the 题库 on a narrow screen, only have the top bar's rule
    const css = getComputedStyle(document.documentElement);
    const px = (name: string) => parseFloat(css.getPropertyValue(name)) || 0;
    const rails = new URL(href, window.location.href).pathname === "/library" && window.innerWidth > 850;
    entry.current = {
      from: gatheredAt(entry.current, now, ENTER_MS), to: 1, start: -1, top: px("--topbar-h"),
      left: rails ? px("--directory-rail") : OFF_SCREEN, right: rails && member ? px("--kgl-rail") : OFF_SCREEN,
    };
    const optIn = document.createElement("style");
    optIn.textContent = viewTransition;
    document.head.append(optIn);
    leaving.current = { href, replace, optIn, timer: window.setTimeout(go, ENTER_MS - ENTER_LEAD_MS) };
    setEntering(true);
    redraw();
  }, [go]);

  const openLogin = useCallback((next: string, push: boolean) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    gather.current = { from: gatheredAt(gather.current, performance.now()), to: 1, start: -1 };
    shown.current = { next, leaving: false };
    setLogin(shown.current);
    if (push) {
      window.history.pushState(null, "", loginPath(next));
      pushed.current = true;
    }
    redraw();
  }, []);
  const closeLogin = useCallback((fromHistory: boolean) => {
    if (!shown.current || shown.current.leaving || leaving.current) return;
    gather.current = { from: gatheredAt(gather.current, performance.now()), to: 0, start: -1 };
    shown.current = { ...shown.current, leaving: true };
    setLogin(shown.current);
    if (!fromHistory) {
      if (pushed.current) window.history.back();
      else window.history.replaceState(null, "", "/");
    }
    pushed.current = false;
    redraw();
    window.setTimeout(() => {
      if (!shown.current?.leaving) return;
      shown.current = null;
      setLogin(null);
    }, SCATTER_MS + 150);
  }, []);
  // while the window is open the page under it is out of reach, for the keyboard and screen readers too; once it
  // closes, the focus goes back to what opened it
  const open = login !== null && !login.leaving;
  useEffect(() => {
    const page = root.current;
    if (!page || !open) return;
    const under = [...page.children].filter((child): child is HTMLElement => child instanceof HTMLElement && !child.matches(".mp-veil, .mp-formulas, .mp-login"));
    for (const child of under) child.inert = true;
    return () => {
      for (const child of under) child.inert = false;
      opener.current?.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    fetchMe().then(({ user }) => {
      if (!user) return;
      signedIn.current = true;
      setWorkbench(WORKBENCH);
      // signed in already (on this Mac, always): no window, straight on
      if (shown.current) enterWorkbench(shown.current.next, { replace: true });
    }).catch(() => {});
  }, [enterWorkbench]);
  // On the way into the workbench a click or a key goes at once, and Esc stays.
  useEffect(() => {
    if (!entering) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return go();
      window.stop();
      stay();
    };
    window.addEventListener("pointerdown", go);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", go);
      window.removeEventListener("keydown", onKey);
    };
  }, [entering, go, stay]);
  useEffect(() => {
    const onShow = (event: PageTransitionEvent) => { if (event.persisted) stay(); };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, [stay]);
  // every 进入工作台 still points at /login, so it works before the page has loaded; here it opens the window in place
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest?.("a[href]");
      const href = link?.getAttribute("href");
      // signed in, or a guest from the window: into the 题库
      if (href?.startsWith("/library")) {
        event.preventDefault();
        enterWorkbench(href);
        return;
      }
      if (!href?.startsWith("/login")) return;
      event.preventDefault();
      if (!shown.current || shown.current.leaving) openLogin(nextOf(new URL(href, window.location.href).searchParams.get("next")), true);
    };
    const onHistory = () => {
      const atLogin = window.location.pathname === "/login";
      if (atLogin && (!shown.current || shown.current.leaving)) openLogin(nextOf(new URLSearchParams(window.location.search).get("next")), false);
      else if (!atLogin) closeLogin(true);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") closeLogin(false); };
    document.addEventListener("click", onClick);
    window.addEventListener("popstate", onHistory);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      window.removeEventListener("popstate", onHistory);
      window.removeEventListener("keydown", onKey);
    };
  }, [openLogin, closeLogin, enterWorkbench]);
  // Sections rise in as they scroll into view; without script they are simply shown.
  useEffect(() => {
    const page = root.current;
    if (!page) return;
    page.dataset.reveal = "on";
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add("is-in"); observer.unobserve(entry.target); }
    }, { rootMargin: "0px 0px -10% 0px" });
    page.querySelectorAll(".mp-reveal").forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, []);

  // While the 闭环 section is on the screen the sand belongs to it, one line running on from shape to shape. Coming in,
  // the hero's ∞ lets its lobes out through its crossing, down a twisted cord into the frame round the card at the
  // front. As the wheel turns, that frame runs out of the bottom of its card, down the cord between the two and into
  // the next card's frame from the top, the two half frames and the cord an hourglass on the way. When the cards close
  // into the ring it pours from the last card into an ∞ in the middle, over 教学 (ringArt), which then scrolls away with
  // the section.
  const loopForms = (hero: Rect, view: { w: number; h: number }) => {
    const section = loopRef.current ??= document.getElementById("loop");
    const ring = ringArt.current?.getBoundingClientRect();
    const g = wheelGeometry.current?.();
    if (!section || !ring || !g) return null;
    const box = section.getBoundingClientRect();
    if (box.top >= view.h || box.bottom <= 0) return null;
    const { turn } = g, last = STEPS.length - 1, edge = g.card.h / 2 + CARD_FRAME.outset;
    // the middle of a card's bottom or top, and which ways its own down and right point there
    const end = (i: number, y: number) => [g.at(i, 0, y), axis(g, i, 0, y, 0, 1), axis(g, i, 0, y, 1, 0)] as const;
    // an ∞ on the screen meets its cord at its crossing, the cord upright there
    const crossing = (r: Rect) => {
      const [x, y] = crossingOf(r);
      return [[x - g.origin[0], y - g.origin[1], 0], [0, 1, 0], [1, 0, 0]] as [Vec3, Vec3, Vec3];
    };
    let form: SculptureMorph;
    if (box.top > 0) {
      const eye = eyeOf(g, 0);
      form = pour({ kind: "image", rect: hero }, eye.shape, eye.length, Math.min(1, 1 - box.top / view.h), cordOf(g, ...crossing(hero), ...end(0, -edge)));
    } else if (turn >= last) {
      // Poured once the cards have nearly closed into the ring, and so timed by the page's own scroll, from the last
      // stretch's second half until the section is a quarter of the screen on its way out: the ring itself closes in
      // too short a stretch to show it. It waits for the cards, should the wheel lag behind a quick scroll.
      const eye = eyeOf(g, last), centre: Rect = { x: ring.left, y: ring.top, w: ring.width, h: ring.height };
      const run = Math.max(1, box.height - view.h);
      const mix = Math.min(smooth((run * (last + 0.6)) / (last + 1), run + view.h / 4, -box.top), Math.min(1, Math.max(0, (turn - last - 0.7) / 0.3)));
      form = pour(eye.shape, { kind: "image", rect: centre }, eye.length, mix, cordOf(g, ...end(last, edge), ...crossing(centre), 1));
    } else {
      const i = Math.floor(turn), eye = eyeOf(g, i);
      form = pour(eye.shape, eyeOf(g, i + 1).shape, eye.length, turn - i, cordOf(g, ...end(i, edge), ...end(i + 1, -edge)));
    }
    return { form, turn };
  };

  // The last words' full stop (stopOf): the arms wind into it as the section comes up the screen, from when its top is
  // 15% up from the bottom until it is a tenth from the top, and back out as the page scrolls back. The stop is a few
  // px across, so as it forms the sand stops swaying under the cursor, which would bend it out of shape; passing over
  // it still stirs it.
  const stopForms = (section: DOMRect, stop: HTMLElement, view: { w: number; h: number }, now: number): SculptureMorph => {
    const { arms, stop: full, meet } = stopOf(inkOf(stop), view, reduced ? 0 : (now / STOP.spin) * 2 * Math.PI);
    const gathered = smooth(view.h * 0.85, view.h * 0.1, section.top);
    return { ...pour(arms, full, 1, gathered, meet), liquid: 1 - gathered };
  };

  // Asked by the sculpture every frame: which two shapes it is between, and how far along. On the page the sand stays
  // where the page puts it: the ∞ scrolls away with the hero, and the last words' full stop scrolls in with them. It is
  // the hero's until the page is nearer the last words, both out of sight where that changes, and while neither is on
  // the screen the sculpture rests.
  const scrollForms = (hero: Rect, view: { w: number; h: number }): SculptureMorph => {
    const section = closing.current?.getBoundingClientRect();
    const middle = (top: number, height: number) => Math.abs(top + height / 2 - view.h / 2);
    const last = section && closingStop.current && middle(section.top, section.height) < middle(hero.y, hero.h) ? section : null;
    const place: Rect = last ? { x: last.left, y: last.top, w: last.width, h: last.height } : hero;
    const wheel = loopForms(hero, view);
    // drawn every frame while the page scrolls or the wheel turns, so it keeps step with them
    const moving = window.scrollY !== scrolled.current || wheel?.turn !== turned.current;
    scrolled.current = window.scrollY;
    turned.current = wheel?.turn ?? -1;
    // the login window: from the shape it has on the page (the page stands still meanwhile) into the window's frame
    const now = performance.now(), g = gather.current, e = entry.current;
    if (g.start < 0 && g.to !== g.from) g.start = now;
    if (e.start < 0 && e.to !== e.from) e.start = now;
    const into = gatheredAt(g, now);
    const out = gatheredAt(e, now, ENTER_MS);
    // out of sight, and not on its way into a window or back (stirred grains stray a little past the picture)
    const { x, y, w, h } = place;
    const away = !wheel && !g.to && !e.to && !into && !out && (y + h * 1.1 < 0 || y - h * 0.1 > view.h || x + w < 0 || x > view.w);
    const box = glass.current?.getBoundingClientRect();
    const still: SculptureShape = { kind: "image", rect: hero };
    let form: SculptureMorph = wheel ? { ...wheel.form, moving }
      : last ? { ...stopForms(last, closingStop.current!, view, now), moving, away }
      : { from: still, to: still, mix: 0, moving, away };
    // where the sand is now, to move on from: part way through a pour it stays where the pour has it
    const held = (m: SculptureMorph): SculptureShape => m.cord && m.mix > 0 && m.mix < 1 ? { kind: "pour", pour: m } : m.mix < 0.5 ? m.from : m.to;
    if (into > 0 && box) {
      const frame: SculptureShape = { kind: "window", rect: { x: box.left, y: box.top, w: box.width, h: box.height }, ...FRAME };
      form = { from: held(form), to: frame, mix: into, moving: moving || into !== g.to };
    }
    // into the workbench: from that shape into its frame, which reaches twice the screen's height below the top bar so
    // that the lower arcs, laid along its bottom half, pour off the screen
    if (out <= 0) return form;
    const gate: SculptureShape = {
      kind: "window", rect: { x: e.left, y: e.top, w: view.w - e.left - e.right, h: 2 * (view.h - e.top) }, ...GATE,
    };
    return { from: held(form), to: gate, mix: out, moving: form.moving || out !== e.to };
  };

  return <div ref={root} className="mp-intro" data-mode={mode ?? undefined} data-login={login ? (login.leaving ? "out" : "in") : undefined}
    data-opened={opened !== undefined ? "" : undefined} data-entering={entering ? "" : undefined}>
    <SculptureHero
      src={picture("light")} darkSrc={picture("dark")}
      mobileSrc={picture("light")} mobileDarkSrc={picture("dark")}
      imageAlt="金属丝带与微粒组成的无穷符号 ∞"
      brand={<BrandWordmark />}
      navLinks={[{ label: "闭环", href: "#loop" }, { label: "功能", href: "#features" }, { label: "部署", href: "#deploy" }]}
      navCta={{ label: "进入工作台", href: workbench }}
      eyebrow="MathPilot — 数学教研工作台"
      headline={"教与学，\n循环不息。"}
      headlineAccent="循环不息。"
      body="为数学教师与教研团队打造的智能工作台，让教学创作、内容管理与 AI 协作自然衔接。"
      primaryCta={{ label: "进入工作台", href: workbench }}
      secondaryCta={{ label: "了解功能", href: "#features" }}
      tagline="Intelligent mathematics workspace"
      scrollCue={{ label: "Scroll to explore", href: "#loop" }}
      // left out, the component shows its author's credit
      showCredit={false}
      hint="移动鼠标，拨动这道 ∞"
      hintTouch="触碰这道 ∞"
      backdropText="教学"
      ambient
      // with the window open the cursor only ripples the window's frame, which keeps its shape; into the workbench it
      // leaves the sand alone
      strength={entering ? 0 : login ? 0.25 : 1}
      scrollForms={scrollForms}
      ribbon={RIBBON}
      theme={shade}
      onThemeChange={(next) => saveAppearance(next === "dark" ? "tech" : "light")}
      accentColor={shade === "dark" ? "#9DBFAA" : "#3E5E4C"}
      headingFont={SANS}
      accentFont={SERIF}
      bodyFont={SANS}
      loadFonts={false}
    />

    <WorksWheel id="loop" className="mp-wheel" label="教与学" items={wheel} onFront={setFront} geometryRef={wheelGeometry}>
      {/* the ring's middle: the sand gathers into an ∞ here over a faint 教学; without WebGL the picture stands in */}
      <div ref={ringArt} className="mp-ring-art" aria-hidden="true">
        <span>教学</span>
        {/* eslint-disable-next-line @next/next/no-img-element -- a stand-in the canvas draws over at the same place */}
        <img src={picture(shade)} alt="" />
      </div>
      <header className="mp-wheel-head">
        <p className="mp-kicker">01 闭环</p>
        <p className="mp-lead">七步连成一圈：学生做过的每一道题，<br />都会带着批改结果回到下一轮备课。</p>
      </header>
    </WorksWheel>

    <section id="features" className="mp-showcase">
      <TiltedGridHero className="mp-row" images={CARDS} speed={4} tileHeight={ROW.tile} aspectRatio={ROW.aspect} gap={6}
        axis={ROW.axis} curve={ROW.curve} fade={ROW.fade}>
        <header className="mp-head mp-reveal">
          <p className="mp-kicker">02 功能</p>
          <div><h2>一个工作台，<br /><em>装下数学教研的日常。</em></h2></div>
        </header>
        <ul className="mp-hidden">
          {FEATURES.map((feature) => <li key={feature.file}>{feature.name}：{feature.text}</li>)}
        </ul>
      </TiltedGridHero>
    </section>

    <section id="deploy" className="mp-section">
      <header className="mp-head mp-reveal">
        <p className="mp-kicker">03 部署</p>
        <div><h2>装在自己的电脑上，<br /><em>和同事一起用。</em></h2></div>
      </header>
      <ol className="mp-grid">
        {DEPLOY.map((item, index) => <li key={item.name} className="mp-cell mp-reveal" style={{ transitionDelay: `${index * 90}ms` }}>
          <span className="mp-cell-no">{number(index)}</span><h3>{item.name}</h3><p>{item.text}</p>
        </li>)}
      </ol>
    </section>

    <section ref={closing} className="mp-closing">
      {/* the sand comes to rest as the full stop; without WebGL the font's own stands */}
      <h2 className="mp-reveal">从下一份作业<em>开始<span ref={closingStop} className="mp-stop">。</span></em></h2>
      <a className="mp-btn" href={workbench}>进入工作台<Arrow /></a>
    </section>

    <footer className="mp-foot">
      <BrandWordmark /><span>数学教研工作台</span><span>© 2026 MathPilot</span>
    </footer>

    {login && <>
      <div className="mp-veil" aria-hidden="true" />
      {mode && <FormulaSand mode={mode} clear={glass} />}
      <div className="mp-login" role="dialog" aria-modal="true" aria-labelledby="mp-login-title" inert={login.leaving}>
        <LoginForm ref={glass} next={login.next} guest={login.next === WORKBENCH ? WORKBENCH : "/library"} onClose={() => closeLogin(false)}
          onDone={(next) => enterWorkbench(next, { member: true })} />
      </div>
    </>}
  </div>;
}
