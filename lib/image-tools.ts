import type { ClipboardEvent as ReactClipboardEvent } from "react";
import { fitWithinMaxEdge, normalizeDiagramRotation } from "./image-processing-rules.mjs";
import { strokeComponents } from "./note-figures";
import type { DiagramKind, DiagramRotation } from "./types";

export type NormalizedBox = { x: number; y: number; width: number; height: number };
type PixelBox = { minX: number; minY: number; maxX: number; maxY: number };
type CropOptions = { photographed?: boolean; rotation?: DiagramRotation; kind?: DiagramKind };

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file);
  });
}

export function clipboardImage(event: ReactClipboardEvent): File | null {
  for (const item of Array.from(event.clipboardData.items)) if (item.type.startsWith("image/")) return item.getAsFile();
  return null;
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = source; });
}

export async function imageAspectRatio(source: string) {
  const image = await loadImage(source);
  return image.naturalWidth / Math.max(1, image.naturalHeight);
}

function normalizedToPixels(box: NormalizedBox, image: HTMLImageElement): PixelBox {
  return {
    minX: Math.max(0, Math.floor(box.x / 1000 * image.naturalWidth)), minY: Math.max(0, Math.floor(box.y / 1000 * image.naturalHeight)),
    maxX: Math.min(image.naturalWidth, Math.ceil((box.x + box.width) / 1000 * image.naturalWidth)), maxY: Math.min(image.naturalHeight, Math.ceil((box.y + box.height) / 1000 * image.naturalHeight)),
  };
}

// The figure is every stroke lying mostly inside the model's box (with a little slack), taken whole, so a
// clipped axis or label comes back complete and side-by-side figures (图1, 图2) all stay. Strokes outside it —
// the question text above, a page frame — are not part of the figure: their pixels are listed so the crop can
// paint them white. Returns null when the box holds no ink.
export function diagramInk(data: Uint8ClampedArray, width: number, height: number, target: PixelBox) {
  const mask = new Uint8Array(width * height);
  for (let index = 0; index < mask.length; index += 1) {
    const offset = index * 4; const luminance = data[offset] * .299 + data[offset + 1] * .587 + data[offset + 2] * .114;
    if (data[offset + 3] > 20 && luminance < 218) mask[index] = 1;
  }
  const { labels, components } = strokeComponents(mask, width, height);
  const slackX = Math.max(4, (target.maxX - target.minX) * .02); const slackY = Math.max(4, (target.maxY - target.minY) * .02);
  const zone = { minX: target.minX - slackX, minY: target.minY - slackY, maxX: target.maxX + slackX, maxY: target.maxY + slackY };
  const kept = components.map((item) => {
    const inside = Math.max(0, Math.min(item.maxX, zone.maxX) - Math.max(item.minX, zone.minX)) * Math.max(0, Math.min(item.maxY, zone.maxY) - Math.max(item.minY, zone.minY));
    return item.count >= 4 && inside >= (item.maxX - item.minX) * (item.maxY - item.minY) * .5;
  });
  // The box may stop short of the drawing (a row of squares cut in half). Strokes within a few pixels of the figure
  // belong to it, and so do labels sitting inside one of its shapes; text a line away does not touch it.
  const reach = 3;
  // A page frame or ruled border is never part of the figure, even where the figure touches it.
  const fits = (item: { minX: number; minY: number; maxX: number; maxY: number }) => item.maxX - item.minX <= (target.maxX - target.minX) * 1.5 && item.maxY - item.minY <= (target.maxY - target.minY) * 1.5;
  for (let pass = 0; pass < 6; pass += 1) {
    const near = new Uint8Array(width * height);
    for (let index = 0; index < labels.length; index += 1) {
      if (!labels[index] || !kept[labels[index] - 1]) continue;
      const x = index % width; const y = (index - x) / width;
      for (let dy = -reach; dy <= reach; dy += 1) for (let dx = -reach; dx <= reach; dx += 1) {
        const nx = x + dx; const ny = y + dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height) near[ny * width + nx] = 1;
      }
    }
    let added = false;
    for (let index = 0; index < labels.length; index += 1) {
      const label = labels[index];
      if (label && near[index] && !kept[label - 1] && components[label - 1].count >= 4 && fits(components[label - 1])) { kept[label - 1] = true; added = true; }
    }
    const shapes = components.filter((item, index) => kept[index] && item.maxX - item.minX >= 24 && item.maxY - item.minY >= 24);
    components.forEach((item, index) => {
      if (kept[index] || item.count < 4) return;
      const cx = (item.minX + item.maxX) / 2; const cy = (item.minY + item.maxY) / 2;
      if (shapes.some((shape) => cx > shape.minX && cx < shape.maxX && cy > shape.minY && cy < shape.maxY && item.maxX - item.minX < (shape.maxX - shape.minX) / 2)) { kept[index] = true; added = true; }
    });
    if (!added) break;
  }
  // Tick labels under a number line, axis names and 图1/图2 under figures sit a little apart from the drawing, often
  // just past the model's box. A row of small, spaced-out marks right above or below the figure and within its width
  // belongs to it; a line of the question's text is dense or runs past the figure, so it stays out.
  const keptBox = (): PixelBox | null => components.reduce<PixelBox | null>((box, item, index) => !kept[index] ? box : box
    ? { minX: Math.min(box.minX, item.minX), minY: Math.min(box.minY, item.minY), maxX: Math.max(box.maxX, item.maxX), maxY: Math.max(box.maxY, item.maxY) }
    : { minX: item.minX, minY: item.minY, maxX: item.maxX, maxY: item.maxY }, null);
  const figure = keptBox();
  if (figure) {
    const tall = figure.maxY - figure.minY; const gap = Math.max(12, tall * .15); const slack = (figure.maxX - figure.minX) * .02 + 4;
    const band = components.map((item, index) => ({ item, index })).filter(({ item, index }) => !kept[index] && item.count >= 4 && item.maxY - item.minY <= Math.max(14, tall * .25)
      && ((item.minY >= figure.maxY - 1 && item.minY - figure.maxY <= gap) || (item.maxY <= figure.minY + 1 && figure.minY - item.maxY <= gap)));
    const rows: Array<typeof band> = [];
    for (const entry of [...band].sort((a, b) => a.item.minY - b.item.minY)) {
      const row = rows.find((candidate) => candidate.some(({ item }) => item.minY < entry.item.maxY && entry.item.minY < item.maxY));
      if (row) row.push(entry); else rows.push([entry]);
    }
    for (const row of rows) {
      const minX = Math.min(...row.map(({ item }) => item.minX)); const maxX = Math.max(...row.map(({ item }) => item.maxX));
      const height = Math.max(...row.map(({ item }) => item.maxY)) - Math.min(...row.map(({ item }) => item.minY));
      const covered = row.reduce((sum, { item }) => sum + item.maxX - item.minX, 0) / Math.max(1, maxX - minX);
      const within = minX >= figure.minX - slack && maxX <= figure.maxX + slack;
      if (within && (covered < .6 || maxX - minX <= height * 3)) for (const { index } of row) kept[index] = true;
    }
  }
  let found: PixelBox | null = null;
  components.forEach((item, index) => {
    if (!kept[index]) return;
    found = found ? { minX: Math.min(found.minX, item.minX), minY: Math.min(found.minY, item.minY), maxX: Math.max(found.maxX, item.maxX), maxY: Math.max(found.maxY, item.maxY) } : { ...item };
  });
  if (!found) return null;
  const union = found as PixelBox; const padding = Math.max(8, Math.round(Math.min(union.maxX - union.minX, union.maxY - union.minY) * .05));
  const rect = { minX: Math.max(0, union.minX - padding), minY: Math.max(0, union.minY - padding), maxX: Math.min(width, union.maxX + padding), maxY: Math.min(height, union.maxY + padding) };
  // Foreign ink plus its one-pixel antialiased edge, unless that edge also touches the figure.
  const foreign = new Uint8Array(width * height);
  for (let y = rect.minY; y < rect.maxY; y += 1) for (let x = rect.minX; x < rect.maxX; x += 1) {
    const label = labels[y * width + x];
    if (label) { if (!kept[label - 1]) foreign[y * width + x] = 1; continue; }
    let other = false; let own = false;
    for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) {
      const nx = x + dx; const ny = y + dy; if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const near = labels[ny * width + nx]; if (near) { if (kept[near - 1]) own = true; else other = true; }
    }
    if (other && !own) foreign[y * width + x] = 1;
  }
  return { rect, foreign };
}

function photoThreshold(data: Uint8ClampedArray) {
  const histogram = new Uint32Array(256); let total = 0; let sum = 0;
  for (let index = 0; index < data.length; index += 4) {
    const value = Math.round(data[index] * .299 + data[index + 1] * .587 + data[index + 2] * .114);
    histogram[value] += 1; total += 1; sum += value;
  }
  let weight = 0; let weightedSum = 0; let best = 190; let bestVariance = -1;
  for (let value = 0; value < 256; value += 1) {
    weight += histogram[value]; if (!weight) continue;
    const foreground = total - weight; if (!foreground) break;
    weightedSum += value * histogram[value];
    const variance = weight * foreground * (weightedSum / weight - (sum - weightedSum) / foreground) ** 2;
    if (variance > bestVariance) { bestVariance = variance; best = value; }
  }
  return Math.max(175, Math.min(232, best + 32));
}

function paddedBox(box: PixelBox, image: HTMLImageElement, amount = .08): PixelBox {
  const width = box.maxX - box.minX; const height = box.maxY - box.minY;
  return {
    minX: Math.max(0, Math.floor(box.minX - width * amount)), minY: Math.max(0, Math.floor(box.minY - height * amount)),
    maxX: Math.min(image.naturalWidth, Math.ceil(box.maxX + width * amount)), maxY: Math.min(image.naturalHeight, Math.ceil(box.maxY + height * amount)),
  };
}

function rotateCanvas180(source: HTMLCanvasElement) {
  const output = document.createElement("canvas"); output.width = source.width; output.height = source.height;
  const context = output.getContext("2d"); if (!context) return source;
  context.fillStyle = "#fff"; context.fillRect(0, 0, output.width, output.height);
  context.translate(output.width, output.height); context.rotate(Math.PI); context.drawImage(source, 0, 0);
  return output;
}

function orientCoordinateDiagram(source: HTMLCanvasElement) {
  const width = 240; const height = Math.max(100, Math.round(width * source.height / Math.max(1, source.width)));
  const sample = document.createElement("canvas"); sample.width = width; sample.height = height;
  const context = sample.getContext("2d", { willReadFrequently: true }); if (!context) return source;
  context.fillStyle = "#fff"; context.fillRect(0, 0, width, height); context.drawImage(source, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data; const mask = new Uint8Array(width * height);
  for (let index = 0; index < mask.length; index += 1) {
    const offset = index * 4; const luminance = pixels[offset] * .299 + pixels[offset + 1] * .587 + pixels[offset + 2] * .114;
    if (luminance < 185) mask[index] = 1;
  }
  let axisY = 0; let horizontalBest = 0;
  for (let y = Math.round(height * .12); y < height * .88; y += 1) {
    let count = 0; for (let x = Math.round(width * .08); x < width * .92; x += 1) count += mask[y * width + x];
    if (count > horizontalBest) { horizontalBest = count; axisY = y; }
  }
  let axisX = 0; let verticalBest = 0;
  for (let x = Math.round(width * .12); x < width * .88; x += 1) {
    let count = 0; for (let y = Math.round(height * .08); y < height * .92; y += 1) count += mask[y * width + x];
    if (count > verticalBest) { verticalBest = count; axisX = x; }
  }
  if (horizontalBest < width * .18 || verticalBest < height * .18) return source;
  const patchInk = (cx: number, cy: number) => {
    let count = 0;
    for (let y = Math.max(0, cy - 13); y <= Math.min(height - 1, cy + 13); y += 1) for (let x = Math.max(0, cx - 13); x <= Math.min(width - 1, cx + 13); x += 1) count += mask[y * width + x];
    return count;
  };
  const horizontalInk = Array.from({ length: width }, (_, x) => mask[axisY * width + x] + (axisY ? mask[(axisY - 1) * width + x] : 0) + (axisY + 1 < height ? mask[(axisY + 1) * width + x] : 0));
  const verticalInk = Array.from({ length: height }, (_, y) => mask[y * width + axisX] + (axisX ? mask[y * width + axisX - 1] : 0) + (axisX + 1 < width ? mask[y * width + axisX + 1] : 0));
  const left = horizontalInk.findIndex((value) => value > 0); const right = horizontalInk.findLastIndex((value) => value > 0);
  const top = verticalInk.findIndex((value) => value > 0); const bottom = verticalInk.findLastIndex((value) => value > 0);
  if (left < 0 || right < 0 || top < 0 || bottom < 0) return source;
  const leftScore = patchInk(left, axisY); const rightScore = patchInk(right, axisY); const topScore = patchInk(axisX, top); const bottomScore = patchInk(axisX, bottom);
  return leftScore > rightScore * 1.08 && bottomScore > topScore * 1.08 ? rotateCanvas180(source) : source;
}

function renderCleanCrop(image: HTMLImageElement | HTMLCanvasElement, box: PixelBox, options: CropOptions = {}): string {
  const sourceWidth = Math.max(1, box.maxX - box.minX); const sourceHeight = Math.max(1, box.maxY - box.minY); const scale = Math.min(2.2, Math.max(1, 900 / sourceWidth));
  const crop = document.createElement("canvas"); crop.width = Math.round(sourceWidth * scale); crop.height = Math.round(sourceHeight * scale);
  const cropContext = crop.getContext("2d"); if (!cropContext) throw new Error("无法处理配图");
  cropContext.fillStyle = "#fff"; cropContext.fillRect(0, 0, crop.width, crop.height); cropContext.imageSmoothingEnabled = true; cropContext.imageSmoothingQuality = "high";
  cropContext.drawImage(image, box.minX, box.minY, sourceWidth, sourceHeight, 0, 0, crop.width, crop.height);
  const rotation = normalizeDiagramRotation(options.rotation); const swap = rotation === 90 || rotation === 270;
  const canvas = document.createElement("canvas"); canvas.width = swap ? crop.height : crop.width; canvas.height = swap ? crop.width : crop.height;
  const context = canvas.getContext("2d", { willReadFrequently: true }); if (!context) throw new Error("无法处理配图");
  context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height); context.imageSmoothingEnabled = true; context.imageSmoothingQuality = "high";
  context.save();
  if (rotation === 90) { context.translate(canvas.width, 0); context.rotate(Math.PI / 2); }
  else if (rotation === 180) { context.translate(canvas.width, canvas.height); context.rotate(Math.PI); }
  else if (rotation === 270) { context.translate(0, canvas.height); context.rotate(-Math.PI / 2); }
  context.drawImage(crop, 0, 0); context.restore();
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height); const pixels = imageData.data;
  const adaptiveThreshold = options.photographed ? photoThreshold(pixels) : 238;
  for (let index = 0; index < pixels.length; index += 4) {
    const luminance = pixels[index] * .299 + pixels[index + 1] * .587 + pixels[index + 2] * .114;
    if (luminance > adaptiveThreshold || pixels[index + 3] < 20) { pixels[index] = 255; pixels[index + 1] = 255; pixels[index + 2] = 255; pixels[index + 3] = 255; }
    else if (options.photographed) { const value = Math.max(0, Math.min(246, (luminance - adaptiveThreshold) * 1.45 + 246)); pixels[index] = value; pixels[index + 1] = value; pixels[index + 2] = value; pixels[index + 3] = 255; }
    else { pixels[index] = Math.max(0, Math.min(255, (pixels[index] - 128) * 1.12 + 128)); pixels[index + 1] = Math.max(0, Math.min(255, (pixels[index + 1] - 128) * 1.12 + 128)); pixels[index + 2] = Math.max(0, Math.min(255, (pixels[index + 2] - 128) * 1.12 + 128)); }
  }
  context.putImageData(imageData, 0, 0);
  const oriented = options.photographed && (options.kind === "coordinate" || options.kind === "function") ? orientCoordinateDiagram(canvas) : canvas;
  return oriented.toDataURL("image/png");
}

export async function cropDataUrl(source: string, box: NormalizedBox, options: CropOptions = {}): Promise<string> {
  if (options.photographed) {
    const image = await loadImage(source);
    return renderCleanCrop(image, paddedBox(normalizedToPixels(box, image), image, .04), options);
  }
  // The whole screenshot is read: a box drawn short must not cut the drawing's strokes before they are judged.
  const image = await loadImage(source); const target = normalizedToPixels(box, image); const width = image.naturalWidth; const height = image.naturalHeight;
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height; const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return renderCleanCrop(image, target); context.fillStyle = "#fff"; context.fillRect(0, 0, width, height); context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, width, height);
  const ink = diagramInk(pixels.data, width, height, target);
  if (!ink) return renderCleanCrop(image, target);
  ink.foreign.forEach((flag, index) => { if (flag) pixels.data.fill(255, index * 4, index * 4 + 4); });
  context.putImageData(pixels, 0, 0);
  return renderCleanCrop(canvas, ink.rect);
}

export async function cropExactDataUrl(source: string, box: NormalizedBox): Promise<string> {
  const image = await loadImage(source); return renderCleanCrop(image, normalizedToPixels(box, image));
}

export async function materializeImageDataUrl(source: string, maxEdge = 1800): Promise<string> {
  const image = await loadImage(source); const size = fitWithinMaxEdge(image.naturalWidth, image.naturalHeight, maxEdge);
  if (source.startsWith("data:image/") && size.scale === 1) return source;
  const canvas = document.createElement("canvas"); canvas.width = size.width; canvas.height = size.height;
  const context = canvas.getContext("2d"); if (!context) throw new Error("无法读取图片");
  context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height); context.imageSmoothingEnabled = true; context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, canvas.width, canvas.height); return canvas.toDataURL("image/jpeg", .88);
}

export async function compressDataUrl(source: string, maxEdge = 1800): Promise<string> {
  return materializeImageDataUrl(source, maxEdge);
}
