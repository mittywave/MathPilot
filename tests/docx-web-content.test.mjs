import { loadSource } from './load-source.mjs';
import assert from "node:assert/strict";
import test from "node:test";
const { docxFigureLine, docxMathLatex, docxWebContentText, docxWebInlineText, parseDocxWebContent, parseDocxWebOptions } = await loadSource("lib/docx-web-content.ts");
const { plainTextWebLines, toLatexMath } = await loadSource("lib/math-text.ts");

const paragraph = (body) => `<w:p xmlns:w="word" xmlns:m="math"><w:pPr><w:jc w:val="left"/></w:pPr>${body}</w:p>`;
const textRun = (value, properties = "") => `<w:r><w:rPr>${properties}</w:rPr><w:t xml:space="preserve">${value}</w:t></w:r>`;
const mathRun = (body) => `<w:r><m:oMath>${body}</m:oMath></w:r>`;

test("keeps an explicitly hidden Word equation delimiter hidden while preserving defaults", () => {
  const expression = '<m:e><m:r><m:t>x=1</m:t></m:r></m:e>';
  for (const [properties, expected] of [
    ['<m:begChr m:val="{"/><m:endChr m:val=""/>', '\\left\\{x=1\\right.'],
    ['<m:begChr m:val=""/><m:endChr m:val="|"/>', '\\left.x=1\\right|'],
    ['', '\\left(x=1\\right)'],
  ]) assert.deepEqual(docxMathLatex(mathRun(`<m:d><m:dPr>${properties}</m:dPr>${expression}</m:d>`)), [expected]);
});

test("turns Word fractions, ordered scripts and percentages into semantic web math", () => {
  const xml = paragraph(`${textRun("7．由题可列方程为")}${mathRun([
    "<m:f><m:num><m:r><m:t>3000</m:t></m:r></m:num><m:den><m:r><m:t>x</m:t></m:r></m:den></m:f>",
    "<m:r><m:t>-2=</m:t></m:r>",
    "<m:f><m:num><m:r><m:t>3000</m:t></m:r></m:num><m:den><m:sSubSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sub><m:r><m:t>1</m:t></m:r></m:sub><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSubSup><m:r><m:t>(1+20%)</m:t></m:r></m:den></m:f>",
  ].join(""))}`);
  const content = parseDocxWebContent([xml], { stripLeadingQuestionNumber: true });
  assert.equal(docxWebContentText(content), "由题可列方程为$\\frac{3000}{x}-2=\\frac{3000}{{x}_{1}^{2}(1+20\\%)}$");
  assert.equal(toLatexMath("20%"), "20\\%");
  assert.equal(toLatexMath("20\\%"), "20\\%");
});

test("keeps Word run styles and normalizes an entire formula option consistently", () => {
  const xml = paragraph([
    textRun("A．"),
    textRun("a", "<w:i/>"),
    textRun("2", "<w:vertAlign w:val=\"superscript\"/>"),
    textRun("•"),
    textRun("a", "<w:i/>"),
    textRun("4", "<w:vertAlign w:val=\"superscript\"/>"),
    textRun("＝"),
    textRun("a", "<w:i/>"),
    textRun("6", "<w:vertAlign w:val=\"superscript\"/>"),
    "<w:r><w:tab/></w:r>",
    textRun("B．普通文字"),
  ].join(""));
  const options = parseDocxWebOptions([xml]);
  assert.equal(options.length, 2);
  assert.equal(docxWebInlineText(options[0].inlines), "$a^{2}\\cdot a^{4}=a^{6}$");
  assert.equal(docxWebInlineText(options[1].inlines), "普通文字");
});

test("preserves table rows, nested tables, column spans and vertical merges", () => {
  const nested = `<w:tbl><w:tr><w:tc>${paragraph(textRun("0"))}<w:tcPr/></w:tc><w:tc>${paragraph(textRun("3"))}<w:tcPr/></w:tc></w:tr></w:tbl>`;
  const xml = `<w:tbl xmlns:w="word">
    <w:tr>
      <w:tc>${paragraph(textRun("素材1"))}<w:tcPr><w:vMerge w:val="restart"/></w:tcPr></w:tc>
      <w:tc>${paragraph(textRun("说明"))}<w:tcPr><w:gridSpan w:val="2"/></w:tcPr></w:tc>
    </w:tr>
    <w:tr>
      <w:tc>${paragraph("")}<w:tcPr><w:vMerge/></w:tcPr></w:tc>
      <w:tc>${paragraph(textRun("数据"))}${nested}<w:tcPr><w:gridSpan w:val="2"/></w:tcPr></w:tc>
    </w:tr>
  </w:tbl>`;
  const content = parseDocxWebContent([xml]);
  assert.equal(content.blocks.length, 1);
  const table = content.blocks[0];
  assert.equal(table.type, "table");
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[0][0].rowSpan, 2);
  assert.equal(table.rows[0][1].colSpan, 2);
  assert.equal(table.rows[1].length, 1);
  assert.equal(table.rows[1][0].blocks[1].type, "table");
  assert.match(docxWebContentText(content), /素材1\t说明/);
  assert.match(docxWebContentText(content), /数据\n0\t3/);
});

test("reads in-line pictures with the size and alignment the document printed them at", () => {
  const picture = (id, cx, cy, kind = "inline") => `<w:r><w:drawing><wp:${kind}><wp:extent cx="${cx}" cy="${cy}"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="${id}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:${kind}></w:drawing></w:r>`;
  const line = docxFigureLine(paragraph(picture("rId24", 4617730, 1962916)));
  assert.equal(line.align, "left");
  assert.deepEqual(line.figures.map((figure) => [figure.id, figure.width.toFixed(1), figure.height.toFixed(1)]), [["rId24", "128.3", "54.5"]]);
  const row = docxFigureLine(`<w:p><w:pPr><w:jc w:val="center"/></w:pPr>${picture("rId1", 720000, 360000)}${textRun("　")}${picture("rId2", 1080000, 360000)}</w:p>`);
  assert.equal(row.align, "center");
  assert.deepEqual(row.figures.map((figure) => [figure.id, figure.width]), [["rId1", 20], ["rId2", 30]]);
  assert.equal(docxFigureLine(paragraph(textRun("如图，求 x．"))), null, "text-only paragraphs have no figure line");
  assert.equal(docxFigureLine(paragraph(picture("rId3", 720000, 360000, "anchor"))), null, "floating pictures keep their own layout");
  assert.equal(docxFigureLine(`<w:tbl><w:tr><w:tc>${paragraph(picture("rId4", 720000, 360000))}</w:tc></w:tr></w:tbl>`), null, "pictures inside tables stay with the table");
});

test("keeps analysis paragraphs separate and leaves plain text questions on their fallback path", () => {
  const analysis = parseDocxWebContent([
    paragraph(textRun("【分析】先读题．")),
    paragraph(`${textRun("【解答】")}${mathRun("<m:f><m:num><m:r><m:t>1</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f>")}`),
  ]);
  assert.equal(analysis.blocks.length, 2);
  assert.equal(docxWebContentText(analysis), "【分析】先读题．\n【解答】$\\frac{1}{2}$");
  assert.deepEqual(parseDocxWebContent([]), { blocks: [] });
  assert.deepEqual(parseDocxWebOptions([]), []);
});

test("keeps English prose and standalone formulas on separate web lines", () => {
  const stem = "The equation\nx²＋kx＋3＝0\nhas no real roots.\nShow that\nk²＜12";
  const lines = plainTextWebLines(stem);
  assert.deepEqual(lines, [
    { value: "The equation", align: "left" },
    { value: "x²＋kx＋3＝0", align: "center" },
    { value: "has no real roots.", align: "left" },
    { value: "Show that", align: "left" },
    { value: "k²＜12", align: "center" },
  ]);
  assert.equal(lines.map((line) => line.value).join("\n"), stem);
});

test("centers only formula-only fallback lines and keeps prose controls left aligned", () => {
  assert.deepEqual(plainTextWebLines("12. Let x＝1.\ny＝2", { stripLeadingQuestionNumber: true }), [
    { value: "Let x＝1.", align: "left" },
    { value: "y＝2", align: "center" },
  ]);
  assert.deepEqual(plainTextWebLines("普通文字\n\n继续说明"), [
    { value: "普通文字", align: "left" },
    { value: "", align: "left" },
    { value: "继续说明", align: "left" },
  ]);
});

test("a line of inline formulas stays in the running text; a fraction in it is printed full size", async () => {
  const stem = "把下列各数填入相应的集合中：\n$+6$, $0.75$, $-3$, $\\frac{24}{5}$, $-\\frac{1}{3}$, $9\\%$.\n$$x^{2}=4$$";
  assert.deepEqual(plainTextWebLines(stem).map((line) => line.align), ["left", "left", "center"]);
  const { renderKatex } = await loadSource("lib/math-render.ts");
  assert.match(renderKatex("-\\frac{1}{3}").html, /\\displaystyle -\\frac\{1\}\{3\}/);
  assert.doesNotMatch(renderKatex("x^{2}").html, /\\displaystyle/);
});

test("lists every Word equation of a document part in order, inside paragraphs, display blocks and tables", () => {
  const fraction = "<m:f><m:num><m:r><m:t>1</m:t></m:r></m:num><m:den><m:r><m:t>2</m:t></m:r></m:den></m:f>";
  const body = `<w:body xmlns:w="word" xmlns:m="math">${paragraph(`${textRun("已知")}${mathRun("<m:r><m:t>x</m:t></m:r>")}${textRun("，")}${mathRun(fraction)}`)}`
    + `<w:p><m:oMathPara><m:oMath><m:r><m:t>a</m:t></m:r></m:oMath><m:oMath><m:rad><m:deg/><m:e><m:r><m:t>3</m:t></m:r></m:e></m:rad></m:oMath></m:oMathPara></w:p>`
    + `<w:tbl><w:tr><w:tc>${paragraph(mathRun("<m:r><m:t>y</m:t></m:r>"))}</w:tc></w:tr></w:tbl></w:body>`;
  assert.deepEqual(docxMathLatex(body), ["x", "\\frac{1}{2}", "a", "\\sqrt{3}", "y"]);
  assert.deepEqual(docxMathLatex("<w:body><w:p>"), []);
});

test("picture-only and mixed Word choices retain labels, order and printed dimensions", () => {
  const picture = (id, width = 12, height = 10) => `<w:r><w:drawing><wp:inline><wp:extent cx="${width * 36000}" cy="${height * 36000}"/><a:graphic><a:blip r:embed="${id}"/></a:graphic></wp:inline></w:drawing></w:r>`;
  const xml = [paragraph(textRun("A．") + picture("a") + '<w:r><w:tab/></w:r>' + textRun("B．说明") + picture("b", 18, 14)), paragraph(textRun("C．")), paragraph(picture("c")), paragraph(textRun("D．") + mathRun('<m:r><m:t>x</m:t></m:r>') + picture("d"))];
  const options = parseDocxWebOptions(xml);
  assert.deepEqual(options.map(o => o.label), ["A", "B", "C", "D"]);
  assert.deepEqual(options.map(o => o.inlines.filter(i => i.type === 'image')), [
    [{type:'image',id:'a',width:12,height:10}], [{type:'image',id:'b',width:18,height:14}],
    [{type:'image',id:'c',width:12,height:10}], [{type:'image',id:'d',width:12,height:10}],
  ]);
  assert.equal(docxWebInlineText(options[1].inlines), '说明');
  assert.equal(docxWebInlineText(options[3].inlines), '$x$');
  assert.deepEqual(parseDocxWebContent([paragraph(picture('stem'))]).blocks, [], 'stem pictures keep their separate placement path');
});

test("the real question body renders Word option pictures once at source size even with no text fallback", async () => {
  const {createElement} = await import('react');
  const {renderToStaticMarkup} = await import('react-dom/server');
  const {QuestionBody} = await loadSource('app/components/QuestionBody.tsx');
  const {questionImages} = await loadSource('lib/question-layout.ts');
  const xml = paragraph(textRun('A．') + '<w:r><w:drawing><wp:inline><wp:extent cx="432000" cy="360000"/><a:blip r:embed="choice"/></wp:inline></w:drawing></w:r>' + textRun('B．普通选项'));
  const q = {id:'test', type:'单选题', stem:'选择正确图形',options:[],optionsDocxXml:[xml],optionsDocxAssets:{choice:'/choice.png'},contentImages:['/stem.png','/choice.png','/choice.png'],source:''};
  const html = renderToStaticMarkup(createElement(QuestionBody,{question:q,number:1}));
  assert.equal((html.match(/<img /g)||[]).length,2);
  assert.match(html,/width:12mm;max-width:100%;height:auto/);
  assert.match(html,/docx-web-option-label">A\./);
  assert.match(html,/docx-web-option-label">B\./);
  assert.deepEqual(questionImages(q),['/stem.png']);
  assert.deepEqual(questionImages({...q,stemDocxAssets:{same:'/choice.png'}}),['/stem.png','/choice.png'],'an image also used by the stem is not lost');
  assert.deepEqual(questionImages({...q,optionsDocxXml:undefined}),['/stem.png','/choice.png'],'without raw options, supplementary images stay visible');
});

test("Word stem pictures stay between paragraphs and inside merged or nested table cells without gallery duplicates", async () => {
  const {createElement} = await import('react');
  const {renderToStaticMarkup} = await import('react-dom/server');
  const {QuestionBody} = await loadSource('app/components/QuestionBody.tsx');
  const picture = (id, mode = 'inline') => `<w:r><w:drawing><wp:${mode}><wp:extent cx="1800000" cy="1260000"/><a:blip r:embed="${id}"/></wp:${mode}></w:drawing></w:r>`;
  const cell = (body, merge = '') => `<w:tc><w:tcPr>${merge}</w:tcPr>${body}</w:tc>`;
  const nested = `<w:tbl><w:tr>${cell(paragraph(picture('nested')))}</w:tr></w:tbl>`;
  const table = `<w:tbl><w:tr>${cell(paragraph(textRun('步骤一')))}${cell(paragraph(picture('diagram')), '<w:vMerge w:val="restart"/>')}</w:tr><w:tr>${cell(nested)}${cell(paragraph(''), '<w:vMerge/>')}</w:tr></w:tbl>`;
  const xml = [paragraph(textRun('1．题干之前')), paragraph(picture('overview')), paragraph(textRun('开始作图')), table, paragraph(textRun('作图之后') + picture('floating', 'anchor'))];
  const assets = {overview:'/overview.png',diagram:'/diagram.png',nested:'/nested.png',floating:'/floating.png',unused:'/unreferenced.png'};
  const question = {id:'table-test',type:'解答题',stem:'题干',options:[],source:'',stemDocxXml:xml,stemDocxAssets:assets,contentImages:[...Object.values(assets),'/extra.png']};
  const html = renderToStaticMarkup(createElement(QuestionBody,{question,number:1}));
  assert.match(html, /rowSpan="2"[^>]*><p[^>]*><img[^>]*src="\/diagram.png"/i);
  assert.match(html, /depth-1[\s\S]*?<td[^>]*><p[^>]*><img[^>]*src="\/nested.png"/);
  assert.ok(html.indexOf('/overview.png') < html.indexOf('开始作图'));
  assert.ok(html.indexOf('/diagram.png') < html.indexOf('作图之后'));
  const gallery = html.slice(html.indexOf('class="question-images'));
  for (const source of ['/overview.png','/diagram.png','/nested.png']) {
    assert.equal(html.split(`src="${source}"`).length-1, 1);
    assert.ok(!gallery.includes(source));
  }
  for (const source of ['/floating.png','/unreferenced.png','/extra.png']) assert.ok(gallery.includes(source), `${source} still needs the supplementary gallery`);
  const fallback = renderToStaticMarkup(createElement(QuestionBody,{question:{...question,stemDocxXml:undefined},number:1}));
  assert.equal((fallback.match(/<img /g)||[]).length,6,'editing away the source XML must not lose the pictures');
  assert.equal((html.match(/<img /g)||[]).length,6);
  const pictureFirst = renderToStaticMarkup(createElement(QuestionBody,{question:{...question,stemDocxXml:[paragraph(picture('overview')),paragraph(textRun('7．图片之后的题干'))]},number:1}));
  assert.ok(!pictureFirst.includes('7．'),'a leading picture-only paragraph must not prevent question renumbering');
});

test("Word analysis renders picture-only paragraphs and picture-only tables at their source positions", async () => {
  const {createElement} = await import('react');
  const {renderToStaticMarkup} = await import('react-dom/server');
  const {DocxContent} = await loadSource('app/components/DocxContent.tsx');
  const picture = '<w:r><w:drawing><wp:inline><wp:extent cx="720000" cy="360000"/><a:blip r:embed="analysis"/></wp:inline></w:drawing></w:r>';
  const xml = [paragraph(textRun('辅助线之前')),paragraph(picture),`<w:tbl><w:tr><w:tc>${paragraph(picture)}</w:tc></w:tr></w:tbl>`,paragraph(textRun('辅助线之后'))];
  const html = renderToStaticMarkup(createElement(DocxContent,{xml,fallback:'解析',assets:{analysis:'/analysis.png'}}));
  assert.equal((html.match(/<img /g)||[]).length,2,'repeated source placements in the document must both survive');
  assert.match(html, /<td[^>]*><p[^>]*><img[^>]*src="\/analysis.png"/);
  assert.ok(html.indexOf('/analysis.png') < html.indexOf('辅助线之后'));
  assert.match(html,/width:20mm;max-width:100%;height:auto/);
});
