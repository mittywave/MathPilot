import test from "node:test";
import assert from "node:assert/strict";
import { loadSource } from "./load-source.mjs";
import { readFile } from "node:fs/promises";
import { PNG } from "pngjs";

const { cutNoteFigures } = await loadSource("lib/note-figures.ts");

// A synthetic handwritten note: dotted paper, a coordinate figure, a caption written inside it and a line of text above.
function note() {
  const width = 300; const height = 220; const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const paint = (x0, y0, x1, y1, color) => {
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) { const o = (y * width + x) * 4; [data[o], data[o + 1], data[o + 2]] = color; }
  };
  for (let y = 5; y < height; y += 20) for (let x = 5; x < width; x += 20) paint(x, y, x + 2, y + 2, [168, 178, 210]); // grid dots
  const blue = [40, 100, 220]; const black = [20, 20, 20];
  paint(30, 130, 210, 132, blue);   // x-axis
  paint(100, 40, 102, 200, blue);   // y-axis, reaching below the model's box
  paint(150, 55, 156, 64, blue);    // label A
  paint(120, 150, 180, 156, [255, 225, 120]); // a highlighted region
  for (let x = 112; x < 172; x += 10) paint(x, 178, x + 6, 188, black); // caption characters inside the figure
  for (let x = 40; x < 200; x += 12) paint(x, 12, x + 8, 22, black);    // text line above
  return { pixels: { data, width, height }, at: (x, y) => [...data.slice((y * width + x) * 4, (y * width + x) * 4 + 3)] };
}
const box = (x, y, w, h, width = 300, height = 220) => ({ x: x / width * 1000, y: y / height * 1000, width: w / width * 1000, height: h / height * 1000 });

test("a figure is cut from its own strokes: whole axes, no caption, no grid dots", () => {
  const { pixels } = note();
  const figure = { bbox: box(50, 50, 140, 100), caption: "$O$ 可在 $y$ 轴上移动", captionBox: box(108, 174, 70, 18) };
  const cuts = cutNoteFigures(pixels, [
    { type: "paragraph", text: "上面的一行字", bbox: box(36, 8, 170, 18) },
    { type: "figures", figures: [figure], side: "", sideBox: null },
  ]);
  const cut = cuts.get(figure);
  assert.ok(cut, "the figure is cut");
  // The model's box stopped at x=50 and y=150; the strokes run from x=30 and down to y=200.
  assert.ok(cut.width >= 180 && cut.width <= 200, `width ${cut.width}`);
  assert.ok(cut.height >= 160 && cut.height <= 175, `height ${cut.height}`);
  const left = Math.round((cut.width - 180) / 2);
  const pixel = (x, y) => [...cut.data.slice((y * cut.width + x) * 4, (y * cut.width + x) * 4 + 3)];
  const alpha = (x, y) => cut.data[(y * cut.width + x) * 4 + 3];
  const top = Math.round((cut.height - 160) / 2);
  assert.deepEqual(pixel(left + 70, top + 50), [40, 100, 220], "the y-axis keeps its colour");
  assert.deepEqual(pixel(left + 70, top + 155), [40, 100, 220], "including the part below the model's box");
  assert.equal(alpha(left + 70, top + 50), 255);
  assert.equal(alpha(2, 2), 0, "paper is transparent");
  let ink = 0; let dots = 0;
  for (let y = 0; y < cut.height; y += 1) for (let x = 0; x < cut.width; x += 1) {
    const [r, g, b] = pixel(x, y);
    if (!alpha(x, y)) continue;
    if (r < 60 && g < 60 && b < 60) ink += 1;
    if (r === 168 && g === 178 && b === 210) dots += 1;
  }
  assert.equal(ink, 0, "the caption written inside the figure and the text above are painted out");
  assert.equal(dots, 0, "grid dots are painted out");
});

test("figures in one row are told apart and a figure with no strokes is skipped", () => {
  const { pixels } = note();
  const left = { bbox: box(25, 35, 90, 170), caption: "", captionBox: null };
  const right = { bbox: box(140, 45, 70, 30), caption: "", captionBox: null };
  const empty = { bbox: box(240, 150, 40, 40), caption: "", captionBox: null };
  const cuts = cutNoteFigures(pixels, [{ type: "figures", figures: [left, right, empty], side: "", sideBox: null }]);
  assert.ok(cuts.has(left) && cuts.has(right));
  assert.equal(cuts.has(empty), false);
  assert.ok(cuts.get(right).width < 40, "the label A is a figure of its own here");
});

test("the original comparison-table screenshot yields two clean graphs without its connected grid", async () => {
  const source = PNG.sync.read(await readFile(new URL("./fixtures/note-comparison-table.png", import.meta.url)));
  const pixels = { width: source.width, height: source.height, data: new Uint8ClampedArray(source.data) };
  const at = (x, y, w, h) => box(x, y, w, h, source.width, source.height);
  const left = { bbox: at(395, 355, 145, 145), caption: "", captionBox: null };
  const right = { bbox: at(780, 355, 145, 145), caption: "", captionBox: null };
  const cell = (bbox, figures = []) => ({ bbox, figures, text: "", colSpan: 1, rowSpan: 1 });
  const cuts = cutNoteFigures(pixels, [{ type: "table", bbox: at(23, 15, 1022, 726), rows: [
    [cell(at(24, 16, 1019, 309))],
    [cell(at(24, 325, 250, 201)), cell(at(274, 325, 385, 201), [left]), cell(at(659, 325, 384, 201), [right])],
    [cell(at(24, 526, 1019, 213))],
  ] }]);
  assert.equal(cuts.size, 2);
  for (const figure of [left, right]) {
    const cut = cuts.get(figure);
    assert.ok(cut.width > 115 && cut.width < 175, `graph width ${cut.width} excludes table grid`);
    assert.ok(cut.height > 115 && cut.height < 175, `graph height ${cut.height} excludes table grid`);
    assert.equal(cut.data[3], 0, "background is transparent");
  }
});
