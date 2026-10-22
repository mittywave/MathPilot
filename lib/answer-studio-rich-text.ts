import { ImportedXmlComponent, TextRun, type ParagraphChild } from 'docx';
import { splitMathText } from './answer-studio-math-text';
import { needsWordMathEquation } from './math-notation.mjs';
import { isStudioDisplayMathLine, studioWordDisplayXml, studioWordEquationXml } from './studio-math-layout';
import { repairMathSource, scanMathSource } from './math-source.mjs';
import { xmlSafeText } from './xml-text';
// Match the Normal and StudioAnswer paragraph styles (11 pt).
const BODY_SIZE=22;
const BODY_FONT={ascii:'Times New Roman',hAnsi:'Times New Roman',eastAsia:'Songti SC',cs:'Times New Roman',hint:'eastAsia'} as const;
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
    try{return [NativeMathXml.fromMathXml(studioWordEquationXml(segment.value.trim(),style.displayMath!==false&&segment.display===true,style))];}
    catch(error){
      if(!onMathError)throw error;
      onMathError(error);
      // Isolate a failure to this equation, not all the other equations or
      // prose in its paragraph. Keep the unrecognized source for correction.
      return textRuns(`〔公式待核对：${segment.value}〕`,style);
    }
  });
}
