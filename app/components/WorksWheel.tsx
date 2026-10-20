"use client";

// A portfolio index built as a wheel you turn.
//
// The work hangs on a vertical drum: the card at the front lies flat and full
// size, the ones above and below rotate away into hard perspective and run off
// the top and bottom of the frame. Scrolling carries the next piece round to the
// front, and past the last one the drum closes into a ring around a title, each
// card tangent to the circle, the first at the top.
//
// The whole thing is one number - `turn` - read by a rAF pass that writes
// transforms straight to the DOM. 0 is the drum with item 0 at the front, every
// whole number after that is one more item turned past, and one past the last
// item is the ring.
//
// Taken from crafterui's Works Wheel (21st.dev) with local changes:
// - `cn` is inlined (the app has no shadcn utils), and shadcn's colour tokens give
//   way to the colour the wheel is set in.
// - The page's scroll turns the wheel, in place of the wheel catching the mouse
//   wheel, drags and arrow keys, so the page never stalls: the section is as tall
//   as the turns need, the stage stays pinned to the screen meanwhile, and each
//   item rests at the front for a stretch. The index scrolls the page there.
// - The ring comes last instead of first: the wheel opens on the drum and closes
//   into the ring, each card taking the short way round to its place. The drum
//   turns with the page: the next card comes up from below as the page scrolls on.
// - The frame loop rests while the wheel stands still, and the ring shrinks to
//   fit the stage (a few items make big cards).
// - An item may bring its own card face (`face`) and a line under its title
//   (`text`). `children` are pinned with the stage, which carries `--wheel-open`
//   (0 the ring, 1 the drum) and `--wheel-turn` (the turn itself) for them.
import * as React from "react";

const cn = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");

export interface WorksWheelItem {
  /** Project name. Shown beside the front card and in the index. */
  title: string;
  /** Cover art. Any src an <img> takes. */
  image?: string;
  /** Drawn on the card in place of `image`. */
  face?: React.ReactNode;
  /** A line under the title beside the front card. */
  text?: string;
  /** Where the card links to. Omit for a wheel that only browses. */
  href?: string;
}

export interface WorksWheelProps extends React.ComponentPropsWithoutRef<"section"> {
  items: WorksWheelItem[];
  /** Sits in the middle of the ring. @default undefined */
  label?: string;
  /** Label on the card's hover affordance. Omit to drop it. @default undefined */
  action?: string;
  /** Told which item rests at the front, once the wheel has come to a stop there; -1 while it turns or is a ring. */
  onFront?: (index: number) => void;
}

/* Geometry. The card is measured against the stage; everything else is measured
   against the card, so a narrow stage - where the card is capped by width, not
   height - scales the whole wheel down with it instead of leaving a small card
   swinging on a huge drum. The three that matter are tuned together: STEP
   against DRUM sets how hard the neighbours rotate away, and DRUM against LENS
   decides whether they land inside the frame or run off it. */
const CARD_H = 0.49; // front card height, of the stage
const CARD_MAX_W = 0.44; // ... but never wider than this much of the stage
const CARD_RATIO = 1.45; // card width / height
const STEP = 40; // degrees between cards on the drum
const DRUM = 2.22; // drum radius, in card heights - and everything below likewise
const LENS = 2.7; // perspective distance
const RING_R = 1.14; // ring radius
const RING_FIT = 0.86; // ... its outer edge kept within this much of half the stage's height
/* The drum alone hangs the work on a plumb line. It isn't one: the strip curves
   away round an arc whose centre sits off to the LEFT, so the piece at the front
   is at the arc's near point - dead centre - and its neighbours have already
   swung back left as well as up and down. BOW is that arc's radius; nothing else
   makes the difference between a stack of cards and a wheel seen side on. */
const BOW = 1.82;
const TITLE = 0.124; // ring label and front-card title
const TEXT = 0.05; // the line under the front-card title
const INDEX = 0.04; // the index down the right-hand side
/** Items either side of the front still worth drawing. Past this a card is
    edge-on, and further round it would stack up on the vanishing point. */
const CULL = 1.6;

/** Screen heights of scrolling for each item turned past, and the share of that
    stretch an item rests at the front before the next one comes round. */
const TRACK = 0.55;
const REST = 0.45;
/** Fraction of the remaining distance closed each frame. 1 = no smoothing. */
const EASE = 0.12;

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

type Stage = { w: number; h: number };

const rad = (deg: number) => (deg * Math.PI) / 180;

/** How far left the arc has carried something that has turned `drumDeg` off the
    front. Zero at the front, so the piece being read stays centred. */
const bowAt = (drumDeg: number, bow: number) =>
  -bow * (1 - Math.cos(rad(drumDeg)));

/** Both states in one chain: the ring terms fall away as `m` reaches the drum,
    and the drum terms are still zero while the ring is up. The bow is applied
    first, in the wheel's own plane, so it slides the card sideways rather than
    turning with it - and perspective still shrinks it with distance. */
function place(
  ringDeg: number,
  drumDeg: number,
  ringR: number,
  drumR: number,
  bow: number,
  m: number,
) {
  return (
    `translateX(${m * bowAt(drumDeg, bow)}px)` +
    ` rotateZ(${(1 - m) * ringDeg}deg) translateY(${-(1 - m) * ringR}px)` +
    ` rotateX(${m * drumDeg}deg) translateZ(${m * drumR}px)`
  );
}

export function WorksWheel({
  items,
  label = "Works '26",
  action = "View",
  onFront,
  className,
  style,
  children,
  ...props
}: WorksWheelProps) {
  const sectionRef = React.useRef<HTMLElement>(null);
  const stageRef = React.useRef<HTMLDivElement>(null);
  const wheelRef = React.useRef<HTMLDivElement>(null);
  const cardRefs = React.useRef<(HTMLElement | null)[]>([]);
  const labelRef = React.useRef<HTMLDivElement>(null);
  const titleRef = React.useRef<HTMLDivElement>(null);

  // The wheel's position, and where it is heading. Only `active` is state -
  // everything else is written to the DOM, so turning the wheel is not a render.
  const turn = React.useRef(0);
  const target = React.useRef(0);
  const kick = React.useRef(() => {});
  const [active, setActive] = React.useState(0);
  const [stage, setStage] = React.useState<Stage>({ w: 0, h: 0 });

  const onFrontRef = React.useRef(onFront);
  React.useEffect(() => { onFrontRef.current = onFront; }, [onFront]);
  const resting = React.useRef(-1);

  const count = items.length;
  const last = Math.max(count - 1, 0);

  // Read after mount, not during render: the server has no matchMedia, and
  // branching on it inline is a hydration mismatch. Reduced motion drops the
  // easing, so the wheel lands where it is put instead of gliding there.
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const read = () => setReduced(query.matches);
    read();
    query.addEventListener("change", read);
    return () => query.removeEventListener("change", read);
  }, []);

  React.useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const read = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const metrics = React.useMemo(() => {
    const { w, h } = stage;
    const cardW = Math.min(h * CARD_H * CARD_RATIO, w * CARD_MAX_W);
    const cardH = cardW / CARD_RATIO;
    const drumR = cardH * DRUM;
    // Shrink the ring's cards until the circle reads as a closed loop rather
    // than beads on a wire, however many pieces the wheel is given - and the
    // ring itself until it fits the stage, cards and all.
    const scaleAt = (r: number) =>
      count ? clamp((((2 * Math.PI * r) / count) * 0.82) / (cardW || 1), 0.16, 1) : 1;
    let ringR = cardH * RING_R;
    const reach = ringR + (cardH * scaleAt(ringR)) / 2;
    if (reach > (h / 2) * RING_FIT) ringR *= ((h / 2) * RING_FIT) / reach;
    const ringScale = scaleAt(ringR);
    return {
      cardW,
      cardH,
      ringR,
      ringScale,
      drumR,
      bow: cardH * BOW,
      depth: cardH * LENS,
      title: cardH * TITLE,
      text: cardH * TEXT,
      index: cardH * INDEX,
      // the room left of the front card for its title, from 8% in
      aside: Math.max(0, (w - cardW) / 2 - w * 0.08 - cardH * 0.12),
    };
  }, [stage, count]);

  // Ease toward the target, then write every transform; frames keep coming
  // until the wheel has arrived, and the scroll asks for them again.
  React.useEffect(() => {
    if (!stage.h) return;
    let frame = 0;
    const { ringR, ringScale, drumR, bow } = metrics;

    const draw = () => {
      frame = 0;
      const gap = target.current - turn.current;
      if (Math.abs(gap) < 0.0005) turn.current = target.current;
      else turn.current += gap * (reduced ? 1 : EASE);

      // the drum first, then the ring: m is 1 on the drum and 0 in the ring
      const t = turn.current;
      const pos = Math.min(t, last);
      const m = 1 - clamp(t - last, 0, 1);

      // The drum is pulled back so its front face lands on the picture plane.
      // That set-back has to arrive with the drum, or the ring would sit at the
      // far side of the perspective and render at half its size.
      if (wheelRef.current) {
        wheelRef.current.style.transform = `translateZ(${-m * drumR}px)`;
      }

      for (let i = 0; i < count; i++) {
        const d = i - pos;
        // the next ones wait below the front and come up as the page scrolls down
        const drumDeg = -d * STEP;
        const card = cardRefs.current[i];
        if (card) {
          card.style.transform = place(
            // round the ring from the top, item 0 first
            (((i * 360) / count + 180) % 360) - 180,
            drumDeg,
            ringR,
            drumR,
            bow,
            m,
          );
          // Culled by distance, not by angle: at a full turn the far side comes
          // back round to face us, and everything past the neighbours lands on
          // the vanishing point in a heap.
          card.style.opacity = m > 0.5 && Math.abs(d) > CULL ? "0" : "1";
          card.style.zIndex = String(Math.round(100 - Math.abs(d) * 2));
        }
        const face = card?.firstElementChild as HTMLElement | null;
        if (face) face.style.transform = `scale(${lerp(ringScale, 1, m)})`;
      }

      if (labelRef.current) labelRef.current.style.opacity = String(1 - m);
      if (titleRef.current) titleRef.current.style.opacity = String(m);
      stageRef.current?.parentElement?.style.setProperty("--wheel-open", m.toFixed(3));
      stageRef.current?.parentElement?.style.setProperty("--wheel-turn", t.toFixed(4));
      const near = clamp(Math.round(pos), 0, last);
      setActive((prev) => (prev === near ? prev : near));
      // at rest, and only while the section is pinned on screen
      const box = sectionRef.current?.getBoundingClientRect();
      const pinned = !!box && box.top <= 1 && box.bottom >= window.innerHeight - 1;
      const still = pinned && m > 0.99 && Math.abs(pos - near) < 0.04 ? near : -1;
      if (still !== resting.current) onFrontRef.current?.((resting.current = still));
      if (turn.current !== target.current) frame = requestAnimationFrame(draw);
    };

    kick.current = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    draw();
    return () => {
      cancelAnimationFrame(frame);
      kick.current = () => {};
    };
  }, [metrics, stage.h, count, last, reduced]);

  // How far down its section the page is, as a turn: a stretch per item, each
  // resting at the front before the next turns round, then the ring.
  React.useEffect(() => {
    const section = sectionRef.current;
    if (!section) return;
    const read = () => {
      const box = section.getBoundingClientRect();
      const run = Math.max(1, box.height - window.innerHeight);
      const along = clamp(-box.top / run, 0, 1) * (last + 1);
      const whole = Math.floor(along);
      target.current = Math.min(last + 1, whole + smooth(REST / 2, 1 - REST / 2, along - whole));
      kick.current();
    };
    read();
    window.addEventListener("scroll", read, { passive: true });
    window.addEventListener("resize", read);
    return () => {
      window.removeEventListener("scroll", read);
      window.removeEventListener("resize", read);
    };
  }, [last]);

  // The index scrolls the page to where its item rests at the front.
  const show = (i: number) => {
    const section = sectionRef.current;
    if (!section) return;
    const box = section.getBoundingClientRect();
    const run = Math.max(1, box.height - window.innerHeight);
    window.scrollTo({ top: window.scrollY + box.top + (i / (last + 1)) * run, behavior: reduced ? "instant" : "smooth" });
  };

  const current = items[active];

  return (
    <section
      ref={sectionRef}
      aria-label={label}
      className={cn("relative w-full", className)}
      style={{ height: `calc(100svh + ${(last + 1) * TRACK * 100}svh)`, ...style }}
      {...props}
    >
      <div className="sticky top-0 h-svh w-full overflow-hidden select-none">
        <div
          ref={stageRef}
          className="absolute inset-0"
          style={{ perspective: `${metrics.depth}px` }}
        >
          <div
            ref={wheelRef}
            className="absolute top-1/2 left-1/2 [transform-style:preserve-3d]"
          >
            {items.map((item, i) => {
              const Tag = (item.href ? "a" : "div") as "a";
              return (
                <Tag
                  key={item.title}
                  href={item.href}
                  ref={(node: HTMLElement | null) => {
                    cardRefs.current[i] = node;
                  }}
                  className="group absolute [backface-visibility:hidden]"
                  style={{
                    width: metrics.cardW,
                    height: metrics.cardH,
                    marginLeft: -metrics.cardW / 2,
                    marginTop: -metrics.cardH / 2,
                  }}
                >
                  <span className="relative block size-full overflow-hidden rounded-lg bg-[color-mix(in_srgb,currentColor_6%,transparent)] shadow-[0_18px_40px_-18px_color-mix(in_srgb,currentColor_24%,transparent)]">
                    {item.face ?? (item.image ? (
                      // eslint-disable-next-line @next/next/no-img-element -- cover art at the card's own size
                      <img
                        src={item.image}
                        alt={item.title}
                        draggable={false}
                        className="size-full object-cover"
                      />
                    ) : null)}
                    {item.face || !item.image ? <span className="sr-only">{item.title}</span> : null}
                    {item.text ? <span className="sr-only">{item.text}</span> : null}
                    {action && item.href ? (
                      <span className="pointer-events-none absolute right-3 bottom-3 flex translate-y-1 items-center gap-1 rounded-full bg-[color-mix(in_srgb,Canvas_80%,transparent)] px-2.5 py-1 text-[0.7rem] opacity-0 backdrop-blur-sm transition group-hover:translate-y-0 group-hover:opacity-100">
                        <svg
                          viewBox="0 0 12 12"
                          className="size-2.5"
                          aria-hidden="true"
                        >
                          <path
                            d="M3 9 9 3M4 3h5v5"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.4"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                        {action}
                      </span>
                    ) : null}
                  </span>
                </Tag>
              );
            })}
          </div>
        </div>

        {/* Ring title and front-card title trade places across the transition.
            Type is sized off the measured stage, not vh, so the wheel keeps its
            proportions inside a card as well as at full bleed. */}
        <div
          ref={labelRef}
          aria-hidden="true"
          className="works-wheel-label pointer-events-none absolute inset-0 grid place-items-center tracking-tight"
          style={{ fontSize: metrics.title }}
        >
          {label}
        </div>
        <div
          ref={titleRef}
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-[8%] -translate-y-1/2 opacity-0"
          style={{ width: metrics.aside }}
        >
          <div className="works-wheel-title tracking-tight" style={{ fontSize: metrics.title }}>
            {current?.title}
          </div>
          {current?.text ? (
            <p className="works-wheel-text" style={{ fontSize: metrics.text }}>
              {current.text}
            </p>
          ) : null}
        </div>

        <ol
          className="works-wheel-index absolute top-[7.5%] right-[2.5%] text-right leading-[1.75]"
          style={{ fontSize: metrics.index }}
        >
          {items.map((item, i) => (
            <li key={item.title}>
              <button
                type="button"
                onClick={() => show(i)}
                className={cn(
                  "cursor-pointer opacity-55 transition-opacity outline-none hover:opacity-100 focus-visible:outline-1 focus-visible:outline-current",
                  i === active && "font-medium opacity-100",
                )}
              >
                {item.title}
              </button>
            </li>
          ))}
        </ol>
        {children}
      </div>
    </section>
  );
}

export default WorksWheel;
