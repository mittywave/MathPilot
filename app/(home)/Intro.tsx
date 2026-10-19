"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import SculptureHero, { type Rect, type SculptureMorph, type SculptureShape } from "../components/LiquidSculptureHero";
import TiltedGridHero, { arc, CAMERA, MAX_WIDTH } from "../components/TiltedGridHero";
import { BrandWordmark } from "../components/SiteHeader";
import { LoginForm } from "../components/LoginForm";
import { fetchMe, loginPath } from "../../lib/api-client";
import { saveAppearance } from "../../lib/appearance";
import FormulaSand from "./FormulaSand";
import "./intro.css";

// MathPilot product page, the site's home. The hero is the liquid particle sculpture, the ∞ of the tab icon (the
// pictures come from scripts/intro-infinity.html). It follows the page down: it opens into the rails of the feature
// row, closes again as the track of the loop, and lands whole above the last words. The sections follow the hero's
// light/dark switch.
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
  { file: "profile", name: "学生档案", text: "按知识点和五项能力定档，错题进入错题本。" },
  { file: "report", name: "学情报告", text: "汇总一段时间的作业和课后反馈，写成报告。" },
  { file: "smart", name: "智能组卷", text: "说一句要什么练习，按学生档案挑题、按天排好。" },
];
const CARDS = FEATURES.map((feature) => ({ src: `/intro/${feature.file}.webp`, alt: feature.name }));
// the row's geometry, shared with the rails the ∞ opens into
const ROW = { tile: 30, aspect: 16 / 9, axis: 60, curve: 80, fade: 12 };

// The teaching loop drawn on a lemniscate: the left lobe is 教, the right lobe is 学, and they cross at 学情报告.
const LOOP = { w: 1200, h: 620, cx: 600, cy: 300, a: 400 };
const PEAK = Math.asin(Math.sqrt(1 / 3)); // a lobe is tallest this far from its tip
const REPORT_Y = LOOP.cy + 0.354 * LOOP.a + 74;
// Rounded: the server and the browser disagree on the last digits of sin/cos, which would break hydration.
function onLoop(t: number): [number, number] {
  const s = Math.sin(t), d = 1 + s * s;
  return [Math.round((LOOP.cx + LOOP.a * Math.cos(t) / d) * 10) / 10, Math.round((LOOP.cy + LOOP.a * s * Math.cos(t) / d) * 10) / 10];
}
const percent = (value: number, of: number) => `${(value / of * 100).toFixed(2)}%`;
// starts at the crossing and runs through the left lobe first, the order the steps follow
const LOOP_PATH = Array.from({ length: 241 }, (_, i) => onLoop(Math.PI / 2 + (i / 240) * Math.PI * 2))
  .map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join(" ");

const STEPS: { t: number; place: "above" | "below" | "left" | "right"; name: string; text: string }[] = [
  { t: Math.PI - PEAK, place: "above", name: "入库", text: "照片、PDF、Word 转成可编辑的题目，每道题一个永久编号。" },
  { t: Math.PI, place: "left", name: "组卷", text: "从题库勾选，或者说一句要什么练习，按学生档案挑题、按天排好。" },
  { t: Math.PI + PEAK, place: "below", name: "讲义", text: "所见即所得地编讲义，排成学生版、附答案版和教师版 PDF。" },
  { t: 2 * Math.PI - PEAK, place: "above", name: "布置", text: "在学生档案里布置作业，一份作业可以分几次交。" },
  { t: 0, place: "right", name: "批改", text: "上传作业照片或 PDF 自动批改，按卷面上印的题号对上原题和答案。" },
  { t: PEAK, place: "below", name: "定档", text: "按知识点和五项能力定档，做错的题进入错题本。" },
];

const DEPLOY = [
  { name: "局域网共享", text: "一台 Mac 就是服务器。同事在同一个网络里用浏览器打开，共用一套题库和讲义。" },
  { name: "账号与权限", text: "用邀请码给同事开账号；删除这类操作只有管理员能做。" },
  { name: "AI 按需接入", text: "在 AI 配置里接入模型服务；不接也能人工录题、浏览题库、生成 Word。" },
];

// The ∞'s way down the page, one leg per pair of shapes: it changes over the stretch of scroll from `start` to `end`
// (shares of the way between the two places where they are whole) and fades by `dip` halfway, where it passes text.
const LEGS = [
  { start: 0.06, end: 1, dip: 0.25 }, // the hero's ∞ opens into the rails of the feature row
  { start: 0.25, end: 0.95, dip: 0.3 }, // the rails close into the track of the loop
  { start: 0.12, end: 0.92, dip: 0.6 }, // the track grows back into the ∞ above the last words
];
const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// The ∞ gathers into the login window, and scatters back into the page when it closes, over this long.
const GATHER_MS = 1800;
const SCATTER_MS = 1300;
// the window's frame of sand, round the outside of its glass (.mp-login-card has the same corner radius)
const FRAME = { radius: 26, halfWidth: 3.5, outset: 7, fill: 0.3 };
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
  const root = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLElement>(null);
  const loop = useRef<HTMLDivElement>(null);
  const loopLine = useRef<SVGPathElement>(null);
  const closing = useRef<HTMLElement>(null);
  const closingArt = useRef<HTMLImageElement>(null);
  const scrolled = useRef(-1);
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

  // Asked by the sculpture every frame: which two shapes it is between, and how far along.
  const scrollForms = (hero: Rect, view: { w: number; h: number }, dt: number): SculptureMorph => {
    const still: SculptureShape = { kind: "image", rect: hero };
    if (!row.current || !loop.current || !closing.current || !closingArt.current) return { from: still, to: still, mix: 0 };
    // the shape trails the scroll a little, so even a flick of the wheel pours rather than jumps
    const y = window.scrollY;
    const eased = scrolled.current < 0 ? y : scrolled.current + (y - scrolled.current) * (1 - Math.pow(0.84, dt));
    const moving = Math.abs(y - eased) > 0.5;
    scrolled.current = moving ? eased : y;
    const band = row.current.getBoundingClientRect(), track = loop.current.getBoundingClientRect();
    const art = closingArt.current.getBoundingClientRect(), end = closing.current.getBoundingClientRect();
    const tile = Math.min(ROW.tile / 100 * band.height, MAX_WIDTH / 100 * band.width / ROW.aspect);
    const bend = ROW.curve * Math.PI / 180;
    const k = track.width / LOOP.w;
    const shapes: SculptureShape[] = [
      still,
      {
        kind: "rails", cx: band.left + band.width / 2, axis: band.top + ROW.axis / 100 * band.height, radius: band.width * arc(bend),
        camera: CAMERA, top: -tile * 0.64, bottom: tile * 0.64, halfWidth: tile * 0.045, edge: bend * 1.04,
        left: band.left, right: band.right, fade: ROW.fade / 100 * band.width,
      },
      { kind: "lemniscate", cx: track.left + LOOP.cx * k, cy: track.top + LOOP.cy * k, a: LOOP.a * k, yScale: 1, halfWidth: 6 * k },
      { kind: "image", rect: { x: art.left, y: art.top, w: art.width, h: art.height } },
    ];
    // where each shape is whole: the page top, the row filling the screen, the loop in the middle, the last screen
    const stops = [0, y + band.top, y + track.top + track.height / 2 - view.h / 2, y + end.top];
    let leg = 0;
    while (leg < LEGS.length - 1 && scrolled.current >= stops[leg + 1]) leg++;
    const along = Math.min(1, Math.max(0, (scrolled.current - stops[leg]) / Math.max(1, stops[leg + 1] - stops[leg])));
    const mix = smoothstep(LEGS[leg].start, LEGS[leg].end, along);
    // the drawn loop gives way while the metal lies on it
    loopLine.current?.style.setProperty("--ribbon", String(leg === 1 ? mix : leg === 2 ? 1 - mix : 0));
    const alpha = 1 - LEGS[leg].dip * Math.sin(Math.PI * mix);
    // the login window: from the shape it has on the page (the scroll stands still meanwhile) into the window's frame
    const now = performance.now(), g = gather.current, e = entry.current;
    if (g.start < 0 && g.to !== g.from) g.start = now;
    if (e.start < 0 && e.to !== e.from) e.start = now;
    const into = gatheredAt(g, now);
    const box = glass.current?.getBoundingClientRect();
    let form: SculptureMorph = { from: shapes[leg], to: shapes[leg + 1], mix, alpha, moving };
    if (into > 0 && box) {
      const frame: SculptureShape = { kind: "window", rect: { x: box.left, y: box.top, w: box.width, h: box.height }, ...FRAME };
      form = {
        from: mix < 0.5 ? shapes[leg] : shapes[leg + 1], to: frame, mix: into,
        alpha: alpha + (1 - alpha) * into, moving: moving || into !== g.to,
      };
    }
    // into the workbench: from that shape into its frame, which reaches twice the screen's height below the top bar so
    // that the lower arcs, laid along its bottom half, pour off the screen
    const out = gatheredAt(e, now, ENTER_MS);
    if (out <= 0) return form;
    const gate: SculptureShape = {
      kind: "window", rect: { x: e.left, y: e.top, w: view.w - e.left - e.right, h: 2 * (view.h - e.top) }, ...GATE,
    };
    const was = form.alpha ?? 1;
    return { from: form.mix < 0.5 ? form.from : form.to, to: gate, mix: out, alpha: was + (1 - was) * out, moving: form.moving || out !== e.to };
  };

  return <div ref={root} className="mp-intro" data-mode={mode ?? undefined} data-login={login ? (login.leaving ? "out" : "in") : undefined}
    data-opened={opened !== undefined ? "" : undefined} data-entering={entering ? "" : undefined}>
    <SculptureHero
      src={picture("light")} darkSrc={picture("dark")}
      mobileSrc={picture("light")} mobileDarkSrc={picture("dark")}
      imageAlt="金属丝带与微粒组成的无穷符号 ∞"
      brand={<BrandWordmark />}
      navLinks={[{ label: "功能", href: "#features" }, { label: "闭环", href: "#loop" }, { label: "部署", href: "#deploy" }]}
      navCta={{ label: "进入工作台", href: workbench }}
      eyebrow="MathPilot — 数学教研工作台"
      headline={"教与学，\n循环不息。"}
      headlineAccent="循环不息。"
      body="题库、讲义、作业批改和学生档案连成一个闭环：每一次批改的结果，都会回到下一次备课里。"
      primaryCta={{ label: "进入工作台", href: workbench }}
      secondaryCta={{ label: "看看这个闭环", href: "#loop" }}
      hint="移动鼠标，拨动这道 ∞"
      hintTouch="触碰这道 ∞"
      backdropText="教学"
      sculptureScale={0.86}
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

    <section ref={row} id="features" className="mp-showcase">
      <TiltedGridHero className="mp-row" images={CARDS} speed={4} tileHeight={ROW.tile} aspectRatio={ROW.aspect} gap={6}
        axis={ROW.axis} curve={ROW.curve} fade={ROW.fade}>
        <header className="mp-head mp-reveal">
          <p className="mp-kicker">01 功能</p>
          <div><h2>一个工作台，<br /><em>装下数学教研的日常。</em></h2></div>
        </header>
        <ul className="mp-hidden">
          {FEATURES.map((feature) => <li key={feature.file}>{feature.name}：{feature.text}</li>)}
        </ul>
      </TiltedGridHero>
    </section>

    <section id="loop" className="mp-section">
      <header className="mp-head mp-reveal">
        <p className="mp-kicker">02 闭环</p>
        <div>
          <h2>左边是教，<em>右边是学。</em></h2>
          <p className="mp-lead">两个环在学情报告处相交：<br />学生做过的每一道题，都会带着批改结果回到下一轮备课。</p>
        </div>
      </header>
      <div ref={loop} className="mp-loop mp-reveal">
        <svg viewBox={`0 0 ${LOOP.w} ${LOOP.h}`} aria-hidden="true">
          <text className="mp-loop-glyph" x={LOOP.cx - LOOP.a * 0.58} y={LOOP.cy}>教</text>
          <text className="mp-loop-glyph" x={LOOP.cx + LOOP.a * 0.58} y={LOOP.cy}>学</text>
          <path ref={loopLine} className="mp-loop-line" d={LOOP_PATH} />
          <line className="mp-loop-leader" x1={LOOP.cx} y1={LOOP.cy + 18} x2={LOOP.cx} y2={REPORT_Y - 14} />
          {STEPS.map((step) => { const [x, y] = onLoop(step.t); return <circle key={step.name} className="mp-loop-node" cx={x} cy={y} r={7} />; })}
          <circle className="mp-loop-cross" cx={LOOP.cx} cy={LOOP.cy} r={9} />
          <circle className="mp-loop-runner" r={5}><animateMotion dur="18s" repeatCount="indefinite" path={LOOP_PATH} /></circle>
        </svg>
        <ol className="mp-steps">
          {STEPS.map((step, index) => {
            const [x, y] = onLoop(step.t);
            return <li key={step.name} className={`mp-step is-${step.place}`} style={{ left: percent(x, LOOP.w), top: percent(y, LOOP.h) }}>
              <span className="mp-step-no">{number(index)}</span><strong>{step.name}</strong><span className="mp-step-text">{step.text}</span>
            </li>;
          })}
          <li className="mp-step is-center" style={{ left: "50%", top: percent(REPORT_Y, LOOP.h) }}>
            <span className="mp-step-no">∞</span><strong>学情报告</strong><span className="mp-step-text">汇总每个学生的强项和薄弱处，带回下一轮组卷。</span>
          </li>
        </ol>
      </div>
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
      {/* the sculpture comes to rest here; without WebGL this picture stands in for it */}
      {/* eslint-disable-next-line @next/next/no-img-element -- a stand-in the canvas draws over at the same place */}
      <img ref={closingArt} className="mp-closing-art" src={picture(shade)} alt="" />
      <h2 className="mp-reveal">从下一份作业<em>开始。</em></h2>
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
