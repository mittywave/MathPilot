import type { NoteBox, RecognizedNoteBlock, RecognizedNoteFigure } from "./handout-note.mjs";

// 知识点截图的配图按笔迹裁出：模型给出每一块（文字、图注、配图）的大致位置，本地把每一笔
// 归给它所在的块，配图的范围由归给它的完整笔画决定，图里夹着的别处文字和纸面网格点、水印都抹成白色。
export type Pixels = { data: Uint8ClampedArray; width: number; height: number };
export type Rect = { minX: number; minY: number; maxX: number; maxY: number };
type Component = Rect & { count: number; chroma: number };
type Region = { owner: number; text: boolean; rect: Rect };

// Paper, grid dots (often tinted grey-blue) and faint watermarks are light and nearly colourless;
// pen strokes, highlighter and pastel fills are dark or clearly coloured.
const DARK_INK = 160;
const COLOUR_INK = 45;

export function inkMask({ data, width, height }: Pixels) {
  const mask = new Uint8Array(width * height);
  for (let index = 0; index < mask.length; index += 1) {
    const offset = index * 4; const red = data[offset]; const green = data[offset + 1]; const blue = data[offset + 2];
    if (data[offset + 3] < 40) continue;
    const luminance = red * .299 + green * .587 + blue * .114;
    const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
    if (luminance < DARK_INK || (chroma >= COLOUR_INK && luminance < 250)) mask[index] = 1;
  }
  return mask;
}

// 8-connected strokes; labels[i] is the 1-based component of pixel i, 0 for paper. chroma is the stroke's mean colourfulness.
export function strokeComponents(mask: Uint8Array, width: number, height: number, data?: Uint8ClampedArray) {
  const labels = new Int32Array(width * height); const components: Component[] = []; const stack = new Int32Array(width * height);
  for (let seed = 0; seed < mask.length; seed += 1) {
    if (!mask[seed] || labels[seed]) continue;
    const label = components.length + 1; let top = 0; stack[top++] = seed; labels[seed] = label;
    let minX = width; let minY = height; let maxX = 0; let maxY = 0; let count = 0; let chroma = 0;
    while (top) {
      const index = stack[--top]; const x = index % width; const y = (index - x) / width; count += 1;
      if (data) chroma += Math.max(data[index * 4], data[index * 4 + 1], data[index * 4 + 2]) - Math.min(data[index * 4], data[index * 4 + 1], data[index * 4 + 2]);
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx; const ny = y + dy;
        if ((!dx && !dy) || nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const next = ny * width + nx;
        if (mask[next] && !labels[next]) { labels[next] = label; stack[top++] = next; }
      }
    }
    components.push({ minX, minY, maxX: maxX + 1, maxY: maxY + 1, count, chroma: chroma / count });
  }
  return { labels, components };
}

export const toRect = (box: NoteBox, width: number, height: number): Rect => ({
  minX: Math.max(0, Math.floor(box.x / 1000 * width)), minY: Math.max(0, Math.floor(box.y / 1000 * height)),
  maxX: Math.min(width, Math.ceil((box.x + box.width) / 1000 * width)), maxY: Math.min(height, Math.ceil((box.y + box.height) / 1000 * height)),
});
const grow = (rect: Rect, x: number, y: number): Rect => ({ minX: rect.minX - x, minY: rect.minY - y, maxX: rect.maxX + x, maxY: rect.maxY + y });
const area = (rect: Rect) => Math.max(0, rect.maxX - rect.minX) * Math.max(0, rect.maxY - rect.minY);
const contains = (rect: Rect, x: number, y: number) => x >= rect.minX && x < rect.maxX && y >= rect.minY && y < rect.maxY;
const overlap = (a: Rect, b: Rect) => area({ minX: Math.max(a.minX, b.minX), minY: Math.max(a.minY, b.minY), maxX: Math.min(a.maxX, b.maxX), maxY: Math.min(a.maxY, b.maxY) });

// A grid dot or scan speck: tiny and pale. A strongly coloured dot (a point on a diagram) is kept.
const isSpeck = (component: Component, limit: number) => component.maxX - component.minX <= limit && component.maxY - component.minY <= limit && component.chroma < 70;

// Every stroke goes to one region: text the model located wins over a figure around it (a caption written
// inside a diagram stays text) when the stroke lies mostly inside that text; otherwise the figure whose box,
// with some slack, holds the stroke's centre. Strokes reaching past the model's box still belong to the
// figure, so a clipped axis or curve comes back whole.
export function assignStrokes(components: Component[], regions: Region[], width: number, height: number) {
  const owners = new Int32Array(components.length).fill(-1);
  const slackX = width * .012; const slackY = height * .008;
  const texts = regions.filter((region) => region.text).map((region) => ({ ...region, rect: grow(region.rect, slackX, slackY) }));
  const figures = regions.filter((region) => !region.text);
  const speck = Math.max(4, Math.round(Math.max(width, height) * .005));
  components.forEach((component, index) => {
    if (isSpeck(component, speck)) return;
    const cx = (component.minX + component.maxX) / 2; const cy = (component.minY + component.maxY) / 2;
    const text = texts.filter((region) => contains(region.rect, cx, cy) && overlap(component, region.rect) >= area(component) * .5).sort((a, b) => area(a.rect) - area(b.rect))[0];
    if (text) { owners[index] = text.owner; return; }
    let best = -1; let bestScore = 0;
    for (const figure of figures) {
      const width = figure.rect.maxX - figure.rect.minX; const height = figure.rect.maxY - figure.rect.minY;
      const loose = grow(figure.rect, width * .15, height * .15);
      const score = contains(loose, cx, cy) ? 1 + overlap(component, figure.rect) / Math.max(1, area(component)) : overlap(component, figure.rect) > 0 ? .5 : 0;
      if (score > bestScore) { bestScore = score; best = figure.owner; }
    }
    owners[index] = best;
  });
  return owners;
}

// The figure's extent is the union of its own strokes; specks too small to matter do not stretch it.
export function figureRect(components: Component[], owners: Int32Array, owner: number, width: number, height: number): Rect | null {
  let rect: Rect | null = null;
  components.forEach((component, index) => {
    if (owners[index] !== owner || component.count < 6) return;
    rect = rect ? { minX: Math.min(rect.minX, component.minX), minY: Math.min(rect.minY, component.minY), maxX: Math.max(rect.maxX, component.maxX), maxY: Math.max(rect.maxY, component.maxY) } : { ...component };
  });
  if (!rect) return null;
  const found = rect as Rect;
  const padding = Math.max(6, Math.round(Math.min(found.maxX - found.minX, found.maxY - found.minY) * .04));
  return { minX: Math.max(0, found.minX - padding), minY: Math.max(0, found.minY - padding), maxX: Math.min(width, found.maxX + padding), maxY: Math.min(height, found.maxY + padding) };
}

// Keeps the figure's own strokes on a transparent ground, so the figure sits on the page like the original drawing;
// a one-pixel halo keeps the edges smooth. Everything else in the rectangle — other text, grid dots, paper — is dropped.
export function renderFigure(pixels: Pixels, labels: Int32Array, owners: Int32Array, owner: number, rect: Rect): Pixels {
  const width = rect.maxX - rect.minX; const height = rect.maxY - rect.minY;
  const own = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const label = labels[(rect.minY + y) * pixels.width + rect.minX + x];
    if (label && owners[label - 1] === owner) own[y * width + x] = 1;
  }
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    let keep = own[y * width + x] === 1;
    if (!keep) {
      const label = labels[(rect.minY + y) * pixels.width + rect.minX + x];
      // A halo pixel is paper next to the figure's own ink, never part of another stroke.
      if (!label) for (let dy = -1; dy <= 1 && !keep; dy += 1) for (let dx = -1; dx <= 1 && !keep; dx += 1) {
        const nx = x + dx; const ny = y + dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height && own[ny * width + nx]) keep = true;
      }
    }
    if (!keep) continue;
    // Halo pixels are half transparent: edges stay smooth and a grid dot touching a stroke fades out.
    const source = ((rect.minY + y) * pixels.width + rect.minX + x) * 4; const target = (y * width + x) * 4;
    data[target] = pixels.data[source]; data[target + 1] = pixels.data[source + 1]; data[target + 2] = pixels.data[source + 2];
    data[target + 3] = own[y * width + x] ? 255 : 128;
  }
  return { data, width, height };
}

// All figures of a recognized note, cut from one analysis of the whole screenshot.
export function cutNoteFigures(pixels: Pixels, blocks: RecognizedNoteBlock[]) {
  const { width, height } = pixels;
  const regions: Region[] = []; const figures: RecognizedNoteFigure[] = [];
  const mask = inkMask(pixels);
  for (const block of blocks) {
    if (block.type === "table") {
      // A table's connected frame must never be assigned to a diagram in one cell. Remove only long
      // ruling strokes before finding components; short axes and curves inside the cells stay intact.
      if (block.bbox) {
        const rect = toRect(block.bbox, width, height);
        const lines: number[] = []; const columns: number[] = [];
        for (let y = rect.minY; y < rect.maxY; y += 1) {
          let count = 0;
          for (let x = rect.minX; x < rect.maxX; x += 1) count += mask[y * width + x];
          if (count > (rect.maxX - rect.minX) * .55) lines.push(y);
        }
        for (let x = rect.minX; x < rect.maxX; x += 1) {
          let count = 0;
          for (let y = rect.minY; y < rect.maxY; y += 1) count += mask[y * width + x];
          if (count > (rect.maxY - rect.minY) * .55) columns.push(x);
        }
        for (const y of lines) for (let x = rect.minX; x < rect.maxX; x += 1) mask[y * width + x] = 0;
        for (const x of columns) for (let y = rect.minY; y < rect.maxY; y += 1) mask[y * width + x] = 0;
      }
      for (const row of block.rows) for (const cell of row) {
        if (!cell.figures.length && cell.bbox) regions.push({ owner: -2, text: true, rect: toRect(cell.bbox, width, height) });
        for (const figure of cell.figures) {
          if (figure.captionBox) regions.push({ owner: -2, text: true, rect: toRect(figure.captionBox, width, height) });
          regions.push({ owner: figures.length, text: false, rect: toRect(figure.bbox, width, height) });
          figures.push(figure);
        }
      }
      continue;
    }
    if (block.type !== "figures") { if (block.bbox) regions.push({ owner: -2, text: true, rect: toRect(block.bbox, width, height) }); continue; }
    if (block.sideBox) regions.push({ owner: -2, text: true, rect: toRect(block.sideBox, width, height) });
    for (const figure of block.figures) {
      if (figure.captionBox) regions.push({ owner: -2, text: true, rect: toRect(figure.captionBox, width, height) });
      regions.push({ owner: figures.length, text: false, rect: toRect(figure.bbox, width, height) });
      figures.push(figure);
    }
  }
  const { labels, components } = strokeComponents(mask, width, height, pixels.data);
  const owners = assignStrokes(components, regions, width, height);
  const cuts = new Map<RecognizedNoteFigure, Pixels>();
  figures.forEach((figure, owner) => {
    const rect = figureRect(components, owners, owner, width, height);
    if (rect) cuts.set(figure, renderFigure(pixels, labels, owners, owner, rect));
  });
  return cuts;
}

// Browser side: decode the screenshot once, cut every figure and return each as a PNG data URL.
export async function extractNoteFigures(source: string, blocks: RecognizedNoteBlock[]) {
  const image = new Image(); image.src = source; await image.decode();
  const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("无法读取截图");
  context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const urls = new Map<RecognizedNoteFigure, string>();
  for (const [figure, cut] of cutNoteFigures(pixels, blocks)) {
    const piece = document.createElement("canvas"); piece.width = cut.width; piece.height = cut.height;
    piece.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(cut.data), cut.width, cut.height), 0, 0);
    // Small crops are enlarged with smoothing so they stay crisp in print.
    const scale = Math.min(2, Math.max(1, 720 / cut.width));
    const output = document.createElement("canvas"); output.width = Math.round(cut.width * scale); output.height = Math.round(cut.height * scale);
    const outputContext = output.getContext("2d")!;
    outputContext.imageSmoothingEnabled = true; outputContext.imageSmoothingQuality = "high";
    outputContext.drawImage(piece, 0, 0, output.width, output.height);
    urls.set(figure, output.toDataURL("image/png"));
  }
  return urls;
}
