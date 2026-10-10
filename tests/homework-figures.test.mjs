import test from "node:test";
import assert from "node:assert/strict";
import { loadSource } from "./load-source.mjs";

const { cutHomeworkFigure, normalizeHomeworkFigures, mergeHomeworkFigures, bareOptionLabels, normalizeFigureLocator, removeAddedTexts, figureLocatorPrompt } = await loadSource("lib/homework-figures.ts");
const { assignmentQuestionToQuestion } = await loadSource("lib/question-content.ts");

// A scanned homework page: a printed coordinate figure on the right of a line of stem text, and the next line of
// writing running underneath it. The model's box stops short of the y-axis and the graph line.
function page() {
  const width = 400; const height = 300; const data = new Uint8ClampedArray(width * height * 4).fill(250);
  const paint = (x0, y0, x1, y1, value = 30) => {
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) { const o = (y * width + x) * 4; data[o] = data[o + 1] = data[o + 2] = value; data[o + 3] = 255; }
  };
  for (let x = 20; x < 200; x += 12) paint(x, 150, x + 8, 160); // stem text left of the figure
  paint(220, 200, 380, 202);        // x-axis
  paint(290, 90, 292, 280);         // y-axis, running below the model's box
  for (let t = 0; t <= 120; t += 1) paint(240 + t, 120 + Math.round(t * 140 / 120), 242 + t, 122 + Math.round(t * 140 / 120)); // the graph line
  paint(370, 205, 376, 212); paint(296, 92, 302, 99); paint(280, 205, 286, 212); // x, y, O
  paint(330, 262, 338, 272);        // writing below the figure, inside the axis' reach
  return { data, width, height };
}
const box = (x, y, w, h) => ({ x: x / 400 * 1000, y: y / 300 * 1000, width: w / 400 * 1000, height: h / 300 * 1000 });

test("a figure is cut from its own strokes: clipped axes come back whole and neighbouring ink is painted out", () => {
  const cut = cutHomeworkFigure(page(), box(218, 85, 167, 165));
  assert.ok(cut, "the figure is cut");
  assert.ok(cut.width >= 168 && cut.width <= 178, `width ${cut.width}`);
  assert.ok(cut.height >= 195 && cut.height <= 206, `height ${cut.height}`);
  const left = 220 - 6; const top = 90 - 6;
  const pixel = (x, y) => [...cut.data.slice(((y - top) * cut.width + x - left) * 4, ((y - top) * cut.width + x - left) * 4 + 3)];
  const dark = (x, y) => pixel(x, y).every((value) => value < 60);
  assert.ok(dark(291, 270), "the y-axis below the model's box is kept");
  assert.ok(dark(355, 255), "the end of the graph line is kept");
  assert.deepEqual(pixel(334, 267), [255, 255, 255], "writing under the figure is removed");
  assert.deepEqual(pixel(250, 110), [255, 255, 255], "paper is lifted to white");
  assert.equal(cutHomeworkFigure(page(), box(20, 10, 100, 40)), null, "a box with no ink gives no figure");
});

test("a phone photo's shadow is flattened, so the figure sits on white paper without patches", () => {
  const shaded = page();
  // The right side of the photo falls into shadow: paper and ink darken together.
  for (let y = 0; y < shaded.height; y += 1) for (let x = 0; x < shaded.width; x += 1) {
    const o = (y * shaded.width + x) * 4; const shade = 1 - .32 * x / shaded.width;
    for (let channel = 0; channel < 3; channel += 1) shaded.data[o + channel] = Math.round(shaded.data[o + channel] * shade);
  }
  const cut = cutHomeworkFigure(shaded, box(218, 85, 167, 165));
  assert.ok(cut, "the figure is cut");
  const left = 220 - 6; const top = 90 - 6;
  const luminance = (x, y) => { const o = ((y - top) * cut.width + x - left) * 4; return cut.data[o] * .299 + cut.data[o + 1] * .587 + cut.data[o + 2] * .114; };
  for (const [x, y] of [[250, 110], [375, 150], [375, 270], [334, 267]]) assert.ok(luminance(x, y) >= 250, `paper at ${x},${y} is ${luminance(x, y)}`);
  assert.ok(luminance(291, 270) < 80 && luminance(370, 201) < 80, "ink in the shadow stays dark");
});

test("figure lists are validated per page, duplicates collapse and an omitted list stays unlocated", () => {
  assert.equal(normalizeHomeworkFigures(undefined, 3), undefined);
  const figures = normalizeHomeworkFigures([
    { kind: "stem", bbox: { x: 700, y: 400, width: 200, height: 150 } },
    { kind: "stem", bbox: { x: 705, y: 405, width: 195, height: 150 } },
    { kind: "options", bbox: { x: 100, y: 280, width: 760, height: 70 } },
    { kind: "stem", bbox: { x: 990, y: 10, width: 300, height: 5 } },
    { kind: "stem", bbox: { x: "a", y: 0, width: 10, height: 10 } },
  ], 3);
  assert.deepEqual(figures.map((figure) => [figure.page, figure.kind]), [[3, "stem"], [3, "options"]]);
  const stored = normalizeHomeworkFigures([{ kind: "stem", bbox: { x: 700, y: 400, width: 200, height: 150 }, assetId: "6f1d3c1a-7b5e-4a49-9b5c-1d2e3f4a5b6c" }], 3);
  assert.equal(stored[0].assetId, "6f1d3c1a-7b5e-4a49-9b5c-1d2e3f4a5b6c");
  assert.equal(mergeHomeworkFigures(figures, undefined), undefined, "a page never searched leaves the question unlocated");
  assert.equal(mergeHomeworkFigures(figures, [{ page: 4, kind: "stem", bbox: { x: 100, y: 100, width: 100, height: 100 } }]).length, 3);
  assert.equal(bareOptionLabels(["A", "B.", "C、", "D"]), true);
  assert.equal(bareOptionLabels(["A. $k>0$", "B"]), false);
  assert.equal(bareOptionLabels([]), false);
});

test("old stems lose only the figure description quoted verbatim", () => {
  assert.equal(removeAddedTexts("5. 正比例函数 $y=kx$ 的图象如图所示，则 $k$ 的取值范围是（　　）\n（注：图象为经过原点且穿过第二、四象限的直线）", ["（注：图象为经过原点且穿过第二、四象限的直线）"]).stem,
    "5. 正比例函数 $y=kx$ 的图象如图所示，则 $k$ 的取值范围是（　　）");
  assert.equal(removeAddedTexts("实数$a$在数轴上的位置如图所示（数轴上$-1<a<0$）, 化简:\n(1) 求值", ["（数轴上$-1<a<0$）"]).stem, "实数$a$在数轴上的位置如图所示, 化简:\n(1) 求值");
  assert.equal(removeAddedTexts("第一行\n（图为方格）\n第二行", ["（图为方格）"]).stem, "第一行\n第二行");
  const untouched = removeAddedTexts("如图，求 $x$", ["（图为一个三角形）"]);
  assert.deepEqual(untouched, { stem: "如图，求 $x$", removed: [] });
  // A long quote that came back with one formula garbled still finds its own text, and records the stem's version.
  const note = "（图为以点$O$为中心的方位图：$OA$方向为南偏东$30^\\circ$，距离为$30\\text{km}$；$OB$方向与正北方向夹角为$45^\\circ$，距离为$40\\text{km}$）";
  const garbled = removeAddedTexts(`(3) $A$, $D$两点间的距离为________km.\n${note}`, [note.replace("30^\\circ", "30^\rot")]);
  assert.deepEqual(garbled, { stem: "(3) $A$, $D$两点间的距离为________km.", removed: [note] });
  const different = "（图为以点$O$为中心的方位图：$OA$在正东方向，$OB$在正西方向，$OC$在正南方向，距离都为$40\\text{km}$）";
  assert.deepEqual(removeAddedTexts(`题干\n${note}`, [different]).removed, [], "same ends, different content stays");
});

test("the figure locator must answer for every transcribed question on the page", () => {
  const prompt = figureLocatorPrompt(27, [{ questionNumber: "27-5", stem: "如图", options: ["A. $k>0$"] }]);
  assert.match(prompt, /第 27 页[\s\S]*27-5：如图[\s\S]*选项：A\. \$k>0\$/);
  assert.throws(() => normalizeFigureLocator({ questions: [{ question_number: "27-5", figures: [], added_texts: [] }] }, 27, ["27-5", "27-6"]), /27-6/);
  const located = normalizeFigureLocator({ questions: [
    { question_number: "27-5", figures: [{ kind: "stem", bbox: { x: 788, y: 454, width: 141, height: 110 } }], added_texts: ["（注：图象为直线）", "注"] },
  ] }, 27, ["27-5"]);
  assert.deepEqual(located, [{ questionNumber: "27-5", figures: [{ page: 27, kind: "stem", bbox: { x: 788, y: 454, width: 141, height: 110 } }], addedTexts: ["（注：图象为直线）"] }]);
  assert.throws(()=>normalizeFigureLocator({questions:[{question_number:'99-1',figures:[],added_texts:[]}]},27,['27-5']),/非本页题号/);
  assert.throws(()=>normalizeFigureLocator({questions:[{question_number:'27-5',figures:[],added_texts:[]},{question_number:'27-5',figures:[],added_texts:[]}]},27,['27-5']),/重复/);
});

test('a crop of unrelated text is not accepted merely because it contains ink',()=>{
  const width=600,height=400,data=new Uint8ClampedArray(width*height*4).fill(255);
  for(let y=40;y<350;y+=35)for(let x=20;x<570;x+=20)for(let dy=0;dy<10;dy++)for(let dx=0;dx<9;dx++){
    const i=((y+dy)*width+x+dx)*4;data[i]=data[i+1]=data[i+2]=30;
  }
  assert.equal(cutHomeworkFigure({data,width,height},{x:0,y:0,width:1000,height:1000}),null);
});

test('figure provenance and handwriting survive normalization',()=>{
  const id='6f1d3c1a-7b5e-4a49-9b5c-1d2e3f4a5b6c';
  const [figure]=normalizeHomeworkFigures([{kind:'stem',bbox:{x:100,y:200,width:400,height:200},sourceAssetId:id,hasHandwriting:true}],12);
  assert.equal(figure.sourceAssetId,id);assert.equal(figure.hasHandwriting,true);assert.equal(figure.page,12);
});

test('dashed grids and wide rows of small option graphs are valid graphic crops',()=>{
  const width=1000,height=400,data=new Uint8ClampedArray(width*height*4).fill(255);
  const ink=(x,y,w,h)=>{for(let j=y;j<y+h;j++)for(let i=x;i<x+w;i++){const p=(j*width+i)*4;data[p]=data[p+1]=data[p+2]=25;}};
  for(let line=20;line<=140;line+=40)for(let p=20;p<140;p+=10){ink(p,line,4,1);ink(line,p,1,4);}
  assert.ok(cutHomeworkFigure({data,width,height},{x:10,y:25,width:145,height:350}),'dashed grid remains intact');
  data.fill(255);
  for(let x=40;x<950;x+=240){ink(x,260,100,2);ink(x+50,210,2,100);}
  assert.ok(cutHomeworkFigure({data,width,height},{x:20,y:500,width:960,height:300}),'four small option axes remain intact');
});

test("wrong-book snapshots carry the cut figures; option graphs replace bare option letters", () => {
  const template = { id: "q", type: "单选题", stem: "当 $k>0$ 时，图象大致是（　）", options: ["A", "B", "C", "D"], answer: "A", analysis: "", pageNumber: 27, knowledgeTags: [], taxonomyKeys: [], confidence: 1, warnings: [] };
  const plain = assignmentQuestionToQuestion(template, { title: "作业", createdAt: 1, updatedAt: 1 });
  assert.equal(plain.contentImages, undefined);
  assert.deepEqual(plain.options, ["A", "B", "C", "D"]);
  const graphed = assignmentQuestionToQuestion({ ...template, figures: [{ url: "/api/homework-assets/f", kind: "options" }] }, { title: "作业", createdAt: 1, updatedAt: 1 });
  assert.equal(graphed.optionsImage, "/api/homework-assets/f", "the option graphs are shown where the options go");
  assert.equal(graphed.contentImages, undefined);
  assert.deepEqual(graphed.options, []);
  const stem = assignmentQuestionToQuestion({ ...template, options: ["A. $k>0$", "B. $k<0$"], figures: [{ url: "/api/homework-assets/s", kind: "stem" }] }, { title: "作业", createdAt: 1, updatedAt: 1 });
  assert.deepEqual(stem.options, ["$k>0$", "$k<0$"]);
  assert.equal(stem.imageLayout, undefined);
  const numberLine = assignmentQuestionToQuestion({ ...template, type: "解答题", options: [], figures: [{ url: "/api/homework-assets/n", kind: "stem", width: 404, height: 74 }] }, { title: "作业", createdAt: 1, updatedAt: 1 });
  assert.equal(numberLine.imageLayout, "below", "a wide figure sits under the stem");
});
