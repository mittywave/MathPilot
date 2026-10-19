"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import SculptureHero, { type Rect, type SculptureMorph, type SculptureShape } from "../components/LiquidSculptureHero";
import TiltedGridHero from "../components/TiltedGridHero";
import WorksWheel from "../components/WorksWheel";
import { BrandWordmark } from "../components/SiteHeader";
import { LoginForm } from "../components/LoginForm";
import { fetchMe, loginPath } from "../../lib/api-client";
import { saveAppearance } from "../../lib/appearance";
import FormulaSand from "./FormulaSand";
import "./intro.css";

// MathPilot product page, the site's home. The hero is the liquid particle sculpture, the ∞ of the tab icon (the
// pictures come from scripts/intro-infinity.html), beside the opening words. It stays where the page puts it: it
// leaves with the hero and is back above the last words. In between, the teaching loop turns as a wheel and the app's screens stream past in a
// curved row.
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
const ROW = { tile: 30, aspect: 16 / 9, axis: 60, curve: 80, fade: 12 };

// The teaching loop, turned as a wheel: the page's scroll brings the seven steps to the front one by one, each with its
// name and line beside it, and at the end they close into a ring round 教与学. A card is the step's name set large in
// the ∞'s metal.
const STEPS = [
  { demo: "intake", no: "01", name: "入库", short: "入库", text: "照片、PDF、Word 转成可编辑的题目，每道题一个永久编号。" },
  { demo: "paper", no: "02", name: "组卷", short: "组卷", text: "从题库勾选，或者说一句要什么练习，按学生档案挑题、按天排好。" },
  { demo: "handout", no: "03", name: "讲义", short: "讲义", text: "所见即所得地编讲义，排成学生版、附答案版和教师版 PDF。" },
  { demo: "assign", no: "04", name: "布置", short: "布置", text: "在学生档案里布置作业，一份作业可以分几次交。" },
  { demo: "grading", no: "05", name: "批改", short: "批改", text: "上传作业照片或 PDF 自动批改，按卷面上印的题号对上原题和答案。" },
  { demo: "profile", no: "06", name: "定档", short: "定档", text: "按知识点和五项能力定档，做错的题进入错题本。" },
  { demo: "report", no: "∞", name: "学情报告", short: "学情", text: "汇总每个学生的强项和薄弱处，带回下一轮组卷。" },
];
const REDUCE = "(prefers-reduced-motion: reduce)";
const followMotion = (changed: () => void) => {
  const query = window.matchMedia(REDUCE);
  query.addEventListener("change", changed);
  return () => query.removeEventListener("change", changed);
};
const motionReduced = () => window.matchMedia(REDUCE).matches;
const stepFace = (step: (typeof STEPS)[number]) =>
  <span className="mp-step-face"><span className="mp-step-face-no">{step.no}</span><span className="mp-step-face-name">{step.short}</span></span>;

// A step's demo: a drawn walk-through of doing it (scripts/intro-loop-demos.html, rendered by
// scripts/render-intro-loop.mjs). It opens and closes on the card's face, so it lies over the face and only the card
// at the front plays; its neighbours fetch the start, the rest are not loaded. Reduced motion leaves it paused.
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
    if (!front) el.currentTime = 0; // back on the face, the frame it opens on
  }, [playing, front, mode]);
  if (!near) return stepFace(step);
  return <>
    {stepFace(step)}
    <video ref={video} key={mode} className="mp-step-demo" src={`/intro/loop/${step.demo}-${mode}.mp4`} muted loop playsInline
      preload={front ? "auto" : "metadata"} aria-hidden="true" />
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
  const [front, setFront] = useState(0);
  const wheel = STEPS.map((step, i) => ({
    title: step.name,
    text: step.text,
    face: <StepDemo step={step} front={i === front} near={Math.abs(i - front) <= 1} mode={shade} />,
  }));
  const root = useRef<HTMLDivElement>(null);
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

  // Asked by the sculpture every frame: which two shapes it is between, and how far along. On the page the ∞ stays where
  // the page puts it: it scrolls away with the hero, and the one above the last words scrolls in with them. It is the
  // hero's until the page is nearer the last words, both out of sight where that changes, and while neither is on the
  // screen the sculpture rests.
  const scrollForms = (hero: Rect, view: { w: number; h: number }): SculptureMorph => {
    const art = closingArt.current?.getBoundingClientRect();
    const middle = (top: number, height: number) => Math.abs(top + height / 2 - view.h / 2);
    const place: SculptureShape = art && middle(art.top, art.height) < middle(hero.y, hero.h)
      ? { kind: "image", rect: { x: art.left, y: art.top, w: art.width, h: art.height } }
      : { kind: "image", rect: hero };
    // drawn every frame while the page scrolls, so it keeps step with the page
    const moving = window.scrollY !== scrolled.current;
    scrolled.current = window.scrollY;
    // the login window: from the shape it has on the page (the page stands still meanwhile) into the window's frame
    const now = performance.now(), g = gather.current, e = entry.current;
    if (g.start < 0 && g.to !== g.from) g.start = now;
    if (e.start < 0 && e.to !== e.from) e.start = now;
    const into = gatheredAt(g, now);
    const out = gatheredAt(e, now, ENTER_MS);
    // out of sight, and not on its way into a window or back (stirred grains stray a little past the picture)
    const { x, y, w, h } = place.rect;
    const away = !g.to && !e.to && !into && !out && (y + h * 1.1 < 0 || y - h * 0.1 > view.h || x + w < 0 || x > view.w);
    const box = glass.current?.getBoundingClientRect();
    let form: SculptureMorph = { from: place, to: place, mix: 0, moving, away };
    if (into > 0 && box) {
      const frame: SculptureShape = { kind: "window", rect: { x: box.left, y: box.top, w: box.width, h: box.height }, ...FRAME };
      form = { from: place, to: frame, mix: into, moving: moving || into !== g.to };
    }
    // into the workbench: from that shape into its frame, which reaches twice the screen's height below the top bar so
    // that the lower arcs, laid along its bottom half, pour off the screen
    if (out <= 0) return form;
    const gate: SculptureShape = {
      kind: "window", rect: { x: e.left, y: e.top, w: view.w - e.left - e.right, h: 2 * (view.h - e.top) }, ...GATE,
    };
    return { from: form.mix < 0.5 ? form.from : form.to, to: gate, mix: out, moving: form.moving || out !== e.to };
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

    <WorksWheel id="loop" className="mp-wheel" label="教与学" items={wheel} onFront={setFront}>
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

    <section className="mp-closing">
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
