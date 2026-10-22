import { ImportedXmlComponent, TextRun, type ParagraphChild } from 'docx';
import { splitMathText } from './answer-studio-math-text';
import { needsWordMathEquation } from './math-notation.mjs';
import { isStudioDisplayMathLine, studioWordDisplayXml, studioWordEquationXml, STUDIO_WORD_STYLE } from './studio-math-layout';
import { repairMathSource, scanMathSource } from './math-source.mjs';
import { xmlSafeText } from './xml-text';
import { plainMathPieces } from './math-text';
import { readMathGroup } from './math-grid';
const BODY_SIZE=STUDIO_WORD_STYLE.size;
const BODY_FONT=STUDIO_WORD_STYLE.font;
type RunStyle={bold?:boolean;color?:string;italicMath?:boolean;underline?:boolean;displayMath?:boolean;mathAlignment?:'left'|'center'|'right';size?:number};
class NativeMathXml extends ImportedXmlComponent {
  static fromMathXml(xml:string):ParagraphChild {
    // Import the actual OMML element, never the nameless XML container.
    const parsed=ImportedXmlComponent.fromXmlString(xml) as NativeMathXml;
    const element=parsed.root[0];
    if(!(element instanceof ImportedXmlComponent))throw new Error('原生公式 XML 根节点无效');
    return element as unknown as ParagraphChild;
  }
}
function textRuns(text:string,style:RunStyle={}) {
  return xmlSafeText(text).split(/([A-Za-z]+)/g).filter(Boolean).map(piece=>new TextRun({text:piece,size:style.size??BODY_SIZE,bold:style.bold,color:style.color,
    underline:style.underline?{}:undefined,italics:style.italicMath!==false&&(/^[A-Z]{1,4}$/.test(piece)||/^[a-z]$/.test(piece)),font:BODY_FONT}));
}
export function richText(text:string,style:RunStyle={},onMathError?:(error:unknown)=>void):ParagraphChild[] {
  text=repairMathSource(text);
  const marked=text.match(/<u>([\s\S]*?)<\/u>/i);
  if(marked&&(text.slice(0,marked.index).match(/(?<!\\)\$/g)?.length||0)%2===0)return [...richText(text.slice(0,marked.index),style,onMathError),...richText(marked[1],{...style,underline:true,displayMath:false},onMathError),...richText(text.slice(marked.index!+marked[0].length),style,onMathError)];
  const delimiterIssues=scanMathSource(text).issues;
  if(delimiterIssues.length) {
    const error=new Error('公式分隔符不完整，请核对原文');
    if(!onMathError)throw error;
    onMathError(error);
  }
  const display=style.displayMath??(!style.underline&&isStudioDisplayMathLine(text));
  if(display&&!delimiterIssues.length) {
    try { return [NativeMathXml.fromMathXml(studioWordDisplayXml(text,style))]; }
    catch { /* Fall through: isolate any unsupported expression below. */ }
  }
  return splitMathText(text).flatMap(segment=>{
    if(segment.kind!=='math'||!needsWordMathEquation(segment.value,segment.explicit))return textRuns(segment.value,style);
    try{
      const source=segment.value.trim(),command=source.match(/^\\underline\s*(?=\{)/)?.[0],group=command?readMathGroup(source,command.length):null;
      const marked=group?.end===source.length?group:null,underline=style.underline||!!marked;
      let math=marked?marked.body:segment.value,left='',right='';
      if(marked){
        left=math.match(/^(?:(?:\\qquad|\\quad)(?![A-Za-z])|\s)+/)?.[0]||'';math=math.slice(left.length);
        right=math.match(/(?:(?:\\qquad|\\quad)(?![A-Za-z])|\s)+$/)?.[0]||'';math=math.slice(0,math.length-right.length);
      }
      const edges=[left,right].map(pad=>pad.replace(/\\qquad/g,'\u3000\u3000').replace(/\\quad/g,'\u3000').replace(/[ \t\r\n]/g,''));
      const pieces=plainMathPieces(math)||plainMathPieces(math.replace(/∵/g,'\\because ').replace(/∴/g,'\\therefore ').replace(/\*/g,'\\text{*}'));
      const runs=pieces?pieces.map(piece=>new TextRun({text:piece.text.replace(/＋/g,'+'),font:BODY_FONT,size:piece.script?STUDIO_WORD_STYLE.scriptSize:style.size??BODY_SIZE,color:style.color,bold:style.bold,italics:style.italicMath!==false&&piece.italic===true,superScript:piece.script==='super',subScript:piece.script==='sub',underline:underline||piece.underline?{}:undefined})):math.trim()?[NativeMathXml.fromMathXml(studioWordEquationXml(math,style.displayMath!==false&&segment.display===true,{...style,underline}))]:[];
      return [...(edges[0]?textRuns(edges[0],{...style,underline:true}):[]),...runs,...(edges[1]?textRuns(edges[1],{...style,underline:true}):[])];
    }
    catch(error){
      if(!onMathError)throw error;
      onMathError(error);
      // Isolate a failure to this equation, not all the other equations or
      // prose in its paragraph. Keep the unrecognized source for correction.
      return textRuns(`〔公式待核对：${segment.value}〕`,style);
    }
  });
}
