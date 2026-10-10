// Canvas 2D point cloud after withmarble.com/curriculum: a hand-written perspective
// projection of the grade funnel, painter-sorted dots, faint batched edges and a
// highlighted lineage. One canvas for any number of nodes — no WebGL, no per-node DOM.
// Selecting a node lifts its whole chain out of the funnel into a flat, labelled diagram
// (prerequisites below, successors above) that fills the free part of the screen.

export type CloudNode = {
  key: string;
  level: "topic" | "point";
  x: number; y: number; z: number;
  size: number;
  color: string;
  ghost: boolean;
  faint: boolean;
  glow: boolean;
};
export type CloudEdge = { source: number; target: number; soft: boolean };
export type CloudBand = { label: string; y0: number; y1: number };
export type CloudModel = { nodes: CloudNode[]; labels: string[]; edges: CloudEdge[]; bands: CloudBand[]; height: number; radius: { base: number; top: number } };
export type CloudHighlight = {
  focus: number;
  upstream: Set<number>;
  next: Set<number>;
  marked: Set<number>;
  labels: number[];
  linkSource: number;
};
// Ranked rows from the bottom (earliest prerequisites) to the top (furthest successors); `up` marks
// relations on the prerequisite side. Shortcuts are relations already implied by a longer route.
export type CloudChain = {
  focus: number;
  levels: Array<{ rank: number; nodes: number[] }>;
  edges: Array<{ source: number; target: number; up: boolean }>;
  shortcuts: Array<{ source: number; target: number; up: boolean }>;
};
export type CloudInsets = { top: number; right: number; bottom: number; left: number };
type Camera = { rot: number; tilt: number; zoom: number; centerY: number } & CloudInsets;
type Callbacks = {
  onHover: (index: number, point: { x: number; y: number; radius: number } | null) => void;
  onPick: (index: number) => void;
};
type Area = { left: number; top: number; right: number; bottom: number };

const FOV = 1400;
const SPIN = 0.00018;
const GROW_MS = 2800;
const GROW_FADE = 260;
const TWEEN = 0.12;
const IDLE_AFTER_INPUT = 3500;
const DEFAULT_TILT = -0.3;
const TILT_MIN = -1.1;
const TILT_MAX = 0.15;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
const CHAIN_MS = 650;
const ROW_PITCH = 46;
const LINE_PITCH = 30;
const LABEL_GAP = 8;
const NODE_GAP = 28;
const MARGIN = 26;
const EDGE = "150,165,205";
const INK = "#edeff7";
const MUTED = "#aab1c6";
const SOFT = "#c6cbdb";
const HALO = "rgba(10,12,20,.88)";
const SHADOW = "rgb(8,10,18)";
const FONT = "\"PingFang SC\",\"Microsoft YaHei\",system-ui,sans-serif";

const EMPTY_HIGHLIGHT: CloudHighlight = { focus: -1, upstream: new Set(), next: new Set(), marked: new Set(), labels: [], linkSource: -1 };
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const lerp = (from: number, to: number, amount: number) => from + (to - from) * amount;
const ease = (value: number) => value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2;

export class CloudRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly callbacks: Callbacks;
  private model: CloudModel | null = null;
  private highlight: CloudHighlight = EMPTY_HIGHLIGHT;
  private width = 0;
  private height = 0;
  private ratio = 1;
  private camera: Camera = { rot: 0.35, tilt: DEFAULT_TILT, zoom: 1, centerY: 0, top: 0, right: 0, bottom: 0, left: 0 };
  private target: Camera = { ...this.camera };
  // Funnel projection of every node.
  private sx = new Float32Array(0);
  private sy = new Float32Array(0);
  private scale = new Float32Array(0);
  private depth = new Float32Array(0);
  private radius = new Float32Array(0);
  private alpha = new Float32Array(0);
  private order: number[] = [];
  // Where each node is actually drawn (funnel, chain, or in between) and how much it belongs to the chain.
  private posX = new Float32Array(0);
  private posY = new Float32Array(0);
  private posR = new Float32Array(0);
  private posC = new Float32Array(0);
  private fromX = new Float32Array(0);
  private fromY = new Float32Array(0);
  private fromR = new Float32Array(0);
  private fromC = new Float32Array(0);
  // The chain diagram, in its own coordinates (y grows upward), and how it is placed on screen.
  private chain: CloudChain | null = null;
  private shown: CloudChain | null = null;
  private member = new Uint8Array(0);
  private chainX = new Float32Array(0);
  private chainY = new Float32Array(0);
  private chainR = new Float32Array(0);
  private chainLabelWidth = new Float32Array(0);
  private chainText: string[] = [];
  private chainRows: Array<{ rank: number; y: number; top: number }> = [];
  private chainBounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  private chainView = { x: 0, y: 0, scale: 1 };
  private chainArea: Area = { left: 0, top: 0, right: 0, bottom: 0 };
  private chainGutter = 70;
  private chainPresence = 0;
  private presenceFrom = 0;
  private morphStart = 0;
  private morphMs = 0;
  private drawn = false;
  private density = 1;
  private hover = -1;
  private hoverPoint: { x: number; y: number } | null = null;
  private insetsReady = false;
  private pointer: { x: number; y: number } | null = null;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private drag: { x: number; y: number; rot: number; tilt: number; viewX: number; viewY: number; moved: number } | null = null;
  private pinch: { distance: number; zoom: number; scale: number; x: number; y: number; viewX: number; viewY: number } | null = null;
  private lastInput = 0;
  private growStart: number | null = null;
  private frame = 0;
  private wake = 0;
  private lastTime = 0;
  private spinEnabled = true;
  private reducedMotion = false;
  private readonly motionQuery: MediaQueryList | null;
  private readonly observer: ResizeObserver;

  constructor(canvas: HTMLCanvasElement, callbacks: Callbacks) {
    this.canvas = canvas; this.callbacks = callbacks;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前浏览器不支持画布");
    this.context = context;
    this.motionQuery = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    this.reducedMotion = Boolean(this.motionQuery?.matches);
    this.motionQuery?.addEventListener("change", this.onMotionChange);
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerCancel);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(canvas);
    this.resize();
  }

  destroy() {
    cancelAnimationFrame(this.frame); this.frame = 0; window.clearTimeout(this.wake);
    this.observer.disconnect();
    this.motionQuery?.removeEventListener("change", this.onMotionChange);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    this.canvas.removeEventListener("pointermove", this.onPointerMove);
    this.canvas.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("pointercancel", this.onPointerCancel);
    this.canvas.removeEventListener("pointerleave", this.onPointerLeave);
    this.canvas.removeEventListener("wheel", this.onWheel);
  }

  setModel(model: CloudModel, options: { grow?: boolean } = {}) {
    const first = !this.model;
    this.model = model;
    const size = model.nodes.length;
    // Up to ~600 nodes dots keep Marble's size; denser clouds shrink them gently so clusters stay legible.
    this.density = clamp(Math.sqrt(600 / Math.max(1, size)), 0.65, 1);
    if (this.sx.length !== size) {
      for (const field of ["sx", "sy", "scale", "depth", "radius", "alpha", "posX", "posY", "posR", "posC", "fromX", "fromY", "fromR", "fromC", "chainX", "chainY", "chainR", "chainLabelWidth"] as const) this[field] = new Float32Array(size);
      this.member = new Uint8Array(size); this.chainText = new Array(size).fill("");
      this.order = Array.from({ length: size }, (_, index) => index);
      this.chain = null; this.shown = null; this.chainPresence = 0; this.drawn = false;
    }
    if (first) { this.camera.centerY = this.target.centerY = model.height / 2; }
    if (options.grow && !this.reducedMotion) this.growStart = performance.now();
    if (this.hover >= size) this.hover = -1;
    this.request();
  }

  setHighlight(highlight: CloudHighlight) { this.highlight = highlight; this.request(); }

  setSpin(enabled: boolean) { this.spinEnabled = enabled; this.request(); }

  // Lifts the chain out of the funnel (or lets it fall back with null); nodes glide from wherever they are drawn now.
  setChain(chain: CloudChain | null) {
    const next = chain && chain.levels.length ? chain : null;
    if (!this.model) { this.chain = next; return; }
    this.fromX.set(this.posX); this.fromY.set(this.posY); this.fromR.set(this.posR); this.fromC.set(this.posC);
    this.presenceFrom = this.chainPresence;
    this.chain = next; if (next) this.shown = next;
    this.member.fill(0);
    if (next) {
      for (const level of next.levels) for (const index of level.nodes) if (index >= 0 && index < this.member.length) this.member[index] = 1;
      this.layoutChain(); this.fitChain();
    }
    this.morphStart = performance.now(); this.morphMs = this.reducedMotion || !this.drawn ? 0 : CHAIN_MS;
    this.hover = -1; this.hoverPoint = null; this.callbacks.onHover(-1, null);
    this.request();
  }

  setInsets(insets: CloudInsets) {
    Object.assign(this.target, insets);
    if (!this.insetsReady) { Object.assign(this.camera, insets); this.insetsReady = true; }
    // The free area changed under an open chain (a panel appeared or resized): lay it out again.
    if (this.chain) {
      const area = this.freeArea(); const previous = this.chainArea;
      if (Math.abs(area.left - previous.left) + Math.abs(area.right - previous.right) > 24 || Math.abs(area.top - previous.top) + Math.abs(area.bottom - previous.bottom) > 40) {
        this.layoutChain(); this.fitChain();
      }
    }
    this.request();
  }

  // Marble's focusNode turns the funnel until the node faces the viewer and looks at it from just above.
  // A grade-9 point can rest on prerequisites three grades lower, so instead of a fixed zoom the camera
  // frames the node together with everything that lights up with it.
  focus(index: number, related: number[] = []) {
    const model = this.model; const node = model?.nodes[index]; if (!model || !node) return;
    const facing = Math.atan2(node.z, node.x) + Math.PI / 2;
    const rot = facing + Math.round((this.camera.rot - facing) / (Math.PI * 2)) * Math.PI * 2;
    const tilt = -0.18; const cosR = Math.cos(rot); const sinR = Math.sin(rot); const cosT = Math.cos(tilt); const sinT = Math.sin(tilt);
    const items = [index, ...related].map((position) => model.nodes[position]).filter((item) => item && !item.ghost)
      .map((item) => ({ y: item.y, x1: item.x * cosR + item.z * sinR, z1: -item.x * sinR + item.z * cosR }));
    const viewWidth = Math.max(80, this.width - this.target.left - this.target.right);
    const viewHeight = Math.max(80, this.height - this.target.top - this.target.bottom);
    const base = Math.min(viewWidth / 1500, viewHeight / 1700);
    // Start from the flat estimate, then correct a few times against the real perspective projection:
    // near dots at the wide top of the funnel are drawn up to ~1.4× further from the centre.
    let low = Infinity; let high = -Infinity;
    for (const item of items) { const vertical = item.y * cosT - item.z1 * sinT; low = Math.min(low, vertical); high = Math.max(high, vertical); }
    let centerY = (low + high) / 2 / cosT; let zoom = clamp((viewHeight * 0.8) / Math.max(1, (high - low) * base), 0.8, 2);
    for (let round = 0; round < 6; round += 1) {
      const unit = base * zoom; let top = Infinity; let bottom = -Infinity; let reach = 0;
      for (const item of items) {
        const py = item.y - centerY; const y2 = py * cosT - item.z1 * sinT; const z2 = py * sinT + item.z1 * cosT;
        const perspective = FOV / Math.max(FOV * 0.22, FOV + z2 * unit * 1.6);
        top = Math.min(top, -y2 * unit * perspective); bottom = Math.max(bottom, -y2 * unit * perspective); reach = Math.max(reach, Math.abs(item.x1 * unit * perspective));
      }
      centerY -= (top + bottom) / 2 / (cosT * unit);
      const scale = Math.min((viewHeight * 0.8) / Math.max(1, bottom - top), (viewWidth * 0.46) / Math.max(1, reach));
      zoom = clamp(zoom * clamp(scale, 0.6, 1.6), 0.8, 2);
    }
    this.target.rot = rot; this.target.tilt = tilt; this.target.zoom = zoom; this.target.centerY = centerY;
    this.lastInput = performance.now(); this.request();
  }

  resetView() {
    if (!this.model) return;
    if (this.chain) { this.fitChain(); this.request(); return; }
    this.target.tilt = DEFAULT_TILT; this.target.zoom = 1; this.target.centerY = this.model.height / 2;
    this.lastInput = 0; this.request();
  }

  zoomBy(factor: number) {
    if (this.chain) { const area = this.freeArea(); this.zoomChain(factor, (area.left + area.right) / 2, (area.top + area.bottom) / 2); return; }
    this.target.zoom = clamp(this.target.zoom * factor, ZOOM_MIN, ZOOM_MAX);
    this.lastInput = performance.now(); this.request();
  }

  private get chainActive() { return Boolean(this.chain) && this.chainPresence > 0.5; }

  private onMotionChange = (event: MediaQueryListEvent) => { this.reducedMotion = event.matches; if (event.matches) this.growStart = null; this.request(); };

  private resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.ratio = Math.min(2, window.devicePixelRatio || 1);
    this.width = rect.width; this.height = rect.height;
    const width = Math.max(1, Math.round(rect.width * this.ratio)); const height = Math.max(1, Math.round(rect.height * this.ratio));
    if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
    if (this.chain && this.model) { this.layoutChain(); this.fitChain(); }
    this.request();
  }

  private request() { if (!this.frame) this.frame = requestAnimationFrame(this.tick); }

  // Idle spin like Marble: paused while the viewer hovers, drags, selects or links, and resumed a moment after
  // the last input. Returns how long to wait before it may resume (0 = spin now, Infinity = stay still).
  private spinDelay(time: number) {
    if (!this.spinEnabled || this.reducedMotion || this.highlight.focus >= 0 || this.highlight.linkSource >= 0 || this.hover >= 0
      || this.chain || this.chainPresence > 0 || this.drag || this.pinch || this.pointers.size) return Infinity;
    return Math.max(0, IDLE_AFTER_INPUT - (time - this.lastInput));
  }

  private tick = (time: number) => {
    this.frame = 0;
    const elapsed = this.lastTime ? Math.min(64, time - this.lastTime) : 16;
    let active = false;
    const delay = this.spinDelay(time);
    if (delay === 0) { this.camera.rot += SPIN * elapsed; this.target.rot += SPIN * elapsed; active = true; }
    const blend = this.reducedMotion ? 1 : 1 - Math.pow(1 - TWEEN, elapsed / 16.67);
    for (const field of ["rot", "tilt", "zoom", "centerY", "top", "right", "bottom", "left"] as const) {
      const delta = this.target[field] - this.camera[field];
      const settled = field === "zoom" || field === "rot" || field === "tilt" ? Math.abs(delta) < 1e-4 : Math.abs(delta) < 0.05;
      if (settled) this.camera[field] = this.target[field];
      else { this.camera[field] += delta * blend; active = true; }
    }
    let grow = 1;
    if (this.growStart !== null) {
      const progress = Math.min(1, (time - this.growStart) / GROW_MS);
      grow = 1 - Math.pow(1 - progress, 3);
      if (progress >= 1) this.growStart = null; else active = true;
    }
    if (this.draw(grow)) active = true;
    window.clearTimeout(this.wake);
    if (active || this.drag) { this.lastTime = time; this.request(); }
    else {
      this.lastTime = 0;
      // The render loop sleeps while nothing moves; wake it when the idle spin is due.
      if (Number.isFinite(delay)) this.wake = window.setTimeout(() => this.request(), delay + 16);
    }
  };

  private project() {
    const model = this.model!; const camera = this.camera;
    const viewWidth = Math.max(80, this.width - camera.left - camera.right);
    const viewHeight = Math.max(80, this.height - camera.top - camera.bottom);
    const unit = Math.min(viewWidth / 1500, viewHeight / 1700) * camera.zoom;
    const centerX = camera.left + viewWidth * 0.52; const centerY = camera.top + viewHeight * 0.52;
    const cosR = Math.cos(camera.rot); const sinR = Math.sin(camera.rot); const cosT = Math.cos(camera.tilt); const sinT = Math.sin(camera.tilt);
    const grow = Math.min(1.6, Math.max(0.9, camera.zoom)) * this.density;
    const nodes = model.nodes;
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      const x1 = node.x * cosR + node.z * sinR;
      const z1 = -node.x * sinR + node.z * cosR;
      const py = node.y - camera.centerY;
      const y2 = py * cosT - z1 * sinT;
      const z2 = py * sinT + z1 * cosT;
      const denominator = FOV + z2 * unit * 1.6;
      if (denominator < FOV * 0.22) { this.scale[index] = 0; continue; }
      const perspective = FOV / denominator;
      this.sx[index] = centerX + x1 * unit * perspective;
      this.sy[index] = centerY - y2 * unit * perspective;
      this.scale[index] = perspective; this.depth[index] = z2;
      const base = node.level === "topic" ? 4.4 + Math.sqrt(node.size) * 6.5 : 2.3 + Math.sqrt(node.size) * 7.5;
      this.radius[index] = base * perspective * grow;
    }
    this.order.sort((left, right) => this.depth[right] - this.depth[left]);
    return { unit, centerX, centerY, cosT, sinT };
  }

  private growAlpha(y: number, grow: number) {
    if (grow >= 1) return 1;
    const front = grow * (this.model!.height + GROW_FADE);
    return clamp((front - y) / GROW_FADE, 0, 1);
  }

  // Returns true while the chain is still gliding in or out.
  private draw(grow: number) {
    const context = this.context; const model = this.model;
    context.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    context.clearRect(0, 0, this.width, this.height);
    if (!model || !model.nodes.length) return false;
    const view = this.project();
    const progress = this.morphMs ? clamp((performance.now() - this.morphStart) / this.morphMs, 0, 1) : 1;
    const amount = ease(progress);
    this.chainPresence = lerp(this.presenceFrom, this.chain ? 1 : 0, amount);
    if (!this.chain && progress >= 1) this.shown = null;
    const presence = this.chainPresence;
    const highlight = this.highlight; const focused = highlight.focus >= 0 && highlight.focus < model.nodes.length;
    const nodeAlpha = this.alpha; nodeAlpha.fill(0);
    for (let index = 0; index < model.nodes.length; index += 1) {
      const node = model.nodes[index];
      if (!this.scale[index]) continue;
      const visible = this.growAlpha(node.y, grow); if (!visible) continue;
      let dim = node.ghost ? 0.06 : node.faint ? 0.3 : 1;
      if (focused && !node.ghost && index !== highlight.focus && !highlight.upstream.has(index) && !highlight.next.has(index) && !highlight.marked.has(index)) dim = Math.min(dim, 0.1);
      const depthShade = 0.55 + 0.45 * Math.min(1, this.scale[index] * this.scale[index]);
      nodeAlpha[index] = dim * depthShade * visible;
    }
    this.place(amount, progress);
    this.drawBands(view, focused, 1 - presence);
    this.drawEdges(nodeAlpha, focused, 1 - presence);
    if (presence > 0) this.drawChainFrame(presence);
    if (presence > 0) this.drawChainEdges(presence);
    this.drawNodes(nodeAlpha, focused, presence);
    this.drawLink();
    if (presence < 0.5) this.drawLabels(model, nodeAlpha, 1 - presence * 2);
    if (presence > 0) this.drawChainLabels(presence);
    if (presence > 0) this.drawChainHints(presence);
    this.drawn = true;
    this.trackHover();
    return progress < 1;
  }

  // Blends every node between its funnel projection and its place in the chain diagram.
  private place(amount: number, progress: number) {
    const view = this.chainView;
    for (let index = 0; index < this.posX.length; index += 1) {
      const inChain = this.member[index] === 1;
      const targetX = inChain ? view.x + this.chainX[index] * view.scale : this.sx[index];
      const targetY = inChain ? view.y - this.chainY[index] * view.scale : this.sy[index];
      const targetR = inChain ? this.chainR[index] * view.scale : this.radius[index];
      if (progress >= 1 || (!inChain && this.fromC[index] === 0)) {
        this.posX[index] = targetX; this.posY[index] = targetY; this.posR[index] = targetR; this.posC[index] = inChain ? 1 : 0;
      } else {
        this.posX[index] = lerp(this.fromX[index], targetX, amount); this.posY[index] = lerp(this.fromY[index], targetY, amount);
        this.posR[index] = lerp(this.fromR[index], targetR, amount); this.posC[index] = lerp(this.fromC[index], inChain ? 1 : 0, amount);
      }
    }
  }

  // Keeps the hover card attached to its dot while the camera is still easing.
  private trackHover() {
    const index = this.hover; if (index < 0 || (!this.posC[index] && !this.scale[index])) return;
    const x = this.posX[index]; const y = this.posY[index];
    if (this.hoverPoint && Math.abs(this.hoverPoint.x - x) < 0.5 && Math.abs(this.hoverPoint.y - y) < 0.5) return;
    this.hoverPoint = { x, y };
    this.callbacks.onHover(index, { x, y, radius: this.posR[index] });
  }

  // Faint rings at the grade boundaries and the grade names along the left rim.
  private drawBands(view: { unit: number; centerX: number; centerY: number; cosT: number; sinT: number }, focused: boolean, fade: number) {
    if (fade <= 0.02) return;
    const model = this.model!; const context = this.context; const camera = this.camera;
    const radiusAt = (y: number) => model.radius.base + (model.radius.top - model.radius.base) * clamp(y / model.height, 0, 1);
    const place = (x1: number, z1: number, y: number) => {
      const py = y - camera.centerY; const y2 = py * view.cosT - z1 * view.sinT; const z2 = py * view.sinT + z1 * view.cosT;
      const denominator = FOV + z2 * view.unit * 1.6; if (denominator < FOV * 0.22) return null;
      const perspective = FOV / denominator;
      return { x: view.centerX + x1 * view.unit * perspective, y: view.centerY - y2 * view.unit * perspective };
    };
    context.save(); context.globalAlpha = fade;
    context.lineWidth = 1; context.strokeStyle = `rgba(${EDGE},${focused ? 0.035 : 0.07})`;
    const boundaries = [0, ...model.bands.map((band) => band.y1)];
    for (const y of boundaries) {
      const radius = radiusAt(y) * 1.06; context.beginPath();
      for (let step = 0; step <= 72; step += 1) {
        const angle = (step / 72) * Math.PI * 2; const point = place(Math.cos(angle) * radius, Math.sin(angle) * radius, y);
        if (!point) continue;
        if (step === 0) context.moveTo(point.x, point.y); else context.lineTo(point.x, point.y);
      }
      context.stroke();
    }
    context.font = `500 12px ${FONT}`; context.textAlign = "right"; context.textBaseline = "middle";
    context.fillStyle = `rgba(152,160,184,${focused ? 0.28 : 0.62})`;
    for (const band of model.bands) {
      const y = (band.y0 + band.y1) / 2; const point = place(-(radiusAt(y) * 1.06 + 28), 0, y);
      if (point && point.x > 70) context.fillText(band.label, point.x, point.y);
    }
    context.restore();
  }

  private drawEdges(alpha: Float32Array, focused: boolean, fade: number) {
    if (fade <= 0.02) return;
    const model = this.model!; const context = this.context; const highlight = this.highlight;
    const buckets = Array.from({ length: 8 }, () => new Path2D()); const used = new Array(8).fill(false);
    const lineage: CloudEdge[] = []; const forward: CloudEdge[] = [];
    for (const edge of model.edges) {
      const source = edge.source; const target = edge.target;
      if (!alpha[source] || !alpha[target] || !this.scale[source] || !this.scale[target]) continue;
      if (model.nodes[source].ghost || model.nodes[target].ghost) continue;
      if (this.posC[source] > 0 || this.posC[target] > 0) continue;
      if (focused) {
        const intoLineage = (target === highlight.focus || highlight.upstream.has(target)) && highlight.upstream.has(source);
        if (intoLineage) { lineage.push(edge); continue; }
        if (source === highlight.focus && highlight.next.has(target)) { forward.push(edge); continue; }
      }
      const near = (this.scale[source] + this.scale[target]) / 2;
      const bucket = (edge.soft ? 4 : 0) + clamp(Math.floor(((near - 0.78) / 0.42) * 4), 0, 3);
      buckets[bucket].moveTo(this.sx[source], this.sy[source]); buckets[bucket].lineTo(this.sx[target], this.sy[target]); used[bucket] = true;
    }
    context.save(); context.lineWidth = 1; context.globalAlpha = fade;
    for (let bucket = 0; bucket < 8; bucket += 1) {
      if (!used[bucket]) continue;
      const soft = bucket >= 4; const depth = 0.45 + 0.55 * ((bucket % 4) + 0.5) / 4;
      const strength = focused ? 0.04 : (soft ? 0.05 : 0.1) * depth;
      context.strokeStyle = `rgba(${EDGE},${strength})`;
      if (soft) context.setLineDash([3, 4]); else context.setLineDash([]);
      context.stroke(buckets[bucket]);
    }
    context.setLineDash([]); context.lineWidth = 1.6;
    for (const edge of lineage) {
      context.globalAlpha = fade * 0.75 * Math.min(1, Math.min(alpha[edge.source], alpha[edge.target]) + 0.3);
      context.strokeStyle = model.nodes[edge.source].color;
      context.beginPath(); context.moveTo(this.sx[edge.source], this.sy[edge.source]); context.lineTo(this.sx[edge.target], this.sy[edge.target]); context.stroke();
    }
    context.globalAlpha = fade * 0.7; context.lineWidth = 1.3; context.setLineDash([5, 4]); context.strokeStyle = INK;
    for (const edge of forward) {
      context.beginPath(); context.moveTo(this.sx[edge.source], this.sy[edge.source]); context.lineTo(this.sx[edge.target], this.sy[edge.target]); context.stroke();
    }
    context.restore();
  }

  private drawNodes(alpha: Float32Array, focused: boolean, presence: number) {
    const model = this.model!; const context = this.context; const highlight = this.highlight;
    const lifted: number[] = [];
    context.save(); context.lineWidth = 1;
    const paint = (index: number, opacity: number, inChain: number) => {
      const node = model.nodes[index]; const x = this.posX[index]; const y = this.posY[index]; const radius = this.posR[index];
      const lit = (focused && (index === highlight.focus || highlight.upstream.has(index)) && presence < 0.5) || (inChain > 0.5 && index === highlight.focus);
      const glowing = lit || (!focused && node.glow) || (inChain > 0.5 && node.glow);
      if (glowing) { context.shadowColor = node.color; context.shadowBlur = index === highlight.focus ? 18 : lit ? 9 : 12; }
      context.globalAlpha = opacity;
      context.beginPath(); context.arc(x, y, Math.max(0.5, radius), 0, Math.PI * 2);
      if (node.level === "topic") {
        context.fillStyle = node.color; context.globalAlpha = opacity * (node.glow || inChain > 0.5 ? 0.6 : 0.32); context.fill();
        context.globalAlpha = opacity; context.strokeStyle = node.color; context.lineWidth = 1.7; context.stroke(); context.lineWidth = 1;
      } else {
        context.fillStyle = node.color; context.fill();
        if (glowing) context.shadowBlur = 0;
        context.globalAlpha = opacity * 0.5; context.strokeStyle = SHADOW; context.stroke();
      }
      if (glowing) { context.shadowBlur = 0; context.shadowColor = "transparent"; }
      const ring = index === highlight.focus ? 2.5 : index === this.hover ? 2 : (highlight.next.has(index) || highlight.marked.has(index)) && inChain < 0.5 ? 1.8 : 0;
      if (ring) {
        context.globalAlpha = (index === highlight.focus ? 0.95 : index === this.hover ? 0.85 : highlight.marked.has(index) ? 0.9 : 0.62) * Math.max(opacity, inChain);
        context.strokeStyle = INK; context.lineWidth = index === highlight.focus ? 1.6 : 1.2;
        context.beginPath(); context.arc(x, y, radius + ring, 0, Math.PI * 2); context.stroke(); context.lineWidth = 1;
      }
      if (index === highlight.linkSource) {
        context.globalAlpha = 1; context.strokeStyle = INK; context.lineWidth = 1.5; context.setLineDash([3, 3]);
        context.beginPath(); context.arc(x, y, radius + 5, 0, Math.PI * 2); context.stroke(); context.setLineDash([]); context.lineWidth = 1;
      }
    };
    for (const index of this.order) {
      const inChain = this.posC[index];
      if (inChain > 0) { lifted.push(index); continue; }
      let opacity = alpha[index]; if (!opacity) continue;
      // Behind an open chain the funnel stays as a faint backdrop.
      if (presence > 0) opacity = lerp(opacity, Math.min(opacity, 0.05), presence);
      paint(index, opacity, 0);
    }
    lifted.sort((left, right) => this.posC[left] - this.posC[right] || (left === highlight.focus ? 1 : 0) - (right === highlight.focus ? 1 : 0));
    if (lifted.length) {
      context.save(); if (presence > 0) this.clipToFreeArea();
      for (const index of lifted) paint(index, lerp(alpha[index] || 0.15, 1, this.posC[index]), this.posC[index]);
      context.restore();
    }
    context.restore();
  }

  private drawLink() {
    const source = this.highlight.linkSource; if (source < 0 || !this.pointer || !this.scale[source]) return;
    const context = this.context;
    context.save(); context.globalAlpha = 0.9; context.strokeStyle = INK; context.lineWidth = 1.5; context.setLineDash([6, 5]);
    context.beginPath(); context.moveTo(this.sx[source], this.sy[source]); context.lineTo(this.pointer.x, this.pointer.y); context.stroke();
    context.restore();
  }

  // A handful of labels only (focus, its direct neighbours, search hits), placed greedily without overlaps.
  private drawLabels(model: CloudModel, alpha: Float32Array, fade: number) {
    const highlight = this.highlight; if (!highlight.labels.length || fade <= 0) return;
    const context = this.context; const placed: Array<[number, number, number, number]> = [];
    const overlaps = (box: [number, number, number, number]) => placed.some((other) => box[0] < other[2] && box[2] > other[0] && box[1] < other[3] && box[3] > other[1]);
    context.save(); context.textBaseline = "middle"; context.lineJoin = "round";
    for (const index of highlight.labels) {
      if (index < 0 || index >= model.nodes.length || !this.scale[index] || !alpha[index]) continue;
      const focus = index === highlight.focus;
      const text = model.labels[index] ?? ""; if (!text) continue;
      context.font = focus ? `600 14px ${FONT}` : `500 12px ${FONT}`;
      const width = context.measureText(text).width; const height = focus ? 18 : 15;
      const x = this.posX[index]; const y = this.posY[index]; const gap = this.posR[index] + 7;
      const candidates: Array<[number, number, CanvasTextAlign]> = [[x + gap, y, "left"], [x - gap, y, "right"], [x, y - gap - 4, "center"], [x, y + gap + 4, "center"]];
      let chosen: [number, number, CanvasTextAlign] | null = null; let box: [number, number, number, number] = [0, 0, 0, 0];
      for (const candidate of candidates) {
        const left = candidate[2] === "left" ? candidate[0] : candidate[2] === "right" ? candidate[0] - width : candidate[0] - width / 2;
        const next: [number, number, number, number] = [left - 3, candidate[1] - height / 2, left + width + 3, candidate[1] + height / 2];
        const inside = next[0] > this.camera.left + 4 && next[2] < this.width - this.camera.right - 4 && next[1] > this.camera.top + 2 && next[3] < this.height - this.camera.bottom - 2;
        if (inside && (focus || !overlaps(next))) { chosen = candidate; box = next; break; }
      }
      if (!chosen) continue;
      placed.push(box);
      context.textAlign = chosen[2];
      context.globalAlpha = fade; context.lineWidth = 4; context.strokeStyle = HALO; context.strokeText(text, chosen[0], chosen[1]);
      context.fillStyle = focus || highlight.marked.has(index) ? INK : MUTED; context.fillText(text, chosen[0], chosen[1]);
    }
    context.restore();
  }

  // ── Chain diagram ──────────────────────────────────────────────────────────────

  private freeArea(): Area {
    const insets = this.target;
    return { left: insets.left, top: insets.top, right: Math.max(insets.left + 120, this.width - insets.right), bottom: Math.max(insets.top + 120, this.height - insets.bottom) };
  }

  // Rows from the bottom (earliest prerequisites) to the top; a row wider than the screen wraps onto
  // extra lines, and a few passes pull every node over the nodes it is connected to.
  private layoutChain() {
    const chain = this.chain; const model = this.model; if (!chain || !model) return;
    const context = this.context; const area = this.freeArea();
    const narrow = area.right - area.left < 560;
    this.chainGutter = narrow ? 46 : 70;
    const labelMax = narrow ? 128 : 176;
    const available = Math.max(200, area.right - area.left - MARGIN * 2 - this.chainGutter);
    const span = new Map<number, number>();
    for (const level of chain.levels) for (const index of level.nodes) {
      const focus = index === chain.focus; const node = model.nodes[index];
      context.font = focus ? `600 14px ${FONT}` : `500 12.5px ${FONT}`;
      let text = model.labels[index] ?? "";
      if (context.measureText(text).width > labelMax) {
        let low = 1; let high = text.length;
        while (low < high) { const middle = (low + high + 1) >> 1; if (context.measureText(`${text.slice(0, middle)}…`).width <= labelMax) low = middle; else high = middle - 1; }
        text = `${text.slice(0, low)}…`;
      }
      const radius = focus ? 9 : node.level === "topic" ? 7.5 : 4.5 + Math.sqrt(node.size) * 2.6;
      const textWidth = context.measureText(text).width;
      this.chainR[index] = radius; this.chainText[index] = text; this.chainLabelWidth[index] = textWidth;
      span.set(index, radius * 2 + LABEL_GAP + textWidth + NODE_GAP);
    }
    type Row = { nodes: number[]; y: number };
    const rows: Row[] = []; const ranks: Array<{ rank: number; y: number; top: number }> = []; let y = 0;
    for (const level of chain.levels) {
      const lines: number[][] = [[]]; let used = 0;
      for (const index of level.nodes) {
        const width = span.get(index)!;
        if (lines[lines.length - 1].length && used + width - NODE_GAP > available) { lines.push([]); used = 0; }
        lines[lines.length - 1].push(index); used += width;
      }
      lines.forEach((nodes, line) => rows.push({ nodes, y: y + line * LINE_PITCH }));
      ranks.push({ rank: level.rank, y, top: y + (lines.length - 1) * LINE_PITCH });
      y += (lines.length - 1) * LINE_PITCH + ROW_PITCH;
    }
    // Follow the desired positions, keep order and spacing, and never leave the available width: each node
    // gets a band between "everything before it packed to the left" and "everything after it packed to the right".
    const settle = (row: Row, desired: number[]) => {
      const low: number[] = []; const high: number[] = []; let before = 0; let after = 0;
      row.nodes.forEach((index, position) => { low[position] = -available / 2 + before + this.chainR[index]; before += span.get(index)!; });
      for (let position = row.nodes.length - 1; position >= 0; position -= 1) {
        const index = row.nodes[position]; after += span.get(index)!;
        high[position] = Math.max(low[position], available / 2 - (after - NODE_GAP) + this.chainR[index]);
      }
      const xs = desired.map((value, position) => clamp(value, low[position], high[position]));
      for (let position = 1; position < xs.length; position += 1) {
        const previous = row.nodes[position - 1]; const current = row.nodes[position];
        xs[position] = Math.max(xs[position], xs[position - 1] - this.chainR[previous] + span.get(previous)! + this.chainR[current]);
      }
      const wanted = desired.reduce((sum, value, position) => sum + value - xs[position], 0) / xs.length;
      const shift = clamp(wanted, Math.max(...xs.map((value, position) => low[position] - value)), Math.min(...xs.map((value, position) => high[position] - value)));
      row.nodes.forEach((index, position) => { this.chainX[index] = xs[position] + shift; this.chainY[index] = row.y; });
    };
    for (const row of rows) {
      let cursor = -(row.nodes.reduce((sum, index) => sum + span.get(index)!, 0) - NODE_GAP) / 2;
      settle(row, row.nodes.map((index) => { const x = cursor + this.chainR[index]; cursor += span.get(index)!; return x; }));
    }
    const neighbours = new Map<number, number[]>();
    for (const edge of chain.edges) {
      neighbours.set(edge.source, [...(neighbours.get(edge.source) ?? []), edge.target]);
      neighbours.set(edge.target, [...(neighbours.get(edge.target) ?? []), edge.source]);
    }
    for (let pass = 0; pass < 6; pass += 1) {
      const upward = pass % 2 === 0;
      for (const row of upward ? rows : [...rows].reverse()) {
        settle(row, row.nodes.map((index) => {
          const linked = (neighbours.get(index) ?? []).filter((other) => upward ? this.chainY[other] < row.y : this.chainY[other] > row.y);
          return linked.length ? linked.reduce((sum, other) => sum + this.chainX[other], 0) / linked.length : this.chainX[index];
        }));
      }
    }
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    for (const row of rows) for (const index of row.nodes) {
      const left = this.chainX[index] - this.chainR[index];
      minX = Math.min(minX, left); maxX = Math.max(maxX, left + span.get(index)! - NODE_GAP);
      minY = Math.min(minY, row.y - 14); maxY = Math.max(maxY, row.y + 14);
    }
    this.chainBounds = { minX, maxX, minY, maxY }; this.chainRows = ranks; this.chainArea = area;
  }

  // Fill the free area: centred when it fits, otherwise readable (never below 0.8×) with the current
  // node a little above the middle so its successors and nearest prerequisites show first.
  private fitChain() {
    if (!this.chain) return;
    const area = this.freeArea(); const bounds = this.chainBounds;
    const width = Math.max(120, area.right - area.left - MARGIN * 2 - this.chainGutter); const height = Math.max(120, area.bottom - area.top - MARGIN * 2);
    const contentWidth = Math.max(1, bounds.maxX - bounds.minX); const contentHeight = Math.max(1, bounds.maxY - bounds.minY);
    const scale = clamp(Math.min(width / contentWidth, height / contentHeight, 1.1), 0.8, 1.1);
    const x = area.left + MARGIN + this.chainGutter + width / 2 - ((bounds.minX + bounds.maxX) / 2) * scale;
    let y: number;
    if (contentHeight * scale <= height) y = area.top + MARGIN + height / 2 + ((bounds.minY + bounds.maxY) / 2) * scale;
    else {
      const focusRow = this.chainRows.find((row) => row.rank === 0)?.y ?? 0;
      y = area.top + MARGIN + height * 0.4 + focusRow * scale;
      const top = y - bounds.maxY * scale; if (top > area.top + MARGIN) y -= top - (area.top + MARGIN);
      const bottom = y - bounds.minY * scale; if (bottom < area.bottom - MARGIN) y += area.bottom - MARGIN - bottom;
    }
    this.chainView = { x, y, scale };
  }

  private clampChain() {
    const area = this.freeArea(); const bounds = this.chainBounds; const view = this.chainView; const keep = 90;
    const top = view.y - bounds.maxY * view.scale; const bottom = view.y - bounds.minY * view.scale;
    if (bottom < area.top + keep) view.y += area.top + keep - bottom;
    if (top > area.bottom - keep) view.y -= top - (area.bottom - keep);
    const left = view.x + bounds.minX * view.scale; const right = view.x + bounds.maxX * view.scale;
    if (right < area.left + keep) view.x += area.left + keep - right;
    if (left > area.right - keep) view.x -= left - (area.right - keep);
  }

  private zoomChain(factor: number, x: number, y: number) {
    const view = this.chainView; const scale = clamp(view.scale * factor, 0.5, 1.8); const ratio = scale / view.scale;
    view.x = x - (x - view.x) * ratio; view.y = y - (y - view.y) * ratio; view.scale = scale;
    this.clampChain(); this.lastInput = performance.now(); this.request();
  }

  // Step labels in the gutter, a soft band behind the current row, and a faint band holding together the
  // lines of a step that had to wrap.
  private drawChainFrame(presence: number) {
    if (!this.chain) return;
    const context = this.context; const area = this.freeArea(); const view = this.chainView;
    context.save(); this.clipToFreeArea(); context.globalAlpha = presence; context.textBaseline = "middle";
    const left = area.left + 14; const width = area.right - area.left - 28;
    for (const row of this.chainRows) {
      const bottom = view.y - row.y * view.scale; const top = view.y - row.top * view.scale;
      if (row.rank !== 0 && row.top === row.y) continue;
      context.fillStyle = row.rank === 0 ? "rgba(237,239,247,.045)" : "rgba(237,239,247,.022)";
      context.beginPath(); context.roundRect(left, top - 21 * view.scale, width, bottom - top + 42 * view.scale, 12); context.fill();
    }
    context.font = `500 11.5px ${FONT}`; context.textAlign = "left";
    for (const row of this.chainRows) {
      const y = view.y - ((row.y + row.top) / 2) * view.scale; if (y < area.top + 8 || y > area.bottom - 8) continue;
      context.fillStyle = row.rank === 0 ? "rgba(237,239,247,.85)" : "rgba(152,160,184,.6)";
      context.fillText(row.rank === 0 ? "当前" : row.rank < 0 ? `前 ${-row.rank} 层` : `后 ${row.rank} 层`, area.left + MARGIN - 6, y);
    }
    context.restore();
  }

  // The diagram scrolls under the header or a phone's bottom sheet; keep it inside the free area.
  private clipToFreeArea() {
    const area = this.freeArea();
    this.context.beginPath(); this.context.rect(area.left, area.top, area.right - area.left, area.bottom - area.top); this.context.clip();
  }

  // Drawn last so they stay readable above the diagram.
  private drawChainHints(presence: number) {
    if (!this.chain) return;
    const context = this.context; const area = this.freeArea(); const view = this.chainView; const bounds = this.chainBounds;
    context.save(); context.globalAlpha = presence; context.textBaseline = "middle";
    const hint = (text: string, y: number) => {
      context.font = `500 12px ${FONT}`; const width = context.measureText(text).width + 24; const x = (area.left + area.right) / 2;
      context.fillStyle = "rgba(14,17,28,.94)"; context.beginPath(); context.roundRect(x - width / 2, y - 14, width, 28, 14); context.fill();
      context.strokeStyle = "rgba(130,145,190,.25)"; context.lineWidth = 1; context.stroke();
      context.fillStyle = MUTED; context.textAlign = "center"; context.fillText(text, x, y);
    };
    if (view.y - bounds.minY * view.scale > area.bottom + 4) hint("↓ 向下滚动，查看更早的前置", area.bottom - 22);
    if (view.y - bounds.maxY * view.scale < area.top - 4) hint("↑ 向上滚动，查看更远的后续", area.top + 22);
    context.restore();
  }

  private drawChainEdges(presence: number) {
    const chain = this.shown; const model = this.model; if (!chain || !model) return;
    const context = this.context; const hover = this.hover; const hovering = hover >= 0 && this.posC[hover] > 0.5;
    context.save(); this.clipToFreeArea(); context.lineCap = "round";
    const curve = (source: number, target: number) => {
      const x1 = this.posX[source]; const y1 = this.posY[source]; const x2 = this.posX[target]; const y2 = this.posY[target];
      const bend = Math.max(16, Math.abs(y1 - y2) * 0.5);
      context.beginPath(); context.moveTo(x1, y1); context.bezierCurveTo(x1, y1 - bend, x2, y2 + bend, x2, y2); context.stroke();
    };
    for (const edge of chain.edges) {
      const touches = hovering && (edge.source === hover || edge.target === hover);
      const base = edge.up ? 0.55 : 0.45;
      context.globalAlpha = presence * (hovering ? (touches ? 0.95 : base * 0.25) : base);
      context.strokeStyle = edge.up ? model.nodes[edge.source].color : INK;
      context.lineWidth = touches ? 2.4 : edge.up ? 1.5 : 1.2;
      curve(edge.source, edge.target);
    }
    if (hovering) {
      context.setLineDash([4, 4]); context.lineWidth = 1.6;
      for (const edge of chain.shortcuts) {
        if (edge.source !== hover && edge.target !== hover) continue;
        context.globalAlpha = presence * 0.75; context.strokeStyle = edge.up ? model.nodes[edge.source].color : INK;
        curve(edge.source, edge.target);
      }
    }
    context.restore();
  }

  private drawChainLabels(presence: number) {
    const chain = this.shown; if (!chain) return;
    const context = this.context; const hover = this.hover; const hovering = hover >= 0 && this.posC[hover] > 0.5;
    const related = new Set<number>();
    if (hovering) for (const edge of [...chain.edges, ...chain.shortcuts]) { if (edge.source === hover) related.add(edge.target); if (edge.target === hover) related.add(edge.source); }
    // Labels scale with the diagram so zooming out never lets a name run into the next dot.
    const scale = this.chainView.scale;
    context.save(); this.clipToFreeArea(); context.textBaseline = "middle"; context.textAlign = "left"; context.lineJoin = "round";
    for (const level of chain.levels) for (const index of level.nodes) {
      const amount = (this.posC[index] - 0.6) / 0.4; if (amount <= 0) continue;
      const focus = index === chain.focus; const emphasised = focus || index === hover || related.has(index);
      context.font = focus ? `600 ${(14 * scale).toFixed(2)}px ${FONT}` : `500 ${(12.5 * scale).toFixed(2)}px ${FONT}`;
      const x = this.posX[index] + this.posR[index] + LABEL_GAP * scale; const y = this.posY[index];
      context.globalAlpha = presence * Math.min(1, amount) * (hovering && !emphasised ? 0.45 : 1);
      context.lineWidth = 4; context.strokeStyle = HALO; context.strokeText(this.chainText[index], x, y);
      context.fillStyle = emphasised ? INK : SOFT; context.fillText(this.chainText[index], x, y);
    }
    context.restore();
  }

  // ── Picking and input ──────────────────────────────────────────────────────────

  private pick(x: number, y: number, touch = false) {
    const model = this.model; if (!model) return -1;
    let best = -1; let bestDistance = Infinity;
    if (this.chainActive && this.shown) {
      // In the chain both the dot and its label are targets.
      for (const level of this.shown.levels) for (const index of level.nodes) {
        const dx = this.posX[index] - x; const dy = this.posY[index] - y; const distance = dx * dx + dy * dy;
        const radius = this.posR[index]; const reach = touch ? Math.max(20, radius + 12) : Math.max(12, radius + 7);
        const scale = this.chainView.scale;
        const onLabel = x >= this.posX[index] && x <= this.posX[index] + radius + (LABEL_GAP + this.chainLabelWidth[index]) * scale + 4 && Math.abs(dy) <= 11 * scale;
        if ((distance <= reach * reach || onLabel) && distance < bestDistance) { best = index; bestDistance = distance; }
      }
      return best;
    }
    for (let step = this.order.length - 1; step >= 0; step -= 1) {
      const index = this.order[step]; const node = model.nodes[index];
      if (!this.scale[index] || node.ghost) continue;
      const dx = this.sx[index] - x; const dy = this.sy[index] - y; const distance = dx * dx + dy * dy;
      const reach = touch ? Math.max(20, this.radius[index] + 12) : Math.max(11, this.radius[index] + 6);
      if (distance <= reach * reach && distance < bestDistance) { best = index; bestDistance = distance; }
    }
    return best;
  }

  private local(event: PointerEvent | WheelEvent) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private setHover(index: number) {
    if (index === this.hover) return;
    this.hover = index; this.hoverPoint = index >= 0 ? { x: this.posX[index], y: this.posY[index] } : null;
    this.callbacks.onHover(index, index >= 0 ? { x: this.posX[index], y: this.posY[index], radius: this.posR[index] } : null);
    this.canvas.style.cursor = index >= 0 ? "pointer" : this.drag ? "grabbing" : "grab";
    this.request();
  }

  private onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const point = this.local(event);
    this.pointers.set(event.pointerId, point); this.lastInput = performance.now();
    try { this.canvas.setPointerCapture(event.pointerId); } catch { /* 捕获失败时仍可拖动 */ }
    if (this.pointers.size === 1) this.drag = { x: point.x, y: point.y, rot: this.target.rot, tilt: this.target.tilt, viewX: this.chainView.x, viewY: this.chainView.y, moved: 0 };
    if (this.pointers.size === 2) {
      const [first, second] = [...this.pointers.values()];
      this.pinch = {
        distance: Math.hypot(first.x - second.x, first.y - second.y) || 1, zoom: this.target.zoom, scale: this.chainView.scale,
        x: (first.x + second.x) / 2, y: (first.y + second.y) / 2, viewX: this.chainView.x, viewY: this.chainView.y,
      };
      this.drag = null;
    }
    this.request();
  };

  private onPointerMove = (event: PointerEvent) => {
    const point = this.local(event); this.pointer = point;
    if (this.pointers.has(event.pointerId)) {
      this.pointers.set(event.pointerId, point); this.lastInput = performance.now();
      if (this.pinch && this.pointers.size >= 2) {
        const [first, second] = [...this.pointers.values()];
        const ratio = Math.hypot(first.x - second.x, first.y - second.y) / this.pinch.distance;
        if (this.chainActive) {
          const scale = clamp(this.pinch.scale * ratio, 0.5, 1.8); const factor = scale / this.pinch.scale;
          this.chainView = { x: this.pinch.x - (this.pinch.x - this.pinch.viewX) * factor, y: this.pinch.y - (this.pinch.y - this.pinch.viewY) * factor, scale };
          this.clampChain();
        } else this.target.zoom = clamp(this.pinch.zoom * ratio, ZOOM_MIN, ZOOM_MAX);
      } else if (this.drag) {
        const dx = point.x - this.drag.x; const dy = point.y - this.drag.y;
        this.drag.moved = Math.max(this.drag.moved, Math.hypot(dx, dy));
        if (this.drag.moved > 4) {
          if (this.chainActive) {
            // In the chain, dragging slides the diagram like a page.
            this.chainView.x = this.drag.viewX + dx; this.chainView.y = this.drag.viewY + dy; this.clampChain();
          } else {
            this.target.rot = this.camera.rot = this.drag.rot - dx * 0.0062;
            this.target.tilt = this.camera.tilt = clamp(this.drag.tilt - dy * 0.0042, TILT_MIN, TILT_MAX);
          }
          this.setHover(-1); this.canvas.style.cursor = "grabbing";
        }
      }
      this.request(); return;
    }
    if (event.pointerType === "mouse" || event.pointerType === "pen") this.setHover(this.pick(point.x, point.y));
    if (this.highlight.linkSource >= 0) this.request();
  };

  private onPointerUp = (event: PointerEvent) => {
    const point = this.local(event);
    const click = this.drag && this.drag.moved <= 4 && this.pointers.size === 1;
    this.pointers.delete(event.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (!this.pointers.size) this.drag = null;
    this.canvas.style.cursor = this.hover >= 0 ? "pointer" : "grab";
    if (click) this.callbacks.onPick(this.pick(point.x, point.y, event.pointerType === "touch"));
    this.lastInput = performance.now(); this.request();
  };

  private onPointerCancel = (event: PointerEvent) => {
    this.pointers.delete(event.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (!this.pointers.size) this.drag = null;
    this.request();
  };

  private onPointerLeave = (event: PointerEvent) => {
    if (this.pointers.has(event.pointerId)) return;
    this.pointer = null; this.setHover(-1);
  };

  private onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : 1;
    if (this.chainActive) {
      const point = this.local(event);
      if (event.ctrlKey) this.zoomChain(Math.exp(-event.deltaY * unit * 0.01), point.x, point.y);
      else { this.chainView.x -= event.deltaX * unit; this.chainView.y -= event.deltaY * unit; this.clampChain(); this.lastInput = performance.now(); this.request(); }
      if (this.hover >= 0) this.setHover(this.pick(point.x, point.y));
      return;
    }
    this.target.zoom = clamp(this.target.zoom * Math.exp(-event.deltaY * unit * (event.ctrlKey ? 0.01 : 0.0015)), ZOOM_MIN, ZOOM_MAX);
    this.lastInput = performance.now(); this.request();
  };
}
