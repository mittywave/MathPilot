"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- vinext beta currently breaks next/link RSC prefetch on client-only pages */
import { useEffect, useRef, useState } from "react";
import SculptureHero from "../components/LiquidSculptureHero";
import { BrandWordmark } from "../components/SiteHeader";
import "./intro.css";

// MathPilot product page. The hero is the liquid particle sculpture, here the ∞ of the tab icon (the images come from
// scripts/intro-infinity.html); the sections below follow the hero's light/dark switch.

const SANS = '"Helvetica Neue", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
const SERIF = '"Songti SC", "STSong", "Noto Serif SC", "Source Han Serif SC", serif';

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

const FEATURES = [
  { name: "共享题库", text: "按模块和分类整理题目，题干、答案、解析放在一起；勾进组卷篮，一键生成 Word。" },
  { name: "讲义编撰", text: "所见即所得地写讲义，公式和图形直接排进 PDF；分页时标题不落单，题目不拆页。" },
  { name: "知识图谱", text: "课程大纲和知识点连成一张图，每节课的讲义、小测和作业都有自己的位置。" },
  { name: "学生档案", text: "每个学生一份档案：布置过的作业、错题本、定档和学情报告都在这里。" },
  { name: "作业批改", text: "上传学生拍好的作业照片或 PDF，自动批改，可以写入错题本和定档。" },
  { name: "文件转录", text: "把题目或答案的照片、PDF 转成可编辑的 Word：只放原题得到题目，加上答案得到解析。" },
];

const DEPLOY = [
  { name: "局域网共享", text: "一台 Mac 就是服务器。同事在同一个网络里用浏览器打开，共用一套题库和讲义。" },
  { name: "账号与权限", text: "用邀请码给同事开账号；删除这类操作只有管理员能做。" },
  { name: "AI 按需接入", text: "在 AI 配置里接入模型服务；不接也能人工录题、浏览题库、生成 Word。" },
];

const number = (index: number) => String(index + 1).padStart(2, "0");

function Arrow() {
  return <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <path d="M2 7h10M8 3l4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

export default function IntroPage() {
  const [mode, setMode] = useState<"light" | "dark">("light");
  const root = useRef<HTMLDivElement>(null);
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

  return <div ref={root} className="mp-intro" data-mode={mode}>
    <SculptureHero
      src="/intro-infinity-light.webp" darkSrc="/intro-infinity-dark.webp"
      mobileSrc="/intro-infinity-light.webp" mobileDarkSrc="/intro-infinity-dark.webp"
      imageAlt="金属丝带与微粒组成的无穷符号 ∞"
      brand={<BrandWordmark />}
      navLinks={[{ label: "闭环", href: "#loop" }, { label: "功能", href: "#features" }, { label: "部署", href: "#deploy" }]}
      navCta={{ label: "进入工作台", href: "/" }}
      eyebrow="MathPilot — 数学教研工作台"
      headline={"教与学，\n循环不息。"}
      headlineAccent="循环不息。"
      body="题库、讲义、作业批改和学生档案连成一个闭环：每一次批改的结果，都会回到下一次备课里。"
      primaryCta={{ label: "进入工作台", href: "/" }}
      secondaryCta={{ label: "看看这个闭环", href: "#loop" }}
      hint="移动鼠标，拨动这道 ∞"
      hintTouch="触碰这道 ∞"
      backdropText="教学"
      sculptureScale={0.86}
      theme={mode}
      onThemeChange={setMode}
      accentColor={mode === "dark" ? "#9DBFAA" : "#3E5E4C"}
      headingFont={SANS}
      accentFont={SERIF}
      bodyFont={SANS}
      loadFonts={false}
    />

    <section id="loop" className="mp-section">
      <header className="mp-head mp-reveal">
        <p className="mp-kicker">01 闭环</p>
        <div>
          <h2>左边是教，<em>右边是学。</em></h2>
          <p className="mp-lead">两个环在学情报告处相交：<br />学生做过的每一道题，都会带着批改结果回到下一轮备课。</p>
        </div>
      </header>
      <div className="mp-loop mp-reveal">
        <svg viewBox={`0 0 ${LOOP.w} ${LOOP.h}`} aria-hidden="true">
          <text className="mp-loop-glyph" x={LOOP.cx - LOOP.a * 0.58} y={LOOP.cy}>教</text>
          <text className="mp-loop-glyph" x={LOOP.cx + LOOP.a * 0.58} y={LOOP.cy}>学</text>
          <path className="mp-loop-line" d={LOOP_PATH} />
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

    <section id="features" className="mp-section">
      <header className="mp-head mp-reveal">
        <p className="mp-kicker">02 功能</p>
        <div><h2>一个工作台，<br /><em>装下数学教研的日常。</em></h2></div>
      </header>
      <ol className="mp-grid">
        {FEATURES.map((feature, index) => <li key={feature.name} className="mp-cell mp-reveal" style={{ transitionDelay: `${(index % 3) * 90}ms` }}>
          <span className="mp-cell-no">{number(index)}</span><h3>{feature.name}</h3><p>{feature.text}</p>
        </li>)}
      </ol>
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
      <h2 className="mp-reveal">从下一份作业<em>开始。</em></h2>
      <a className="mp-btn" href="/">进入工作台<Arrow /></a>
    </section>

    <footer className="mp-foot">
      <BrandWordmark /><span>数学教研工作台</span><span>© 2026 MathPilot</span>
    </footer>
  </div>;
}
