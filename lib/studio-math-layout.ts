import { standaloneRuledArrayLine } from './math-grid';
import { WORD_MATH_STYLE } from './math-capabilities.mjs';
import { splitMathText } from './math-text';
import { mathOmml } from './math-omml';
import { repairMathSource, scanMathSource, splitMathParagraphs } from './math-source.mjs';

// One transcription framework, measured from the four retained source papers.
// Recognition and output mode select content, never a different font or page geometry.
export const STUDIO_WORD_STYLE = Object.freeze({
  font:{ascii:'Times New Roman',hAnsi:'Times New Roman',eastAsia:'新宋体',cs:'Times New Roman',hint:'eastAsia'} as const,
  size:21,scriptSize:24,fractionSize:28,line:360,
  page:{width:11906,height:16838,margin:{top:1418,right:1134,bottom:1418,left:1134}},
});
export const STUDIO_MATH_SIZE = STUDIO_WORD_STYLE.size;
export type StudioMathStyle = { color?:string; bold?:boolean; underline?:boolean;mathAlignment?:'left'|'center'|'right';size?:number };
const escapeXml = (s:string) => s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));

/** A calculation line, optionally introduced by a short Chinese proof cue.
 * Ordinary prose containing a formula stays inline. Fraction depth is not a
 * font-size input; simple and complex calculation lines share one base size.
 */
export function isStudioDisplayMathLine(text:string) {
  const content=text.replace(/^\s*[\uff08(](?:\d+|[ivx]+)[)\uff09]\s*/i,'');
  const segments=splitMathText(content).filter(s=>s.value.trim());
  return segments.some(s=>s.kind==='math') && segments.every(s=>s.kind==='math'
    || /^(?:[\s,\uff0c.\u3002;\uff1b:\uff1a\u2460-\u2473\u21d2\u2192\u2234\u2235]|\u7531|\u53ef|\u5f97|\u6545|\u89e3|\u6240\u4ee5|\u56e0\u6b64|\u8054\u7acb)*$/.test(s.value));
}
function styledMathXml(xml:string,display:boolean,style:StudioMathStyle) {
  if(style.color&&!/^[\da-f]{6}$/i.test(style.color))throw new Error('Invalid equation color');
  const size=style.size??STUDIO_MATH_SIZE;
  const properties=`<w:rPr><w:rFonts w:ascii="${WORD_MATH_STYLE.font}" w:hAnsi="${WORD_MATH_STYLE.font}" w:eastAsia="${STUDIO_WORD_STYLE.font.eastAsia}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/>${style.bold?'<w:b/>':''}${style.color?`<w:color w:val="${style.color}"/>`:''}</w:rPr>`;
  // Identical base size for every run. Word retains its own script scaling.
  const body=xml.replace(/<m:r>(<m:rPr>[\s\S]*?<\/m:rPr>)?/g,`<m:r>$1${properties}`);
  const equation=`<m:oMath>${body}</m:oMath>`;
  return display?`<m:oMathPara><m:oMathParaPr><m:jc m:val="${style.mathAlignment??'left'}"/></m:oMathParaPr>${equation}</m:oMathPara>`:equation;
}
export function studioWordEquationXml(source:string,display=false,style:StudioMathStyle={}) {
  return styledMathXml(mathOmml(style.underline?`\\underline{${source}}`:source),display,style);
}
export function studioWordDisplayXml(text:string,style:StudioMathStyle={}) {
  const body=splitMathText(text).map(s=>s.kind==='math'
    ? mathOmml(style.underline?`\\underline{${s.value}}`:s.value)
    : `<m:r><m:rPr><m:nor/></m:rPr><m:t xml:space="preserve">${escapeXml(s.value)}</m:t></m:r>`).join('');
  return styledMathXml(body,true,style);
}

/** Validates delimiters as well as expressions, including resumed old drafts. */
export function studioMathIssues(text:string):string[] {
  const source=repairMathSource(text);
  const issues=scanMathSource(source).issues.map(issue=>`\u516c\u5f0f\u5206\u9694\u7b26\u4e0d\u5b8c\u6574\uff08\u4f4d\u7f6e ${issue.offset+1}\uff09`);
  for(const [lineIndex,line] of splitMathParagraphs(source).entries()) {
    try {
      const ruled=standaloneRuledArrayLine(line);
      const expressions=ruled?ruled.rows.flat():splitMathText(line).filter(s=>s.kind==='math').map(s=>s.value);
      for(const value of expressions)mathOmml(value);
    } catch(error){issues.push(`line ${lineIndex+1}: ${error instanceof Error?error.message:'Invalid math'}`);}
  }

  return [...new Set(issues)];
}
