import type { Question, VectorDiagramPlan } from "./types";
import { combineDiagramRasterFit, MIN_RASTER_FIT_SCORE, scoreProjectionProfiles, validateVectorDiagramPlan } from "./vector-diagram-reconstruction.mjs";

function escapeXml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function svgDataUrl(svg: string) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function printReadyInkColor(color: string, maximumLuminance = 54) {
  const match = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!match) return "#363636";
  const channels = match.slice(1).map((value) => Number.parseInt(value, 16));
  const luminance = channels[0] * .299 + channels[1] * .587 + channels[2] * .114;
  if (luminance <= maximumLuminance) return color.toLowerCase();
  const scale = maximumLuminance / luminance;
  return `#${channels.map((value) => Math.round(value * scale).toString(16).padStart(2, "0")).join("")}`;
}

function loadImage(source: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error("无法读取配图")); image.src = source;
  });
}

function smoothOpenPath(points: Array<{ x: number; y: number }>) {
  const number = (value: number) => value.toFixed(2);
  let path = `M ${number(points[0].x)} ${number(points[0].y)}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const before = points[index - 1] ?? points[index];
    const current = points[index];
    const next = points[index + 1];
    const after = points[index + 2] ?? next;
    const control1 = { x: current.x + (next.x - before.x) / 6, y: current.y + (next.y - before.y) / 6 };
    const control2 = { x: next.x - (after.x - current.x) / 6, y: next.y - (after.y - current.y) / 6 };
    path += ` C ${number(control1.x)} ${number(control1.y)} ${number(control2.x)} ${number(control2.y)} ${number(next.x)} ${number(next.y)}`;
  }
  return path;
}

type Point = { x: number; y: number };
type RenderOptions = { allowSourceAnnotations?: boolean; orthogonalizeAxes?: boolean };
type SvgOptions = { cropToContent?: boolean };

function mainAxis(plan: VectorDiagramPlan, axis: "x" | "y") {
  const exact = plan.strokes.filter((stroke) => {
    const id = stroke.id.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
    return axis === "x" ? /xaxis|axisx|horizontalaxis|横轴/.test(id) : /yaxis|axisy|verticalaxis|纵轴/.test(id);
  });
  const candidates = exact.length ? exact : plan.strokes.filter((stroke) => {
    if (stroke.closed || stroke.dash.length || stroke.points.length > 4) return false;
    const start = stroke.points[0]; const end = stroke.points.at(-1)!;
    const dx = Math.abs(end.x - start.x); const dy = Math.abs(end.y - start.y);
    return axis === "x" ? dx > 320 && dy < dx * .35 : dy > 320 && dx < dy * .35;
  });
  return candidates.sort((a, b) => {
    const length = (stroke: typeof a) => { const start = stroke.points[0]; const end = stroke.points.at(-1)!; return Math.hypot(end.x - start.x, end.y - start.y); };
    return length(b) - length(a);
  })[0];
}

function interpolatedY(points: Point[], targetX: number) {
  const ordered = [...points].sort((a, b) => a.x - b.x);
  const exact = ordered.find((point) => Math.abs(point.x - targetX) < 1e-6);
  if (exact) return exact.y;
  for (let index = 1; index < ordered.length; index += 1) {
    const left = ordered[index - 1]; const right = ordered[index];
    if (left.x <= targetX && right.x >= targetX && right.x > left.x) {
      const position = (targetX - left.x) / (right.x - left.x);
      return left.y + (right.y - left.y) * position;
    }
  }
  return ordered.reduce((closest, point) => Math.abs(point.x - targetX) < Math.abs(closest.x - targetX) ? point : closest).y;
}

export function regularizeQuadraticFunctionPlan(plan: VectorDiagramPlan): VectorDiagramPlan {
  if (plan.diagramType !== "function") return plan;
  const symmetryAxis = plan.strokes.find((stroke) => {
    const id = stroke.id.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, "");
    const start = stroke.points[0]; const end = stroke.points.at(-1)!;
    return /symmetry|axisofsymmetry|对称轴/.test(id) && Math.abs(end.y - start.y) > Math.abs(end.x - start.x) * 2;
  });
  if (!symmetryAxis) return plan;
  const axisX = symmetryAxis.points.reduce((sum, point) => sum + point.x, 0) / symmetryAxis.points.length;
  let changed = false;
  const strokes = plan.strokes.map((stroke) => {
    const id = stroke.id.toLowerCase();
    if (!/(?:parabola|quadratic|抛物|二次)/.test(id) || stroke.closed || stroke.dash.length || stroke.points.length < 8) return stroke;
    const leftPoints = stroke.points.filter((point) => point.x < axisX); const rightPoints = stroke.points.filter((point) => point.x > axisX);
    if (leftPoints.length < 3 || rightPoints.length < 3) return stroke;
    const leftExtent = axisX - Math.min(...leftPoints.map((point) => point.x));
    const rightExtent = Math.max(...rightPoints.map((point) => point.x)) - axisX;
    const span = Math.min(leftExtent, rightExtent); if (span < 80) return stroke;
    const nearVertex = stroke.points.filter((point) => Math.abs(point.x - axisX) <= span * .18);
    const centerY = nearVertex.reduce((sum, point) => sum + point.y, 0) / Math.max(1, nearVertex.length);
    const leftY = interpolatedY(stroke.points, axisX - span); const rightY = interpolatedY(stroke.points, axisX + span);
    const opensUp = centerY > (leftY + rightY) / 2;
    const vertexY = opensUp ? Math.max(...nearVertex.map((point) => point.y)) : Math.min(...nearVertex.map((point) => point.y));
    const endpointY = opensUp ? Math.min(leftY, rightY) : Math.max(leftY, rightY);
    const coefficient = (endpointY - vertexY) / (span * span);
    if (!Number.isFinite(coefficient) || Math.abs(coefficient) < 1e-5) return stroke;
    const pointCount = Math.max(25, Math.min(41, stroke.points.length * 2 + 1));
    const points = Array.from({ length: pointCount }, (_, index) => {
      const x = axisX - span + 2 * span * index / (pointCount - 1);
      return { x, y: Math.max(0, Math.min(1000, vertexY + coefficient * (x - axisX) ** 2)) };
    });
    changed = true;
    return { ...stroke, points };
  });
  return changed ? { ...plan, strokes } : plan;
}

function lineIntersection(a: Point, b: Point, c: Point, d: Point) {
  const u = { x: b.x - a.x, y: b.y - a.y }; const v = { x: d.x - c.x, y: d.y - c.y };
  const determinant = u.x * v.y - u.y * v.x;
  if (Math.abs(determinant) < 1e-6) return null;
  const offset = { x: c.x - a.x, y: c.y - a.y };
  const t = (offset.x * v.y - offset.y * v.x) / determinant;
  return { x: a.x + t * u.x, y: a.y + t * u.y };
}

export function orthogonalizeCoordinatePlan(plan: VectorDiagramPlan): VectorDiagramPlan {
  if (plan.diagramType !== "coordinate" && plan.diagramType !== "function") return plan;
  const xAxis = mainAxis(plan, "x"); const yAxis = mainAxis(plan, "y");
  if (!xAxis || !yAxis) return plan;
  let xStart = xAxis.points[0]; let xEnd = xAxis.points.at(-1)!;
  if (xEnd.x < xStart.x) [xStart, xEnd] = [xEnd, xStart];
  const yStart = yAxis.points[0]; const yEnd = yAxis.points.at(-1)!;
  const origin = lineIntersection(xStart, xEnd, yStart, yEnd); if (!origin) return plan;
  const xLength = Math.hypot(xEnd.x - xStart.x, xEnd.y - xStart.y); const yLength = Math.hypot(yEnd.x - yStart.x, yEnd.y - yStart.y);
  const xUnit = { x: (xEnd.x - xStart.x) / xLength, y: (xEnd.y - xStart.y) / xLength };
  const yUnit = { x: (yEnd.x - yStart.x) / yLength, y: (yEnd.y - yStart.y) / yLength };
  const determinant = xUnit.x * yUnit.y - xUnit.y * yUnit.x;
  if (Math.abs(determinant) < .45) return plan;
  const yDirection = yUnit.y < 0 ? -1 : 1;
  const rectify = (point: Point): Point => {
    const dx = point.x - origin.x; const dy = point.y - origin.y;
    const alongX = (dx * yUnit.y - dy * yUnit.x) / determinant;
    const alongY = (xUnit.x * dy - xUnit.y * dx) / determinant;
    return { x: origin.x + alongX, y: origin.y + alongY * yDirection };
  };
  const rawPoints = [
    ...plan.strokes.flatMap((stroke) => stroke.points.map(rectify)),
    ...plan.labels.map(rectify), ...plan.markers.map(rectify),
    ...plan.ellipses.map((ellipse) => rectify({ x: ellipse.cx, y: ellipse.cy })),
  ];
  const minX = Math.min(...rawPoints.map((point) => point.x)); const maxX = Math.max(...rawPoints.map((point) => point.x));
  const minY = Math.min(...rawPoints.map((point) => point.y)); const maxY = Math.max(...rawPoints.map((point) => point.y));
  const scale = Math.min(1, 960 / Math.max(1, maxX - minX), 960 / Math.max(1, maxY - minY));
  const scaledMinX = minX * scale; const scaledMaxX = maxX * scale; const scaledMinY = minY * scale; const scaledMaxY = maxY * scale;
  const shift = (min: number, max: number) => min < 20 ? 20 - min : max > 980 ? 980 - max : 0;
  const shiftX = shift(scaledMinX, scaledMaxX); const shiftY = shift(scaledMinY, scaledMaxY);
  const present = (point: Point) => { const corrected = rectify(point); return { x: corrected.x * scale + shiftX, y: corrected.y * scale + shiftY }; };
  return {
    ...plan,
    strokes: plan.strokes.map((stroke) => ({ ...stroke, points: stroke.points.map(present), width: stroke.width * scale })),
    ellipses: plan.ellipses.map((ellipse) => {
      const center = present({ x: ellipse.cx, y: ellipse.cy }); const xEdge = present({ x: ellipse.cx + ellipse.rx, y: ellipse.cy }); const yEdge = present({ x: ellipse.cx, y: ellipse.cy + ellipse.ry });
      return { ...ellipse, cx: center.x, cy: center.y, rx: Math.hypot(xEdge.x - center.x, xEdge.y - center.y), ry: Math.hypot(yEdge.x - center.x, yEdge.y - center.y), width: ellipse.width * scale };
    }),
    labels: plan.labels.map((label) => ({ ...label, ...present(label), fontSize: label.fontSize * scale })),
    markers: plan.markers.map((marker) => ({ ...marker, ...present(marker), radius: marker.radius * scale })),
  };
}

function diagramViewport(plan: VectorDiagramPlan, cropToContent = false) {
  const full = { x: 0, y: 0, width: 1000, height: 1000 / plan.sourceAspectRatio };
  if (!cropToContent) return full;
  const y = (value: number) => value / plan.sourceAspectRatio;
  const points: Point[] = [
    ...plan.strokes.flatMap((stroke) => stroke.points.map((point) => ({ x: point.x, y: y(point.y) }))),
    ...plan.markers.flatMap((marker) => [{ x: marker.x - marker.radius, y: y(marker.y) - marker.radius }, { x: marker.x + marker.radius, y: y(marker.y) + marker.radius }]),
    ...plan.ellipses.flatMap((ellipse) => [{ x: ellipse.cx - ellipse.rx, y: y(ellipse.cy - ellipse.ry) }, { x: ellipse.cx + ellipse.rx, y: y(ellipse.cy + ellipse.ry) }]),
    ...plan.labels.flatMap((label) => {
      const halfWidth = Math.max(label.fontSize * .35, label.text.length * label.fontSize * .32);
      return [{ x: label.x - halfWidth, y: y(label.y) - label.fontSize * .7 }, { x: label.x + halfWidth, y: y(label.y) + label.fontSize * .7 }];
    }),
  ];
  if (!points.length) return full;
  const minX = Math.min(...points.map((point) => point.x)); const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y)); const maxY = Math.max(...points.map((point) => point.y));
  const padding = Math.max(28, Math.min(60, Math.max(maxX - minX, maxY - minY) * .045));
  return { x: minX - padding, y: minY - padding, width: maxX - minX + padding * 2, height: maxY - minY + padding * 2 };
}

export function vectorDiagramAspectRatio(plan: VectorDiagramPlan, options: SvgOptions = {}) {
  const viewport = diagramViewport(plan, options.cropToContent);
  return viewport.width / viewport.height;
}

export function svgFromVectorDiagramPlan(plan: VectorDiagramPlan, options: SvgOptions = {}) {
  const validation = validateVectorDiagramPlan(plan);
  if (!validation.ok) throw new Error(validation.error || "矢量重绘方案无效");
  const viewport = diagramViewport(plan, options.cropToContent);
  const y = (value: number) => value / plan.sourceAspectRatio;
  const strokes = plan.strokes.map((stroke) => {
    const scaledPoints = stroke.points.map((point) => ({ x: point.x, y: y(point.y) }));
    const dash = stroke.dash.length ? ` stroke-dasharray="${stroke.dash.join(" ")}"` : "";
    if (plan.diagramType === "function" && !stroke.closed && !stroke.dash.length && scaledPoints.length >= 8) {
      return `<path id="${escapeXml(stroke.id)}" d="${smoothOpenPath(scaledPoints)}" fill="none" stroke="${stroke.color}" stroke-width="${stroke.width}" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    const points = scaledPoints.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
    return `<polyline id="${escapeXml(stroke.id)}" points="${points}" fill="${stroke.closed ? "#ffffff" : "none"}" stroke="${stroke.color}" stroke-width="${stroke.width}"${dash} stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join("");
  const ellipses = plan.ellipses.map((ellipse) => {
    const dash = ellipse.dash.length ? ` stroke-dasharray="${ellipse.dash.join(" ")}"` : "";
    return `<ellipse id="${escapeXml(ellipse.id)}" cx="${ellipse.cx}" cy="${y(ellipse.cy)}" rx="${ellipse.rx}" ry="${ellipse.ry / plan.sourceAspectRatio}" fill="none" stroke="${ellipse.color}" stroke-width="${ellipse.width}"${dash}/>`;
  }).join("");
  const markers = plan.markers.map((marker) => `<circle cx="${marker.x}" cy="${y(marker.y)}" r="${marker.radius}" fill="${marker.color}"/>`).join("");
  const labels = plan.labels.map((label) => `<text x="${label.x}" y="${y(label.y)}" text-anchor="${label.anchor}" dominant-baseline="middle" fill="${label.color}" font-family="Times New Roman, STIX Two Text, serif" font-size="${label.fontSize}" font-style="${label.italic ? "italic" : "normal"}" font-weight="${label.bold ? "700" : "400"}">${escapeXml(label.text)}</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewport.x.toFixed(3)} ${viewport.y.toFixed(3)} ${viewport.width.toFixed(3)} ${viewport.height.toFixed(3)}" width="${viewport.width.toFixed(3)}" height="${viewport.height.toFixed(3)}" role="img" aria-label="高清矢量数学配图"><rect x="${viewport.x.toFixed(3)}" y="${viewport.y.toFixed(3)}" width="${viewport.width.toFixed(3)}" height="${viewport.height.toFixed(3)}" fill="#ffffff"/>${strokes}${ellipses}${markers}${labels}</svg>`;
}

async function rasterizeSvg(svg: string, aspectRatio?: number) {
  const image = await loadImage(svgDataUrl(svg));
  const width = 1400; const height = Math.max(aspectRatio === undefined ? 1 : 350, Math.round(width / (aspectRatio ?? image.naturalWidth / image.naturalHeight)));
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d"); if (!context) throw new Error("浏览器无法生成高清配图");
  context.fillStyle = "#ffffff"; context.fillRect(0, 0, width, height); context.imageSmoothingEnabled = true; context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, width, height);
  return canvas.toDataURL("image/png");
}

// Reuse the saved presentation SVG: rebuilding the raw plan would lose any
// axis/curve corrections. Only the exported copy gets darker, printable strokes.
export async function questionImageForPrint(question: Question | undefined, source: string) {
  if (question?.diagramSource !== "svg-ai" || source !== question.diagramImage || !question.vectorDiagramSvg) return source;
  const svg = question.vectorDiagramSvg;
  const viewWidth = Number(svg.match(/viewBox="[\d.e+-]+\s+[\d.e+-]+\s+([\d.e+-]+)/i)?.[1]) || 1000;
  const printable = svg.replace(/stroke-width="([\d.]+)"/g, (_, width: string) => `stroke-width="${Math.max(Number(width), viewWidth * .006)}"`)
    .replace(/\b(stroke|fill)="(#[\da-f]{6})"/gi, (whole, attribute: string, color: string) => {
      const channels = color.slice(1).match(/../g)!.map((channel) => Number.parseInt(channel, 16));
      return color.toLowerCase() !== "#ffffff" && Math.max(...channels) - Math.min(...channels) <= 16 ? `${attribute}="#000000"` : whole;
    });
  return rasterizeSvg(printable);
}

async function sourceInkColor(source: string, aspectRatio: number) {
  const image = await loadImage(source); const width = 220; const height = Math.max(80, Math.round(width / aspectRatio));
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true }); if (!context) return "#231f20";
  context.fillStyle = "#ffffff"; context.fillRect(0, 0, width, height); context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data; const threshold = otsuThreshold(pixels);
  const samples: Array<{ red: number; green: number; blue: number; luminance: number }> = [];
  for (let index = 0; index < pixels.length; index += 4) {
    const red = pixels[index]; const green = pixels[index + 1]; const blue = pixels[index + 2]; const luminance = red * .299 + green * .587 + blue * .114;
    if (luminance < threshold) samples.push({ red, green, blue, luminance });
  }
  if (!samples.length) return "#231f20";
  samples.sort((a, b) => a.luminance - b.luminance);
  const darkest = samples.slice(0, Math.max(1, Math.ceil(samples.length * .28)));
  const median = (channel: "red" | "green" | "blue") => darkest.map((sample) => sample[channel]).sort((a, b) => a - b)[Math.floor(darkest.length / 2)];
  const hex = (value: number) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0");
  return `#${hex(median("red"))}${hex(median("green"))}${hex(median("blue"))}`;
}

function otsuThreshold(data: Uint8ClampedArray) {
  const histogram = new Uint32Array(256); let total = 0; let sum = 0;
  for (let index = 0; index < data.length; index += 4) {
    const value = Math.round(data[index] * .299 + data[index + 1] * .587 + data[index + 2] * .114);
    histogram[value] += 1; total += 1; sum += value;
  }
  let backgroundWeight = 0; let backgroundSum = 0; let bestVariance = -1; let best = 210;
  for (let value = 0; value < 256; value += 1) {
    backgroundWeight += histogram[value]; if (!backgroundWeight) continue;
    const foregroundWeight = total - backgroundWeight; if (!foregroundWeight) break;
    backgroundSum += value * histogram[value];
    const backgroundMean = backgroundSum / backgroundWeight; const foregroundMean = (sum - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;
    if (variance > bestVariance) { bestVariance = variance; best = value; }
  }
  return Math.max(80, Math.min(235, best + 18));
}

function dilate(mask: Uint8Array, width: number, height: number, radius = 2) {
  const result = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    if (!mask[y * width + x]) continue;
    for (let dy = -radius; dy <= radius; dy += 1) for (let dx = -radius; dx <= radius; dx += 1) {
      const nx = x + dx; const ny = y + dy; if (nx >= 0 && nx < width && ny >= 0 && ny < height) result[ny * width + nx] = 1;
    }
  }
  return result;
}

async function rasterMask(source: string, aspectRatio: number) {
  const image = await loadImage(source); const width = 256; const height = Math.max(96, Math.round(width / aspectRatio));
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true }); if (!context) throw new Error("无法比较配图");
  context.fillStyle = "#ffffff"; context.fillRect(0, 0, width, height); context.drawImage(image, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height).data; const threshold = otsuThreshold(pixels); const mask = new Uint8Array(width * height);
  const xProfile = new Array<number>(width).fill(0); const yProfile = new Array<number>(height).fill(0);
  let minX = width; let minY = height; let maxX = -1; let maxY = -1; let count = 0; const inkValues: number[] = [];
  for (let index = 0; index < mask.length; index += 1) {
    const offset = index * 4; const luminance = pixels[offset] * .299 + pixels[offset + 1] * .587 + pixels[offset + 2] * .114;
    if (luminance >= threshold) continue;
    mask[index] = 1; count += 1; inkValues.push(luminance); const x = index % width; const y = Math.floor(index / width);
    xProfile[x] += 1; yProfile[y] += 1; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  inkValues.sort((a, b) => a - b); const inkLuminance = inkValues[Math.floor(inkValues.length * .2)] ?? 255;
  return { mask, dilated: dilate(mask, width, height), width, height, count, inkLuminance, xProfile, yProfile, box: { minX, minY, maxX, maxY } };
}

function boxSimilarity(a: { minX: number; minY: number; maxX: number; maxY: number }, b: { minX: number; minY: number; maxX: number; maxY: number }, width: number, height: number) {
  if (a.maxX < 0 || b.maxX < 0) return 0;
  const error = (Math.abs(a.minX - b.minX) + Math.abs(a.maxX - b.maxX)) / (2 * width) + (Math.abs(a.minY - b.minY) + Math.abs(a.maxY - b.maxY)) / (2 * height);
  return Math.max(0, 1 - error * 2.5);
}

export async function scoreDiagramRasterFit(reference: string, rendered: string, aspectRatio: number, options: RenderOptions = {}) {
  const [source, output] = await Promise.all([rasterMask(reference, aspectRatio), rasterMask(rendered, aspectRatio)]);
  let sourceHit = 0; let outputHit = 0;
  for (let index = 0; index < source.mask.length; index += 1) {
    if (source.mask[index] && output.dilated[index]) sourceHit += 1;
    if (output.mask[index] && source.dilated[index]) outputHit += 1;
  }
  const recall = source.count ? sourceHit / source.count : 0; const precision = output.count ? outputHit / output.count : 0;
  const projectionScore = (scoreProjectionProfiles(source.xProfile, output.xProfile) + scoreProjectionProfiles(source.yProfile, output.yProfile)) / 2;
  const boundsScore = boxSimilarity(source.box, output.box, source.width, source.height);
  const toneScore = Math.max(0, 1 - Math.abs(source.inkLuminance - output.inkLuminance) / 160);
  const combined = combineDiagramRasterFit({ precision, recall, projectionScore, boundsScore, toneScore }, options.allowSourceAnnotations);
  return { ...combined, projectionScore, boundsScore, toneScore, precision, recall };
}

export class VectorDiagramFitError extends Error {
  feedback: string[];
  constructor(fit: Awaited<ReturnType<typeof scoreDiagramRasterFit>>) {
    super(`高清矢量重绘与原图的综合匹配度只有 ${Math.round(fit.score * 100)}%`);
    this.name = "VectorDiagramFitError";
    this.feedback = [
      `综合视觉匹配度 ${Math.round(fit.score * 100)}%，必须达到 ${Math.round(MIN_RASTER_FIT_SCORE * 100)}%。`,
      `线条与标签轮廓 ${Math.round(fit.contourScore * 100)}%，横纵分布 ${Math.round(fit.projectionScore * 100)}%，四周留白 ${Math.round(fit.boundsScore * 100)}%，墨色 ${Math.round(fit.toneScore * 100)}%。`,
      "请修正印刷题图的 strokes、labels、markers 坐标、线宽与字号；学生手写计算、圈画、勾选及后加辅助线必须继续排除。",
    ];
  }
}

export async function renderVectorDiagramPlan(plan: VectorDiagramPlan, referenceImage: string, options: RenderOptions = {}) {
  const sourceColor = await sourceInkColor(referenceImage, plan.sourceAspectRatio);
  const stylePlan = (color: string): VectorDiagramPlan => ({
    ...plan,
    strokes: plan.strokes.map((stroke) => ({ ...stroke, color, width: Math.max(3.5, stroke.width) })),
    ellipses: plan.ellipses.map((ellipse) => ({ ...ellipse, color, width: Math.max(3.5, ellipse.width) })),
    labels: plan.labels.map((label) => ({ ...label, color })),
    markers: plan.markers.map((marker) => ({ ...marker, color })),
  });
  const sourcePlan = stylePlan(sourceColor);
  const sourceSvg = svgFromVectorDiagramPlan(sourcePlan); const sourceImage = await rasterizeSvg(sourceSvg, plan.sourceAspectRatio);
  const fit = await scoreDiagramRasterFit(referenceImage, sourceImage, plan.sourceAspectRatio, options);
  if (fit.score < MIN_RASTER_FIT_SCORE) throw new VectorDiagramFitError(fit);
  const printPlan = stylePlan(printReadyInkColor(sourceColor));
  const axesPlan = options.orthogonalizeAxes === false ? printPlan : orthogonalizeCoordinatePlan(printPlan);
  const presentationPlan = regularizeQuadraticFunctionPlan(axesPlan);
  const svgOptions = { cropToContent: presentationPlan.diagramType === "function" };
  const presentationAspectRatio = vectorDiagramAspectRatio(presentationPlan, svgOptions);
  const svg = svgFromVectorDiagramPlan(presentationPlan, svgOptions); const image = await rasterizeSvg(svg, presentationAspectRatio);
  return { image, svg, visualFitScore: fit.score, fit, presentationAspectRatio, axesOrthogonalized: axesPlan !== printPlan, curveRegularized: presentationPlan !== axesPlan };
}
