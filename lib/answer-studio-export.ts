import { Document, Packer, Paragraph, TextRun, AlignmentType, Table, TableRow, TableCell, BorderStyle, WidthType, TableLayoutType, ImageRun, type IParagraphOptions, type ParagraphChild } from "docx";
import JSZip from "jszip";
import { richText } from "./answer-studio-rich-text";
import { assertStudioExportable, hasStudioControlCharacters, type StudioDraft, type StudioQuestion, type StudioSource, type StudioDocumentBlock } from "./answer-studio";
import {studioDocumentReady,studioDocumentParts,fillStudioDocumentTemplate,normalizeStudioDocumentTemplate,documentEvidence} from './answer-studio-contract';
import { diagramBounds, studioDiagramVml, xmlEscape } from "./answer-studio-diagram";
import { ensureWordMathSettings } from "./word-math-sizing.mjs";
import { splitMathText } from "./answer-studio-math-text";
import { standaloneRuledArray, standaloneRuledArrayLine as ruledArrayLine } from './math-grid';
import { mathOmml } from './math-omml';
import { isStudioDisplayMathLine, STUDIO_WORD_STYLE } from './studio-math-layout';
import { repairMathSource, scanMathSource, splitMathParagraphs } from './math-source.mjs';
import { normalizeStudioTextFields } from './answer-studio-normalize';
import { xmlSafeText } from './xml-text';
import { placeStudioAnswers, type StudioTextPart } from './answer-studio-layout';
import { studioFiguresReady, studioIncludesQuestionFigures, studioOutputBlocker, studioOutputs, type StudioOutputMode } from './answer-studio-output';

export function assertStudioMathSupported(text:string,allowBlockArrays=true) {
  text=repairMathSource(text);
  const issues=scanMathSource(text).issues;
  if(issues.length)throw new Error(`公式分隔符不完整（位置 ${issues[0].offset+1}）`);
  for(const [lineIndex,line] of splitMathParagraphs(text).entries()){
    const ruled=allowBlockArrays?ruledArrayLine(line):null;
    const expressions=ruled?ruled.rows.flat():splitMathText(line).filter(s=>s.kind==='math').map(s=>s.value);
    for(const [index,source] of expressions.entries())try{
      if(hasStudioControlCharacters(source))throw new Error('Math contains invalid control characters');
      mathOmml(source);
    }catch(error){throw new Error(`line ${lineIndex+1}, expression ${index+1}: ${error instanceof Error?error.message:String(error)}`,{cause:error});}
  }
}

/** Preserve wording while aligning numbered parts and keeping bare labels with their body. */
export function studioAnswerParagraphs(text: string) {
  const lines = splitMathParagraphs(repairMathSource(text)).map(line=>line.trim()).filter(Boolean)
    .flatMap(line=>splitMathParagraphs(line.replace(/^((?:证明|解|解答)\s*[：:])\s*(?=[（(]\d+[)）])/, '$1\n')));
  for(let i=0;i<lines.length-1;i++) {
    if(/^[（(]\d+[)）]$/.test(lines[i])&&!/^[（(]\d+[)）]/.test(lines[i+1]))lines.splice(i,2,`${lines[i]} ${lines[i+1]}`);
  }
  return lines.map((text, index)=>({text, keepNext:index<lines.length-1 && /^(?:(?:证明|解|解答)\s*[：:]|[（(]\d+[)）])$/.test(text)}));
}

const PAGE=STUDIO_WORD_STYLE.page;
const LINE_PT=(PAGE.width-PAGE.margin.left-PAGE.margin.right-312)/20;
const FIGURE_GAP_PT=STUDIO_WORD_STYLE.size;

// Role markers are removed when the reference paragraph properties are applied.
function standardParagraph(role:string,options:IParagraphOptions) {
  return new Paragraph({...options,style:`MP_TEMPLATE_${role}`});
}

/** A question's source pictures as the original page printed them: pictures on one row share a paragraph, side by
 * side, and each row keeps its side of the question — right, centre or left, by the space left on either side.
 * A row is as wide as its share of the original line, but at least 40% of a line, the library's rule for standalone
 * print figures, and no picture is taller than 240 pt. A picture without a recorded place on the page stays centred
 * at the compact drawing size. */
function studioFigureRows(q: StudioQuestion) {
  const rows: Array<{ indexes: number[]; source?: StudioSource }> = [];
  q.diagrams.forEach((d, index) => {
    if (!d.baseImage) return;
    const row = rows.at(-1), box = d.baseSource?.box, last = row?.source?.box;
    if (row && box && last && row.source!.pageId === d.baseSource!.pageId && box.y < last.y + last.height && last.y < box.y + box.height) {
      const x = Math.min(last.x, box.x), y = Math.min(last.y, box.y);
      row.indexes.push(index);
      row.source = { pageId: row.source!.pageId, box: { x, y, width: Math.max(last.x + last.width, box.x + box.width) - x, height: Math.max(last.y + last.height, box.y + box.height) - y } };
    } else rows.push({ indexes: [index], source: d.baseSource });
  });
  return rows.map(({ indexes, source }) => {
    const text = source && q.questionSources.find(s => s.pageId === source.pageId)?.box;
    if (!source || !text) return { indexes, alignment: AlignmentType.CENTER };
    const left = Math.min(text.x, source.box.x), right = Math.max(text.x + text.width, source.box.x + source.box.width);
    const leftGap = source.box.x - left, rightGap = right - source.box.x - source.box.width;
    const alignment = Math.abs(leftGap - rightGap) <= (right - left) * .1 ? AlignmentType.CENTER : leftGap > rightGap ? AlignmentType.RIGHT : AlignmentType.LEFT;
    const shares = indexes.map(i => q.diagrams[i].baseSource!.box.width / (right - left)), total = shares.reduce((sum, share) => sum + share, 0);
    let pt = Math.min(1, Math.max(.4, total)) * (LINE_PT - (indexes.length - 1) * FIGURE_GAP_PT) / total;
    const tallest = Math.max(...indexes.map((i, k) => { const b = diagramBounds({ ...q.diagrams[i], shapes: [] }); return shares[k] * pt * b.height / b.width; }));
    if (tallest > 240) pt *= 240 / tallest;
    return { indexes, alignment, widths: shares.map(share => share * pt) };
  });
}

export async function buildStudioWord(draft: StudioDraft, mode: StudioOutputMode | "answers", options:{reviewCopy?:boolean;transcription?:boolean;bestEffort?:boolean;includeTranscriptionWarnings?:boolean}={}) {
  if(studioDocumentReady(draft)&&['full','text'].includes(mode))return buildStudioDocumentWord(draft,mode==='full',options.includeTranscriptionWarnings!==false);
  // Direct exports and resumed legacy drafts share the same non-mutating
  // normalization as recognition. Never patch the downloaded DOCX afterward.
  draft={...draft,questions:draft.questions.map(normalizeStudioTextFields)};
  if(options.bestEffort&&!options.reviewCopy)throw new Error('Best-effort export is permitted only for an explicitly labelled review copy');
  const bestEffort=!!options.reviewCopy&&!!options.bestEffort;
  const includeTranscriptionWarnings=options.includeTranscriptionWarnings!==false;
  const issueMap=new Map<string,string[]>(),globalIssues:string[]=[];
  const addIssue=(q:StudioQuestion,message:string)=>{const list=issueMap.get(q.id)||[];list.push(message);issueMap.set(q.id,list);};
  if(xmlSafeText(draft.title)!==draft.title)globalIssues.push('资料名称含不可显示字符，已用替代符标记');
  const withStem=mode==='full'||mode==='text',withFigures=mode==='full'||mode==='answers';
  const withQuestionFigures=mode==='full'&&studioIncludesQuestionFigures(draft);
  if(withStem&&draft.questions.some(q=>!q.stem.trim())&&!bestEffort&&!options.transcription)throw new Error('缺少原题文字，请补充材料或选择仅解题步骤版');
  if(withStem)draft.questions.filter(q=>!q.stem.trim()).forEach(q=>addIssue(q,'缺少原题文字，已按可用内容继续导出'));
  if(!options.reviewCopy&&!options.transcription)assertStudioExportable(draft);
  if(options.transcription){
    if(mode!=='answers'){const blocker=studioOutputBlocker(draft,mode);if(blocker&&!bestEffort)throw new Error(blocker);if(blocker&&bestEffort)globalIssues.push(blocker);}
    if(draft.pages.some(p=>p.selected&&!p.processed)&&!bestEffort||withFigures&&draft.questions.some(q=>!q.drawingsChecked||mode==='full'&&!studioFiguresReady(q,draft))&&!bestEffort)throw new Error('文字或配图仍未处理完成，请继续转录');
    if(bestEffort&&withFigures)draft.questions.filter(q=>!q.drawingsChecked||mode==='full'&&!studioFiguresReady(q,draft)).forEach(q=>addIssue(q,'配图尚未完成，已保留可用原图并继续导出'));
    const used=draft.questions.flatMap(q=>q.answerIds);
    if(new Set(used).size!==used.length||draft.answers.some(a=>!used.includes(a.id))){if(!bestEffort)throw new Error('答案归属不完整，不能导出遗漏内容的文件');globalIssues.push('答案归属不完整，部分未分配答案已按原样保留');}
  }
  if(!draft.questions.length)throw new Error('没有可导出的题目');
  draft.questions.forEach(q=>{
    const metadata=[q.lesson,q.section,q.number,...q.warnings,...q.diagrams.flatMap(d=>[d.caption,...d.warnings,...d.shapes.map(s=>s.text)])];
    if(metadata.some(text=>xmlSafeText(text)!==text))addIssue(q,'标题、提示或图形标签含不可显示字符，已用替代符标记');
    const fields:[string,string][]=[['解析',q.analysis],...(withStem?[['题干',q.stem] as [string,string]]:[]),...(q.answerPlacements||[]).map(p=>['短答案',p.answer] as [string,string])];
    if(withFigures)fields.push(...q.diagrams.map(d=>['图注',d.caption] as [string,string]));
    if(mode!=='steps')fields.push(...(q.tables||[]).flatMap((table,tableIndex)=>table.rows.flatMap((row,rowIndex)=>row.map((cell,cellIndex)=>[`表格${tableIndex+1}第${rowIndex+1}行第${cellIndex+1}列`,cell] as [string,string]))));
    for(const [field,text] of fields)try{assertStudioMathSupported(text,['\u89e3\u6790','\u9898\u5e72'].includes(field));}catch(error){
      const detail=error instanceof Error?error.message:'公式转换失败';
      if(!bestEffort)throw new Error(`${[q.lesson,q.section,`第 ${q.number} 题`,field].filter(Boolean).join(' · ')}：${detail}。已转录内容仍保留在本地草稿中。`,{cause:error});
      addIssue(q,`${field}：${detail}`);
    }
  });
  const diagrams: Array<{ token: string; question: StudioQuestion; index: number; widthPt?: number }> = [];
  const outputLabel=studioOutputs(draft).find(output=>output.value===mode)?.label||'答案解析';
  const children: Array<Paragraph|Table> = [standardParagraph('TITLE',{alignment:AlignmentType.CENTER,children:[new TextRun({text:`${draft.title} ${outputLabel}${options.reviewCopy?' 待校对样张':''}`,font:STUDIO_WORD_STYLE.font,bold:true,size:30,color:'000000'})]})];
  if(options.reviewCopy)children.push(standardParagraph('BODY',{children:[new TextRun({text:'此样张仅供原件核对和排版检查，未通过正式校对，不可作为完成稿使用。',color:'C00000',font:STUDIO_WORD_STYLE.font,size:STUDIO_WORD_STYLE.size})]}));
  const safeRichText=(text:string,style:{color?:string;underline?:boolean;italicMath?:boolean;displayMath?:boolean;mathAlignment?:'left'|'center'|'right'},q:StudioQuestion,field:string):ParagraphChild[]=>{
    if(xmlSafeText(text)!==text)addIssue(q,`${field}：含不可显示字符，已用替代符标记`);
    return richText(text,{displayMath:false,...style},error=>{
      const detail=error instanceof Error?error.message:'公式转换失败';
      if(!bestEffort)throw new Error(`${q.number} / ${field}: ${detail}`,{cause:error});
      addIssue(q,`${field}：${detail}`);
    });
  };
  const paragraph = (text: string, red: boolean, keepNext=false,q?:StudioQuestion,field='文本') => standardParagraph('BODY',{keepNext,children:q?safeRichText(text,{color:red?'C00000':'000000'},q,field):richText(text,{color:red?'C00000':'000000',displayMath:false})});
  // Warnings are evidence about recognition, not mathematical content to be
  // typeset. They often quote damaged OCR such as `6\sqrt{3}` without math
  // delimiters; sending the whole sentence through the math splitter makes
  // the backslash start a false equation and can block an otherwise valid
  // full export. Preserve warning text literally so the original evidence is
  // still visible and editable in Word.
  const warningParagraph = (text:string) => standardParagraph('BODY',{children:[new TextRun({text,color:'C00000',size:STUDIO_WORD_STYLE.size,font:STUDIO_WORD_STYLE.font})]});
  if(includeTranscriptionWarnings&&globalIssues.length)children.push(warningParagraph('格式问题：'+[...new Set(globalIssues)].join('；')));
  const studioTable = (table:{rows:string[][];red?:boolean},q:StudioQuestion,tableIndex:number) => {
    const columns=Math.max(...table.rows.map(row=>row.length));
    const width=Math.max(1,Math.floor(LINE_PT*20/columns));
    const border={style:BorderStyle.SINGLE,size:4,color:'000000'};
    return new Table({layout:TableLayoutType.FIXED,width:{size:LINE_PT*20,type:WidthType.DXA},indent:{size:312,type:WidthType.DXA},columnWidths:Array.from({length:columns},()=>width),borders:{top:border,bottom:border,left:border,right:border,insideHorizontal:border,insideVertical:border},rows:table.rows.map((row,rowIndex)=>new TableRow({children:Array.from({length:columns},(_,index)=>new TableCell({width:{size:width,type:WidthType.DXA},margins:{top:40,bottom:40,left:80,right:80},children:[new Paragraph({spacing:{line:STUDIO_WORD_STYLE.line,after:0},children:safeRichText(row[index]??'', {color:table.red?'C00000':'000000',italicMath:table.red?false:undefined,displayMath:false},q,`表格${tableIndex+1}第${rowIndex+1}行第${index+1}列`)})]}))}))});
  };
  const ruledTable=(grid:NonNullable<ReturnType<typeof standaloneRuledArray>>,red:boolean,q:StudioQuestion,field:string)=>{
    // One table shares actual column widths across every row. Borders cannot
    // drift as they do with separately underlined math runs or split matrices.
    const none={style:BorderStyle.NONE,size:0,color:'FFFFFF'};
    const rule=(n:number|undefined)=>n?{style:n===2?BorderStyle.DOUBLE:BorderStyle.SINGLE,size:6,color:red?'C00000':'000000'}:none;
    const spaces:Record<string,number>={'':0,'\u2003':220,'\u2003\u2003':440,'\u2009':44,'\u2005':55,'\u2004':73};
    const widths=grid.columns.map((column,c)=>{
      const widest=Math.max(...grid.rows.map(row=>{
        const xml=mathOmml(row[c]||'');
        // Conservative glyph bound, not a change to source math. Fixed shared
        // columns prevent AUTO width=0 clipping in Word-compatible importers.
        return [...xml.matchAll(/<m:t[^>]*>(.*?)<\/m:t>/g)].reduce((n,m)=>n+Array.from(m[1].replace(/&[^;]+;/g,'X')).length,0);
      }));
      return Math.max(360,widest*220+120)+(c<grid.columns.length-1?(column.gap===undefined?110:spaces[column.gap]??110):0);
    });
    const width=widths.reduce((a,b)=>a+b,0);
    if(width>LINE_PT*20)throw new Error('Ruled array is too wide for the page; split it into smaller standalone blocks');
    return new Table({layout:TableLayoutType.FIXED,columnWidths:widths,width:{size:width,type:WidthType.DXA},borders:{top:none,bottom:none,left:none,right:none,insideHorizontal:none,insideVertical:none},rows:grid.rows.map((row,r)=>new TableRow({cantSplit:true,children:grid.columns.map((column,c)=>new TableCell({
      width:{size:widths[c],type:WidthType.DXA},margins:{top:20,bottom:20,left:0,right:c<grid.columns.length-1?(column.gap===undefined?110:spaces[column.gap]??110):0},
      borders:{left:none,right:none,top:r===0?rule(grid.rules.get(0)):none,bottom:rule(grid.rules.get(r+1))},
      children:[new Paragraph({alignment:column.align==='left'?AlignmentType.LEFT:column.align==='right'?AlignmentType.RIGHT:AlignmentType.CENTER,spacing:{after:0},children:row[c]?.trim()?safeRichText(`$${row[c]}$`,{color:red?'C00000':'000000',displayMath:false,mathAlignment:column.align},q,`${field} / array ${r+1},${c+1}`):[]})],
    }))}))});
  };
  const aligned=(text:string,red:boolean,q:StudioQuestion,field:string)=>{
    return studioAnswerParagraphs(text).flatMap((line,lineIndex)=>{
      try {
        const ruled=ruledArrayLine(line.text);
        if(ruled)return [ruledTable(ruled,red,q,field),new Paragraph({spacing:{line:120,after:80},children:[]})];
      }catch(error){
        if(!bestEffort)throw error;
        addIssue(q,`${field}: ${error instanceof Error?error.message:String(error)}`);
        return standardParagraph('BODY',{children:[new TextRun({text:`〔公式待核对：${line.text}〕`,color:'C00000',font:STUDIO_WORD_STYLE.font,size:STUDIO_WORD_STYLE.size})]});
      }
      const match=line.text.match(/^([（(]\d+[)）])\s*([\s\S]*)$/);
      const display=isStudioDisplayMathLine(match?match[2]:line.text);
      // A question number printed at the very start (“2.”) is one run as well; split into “2” and “.” the library
      // cannot recognise it and prints the paper's number in front of it (“4．2.”).
      const number=!match&&!display&&lineIndex===0?line.text.match(/^(\d{1,3}(?:[．、]|\.(?!\d)))\s*([\s\S]*)$/):null;
      const lead=match??number;
      // The label runs straight into its text, as printed. A tab after it overran the two-character hanging indent
      // when the label was a full-width “（1）”, leaving a gap that every reader drew at a different width.
      return standardParagraph(number?'QUESTION':'BODY',{keepNext:line.keepNext,children:lead?[new TextRun({text:lead[1],font:STUDIO_WORD_STYLE.font,size:STUDIO_WORD_STYLE.size,italics:false,color:red?'C00000':'000000'}),...safeRichText(lead[2],{color:red?'C00000':'000000'},q,field)]:safeRichText(line.text,{color:red?'C00000':'000000'},q,field)});
    });
  };
  let lesson='';
  for (const q of draft.questions) {
    if(q.lesson!==lesson){lesson=q.lesson;if(lesson!==draft.title)children.push(standardParagraph('SECTION',{keepNext:true,children:[new TextRun({text:lesson,font:STUDIO_WORD_STYLE.font,bold:true,size:STUDIO_WORD_STYLE.size,color:'000000'})]}));}
    children.push(standardParagraph('SECTION',{keepNext:true,children:[new TextRun({text:`${q.section} ${q.number}${options.reviewCopy?' 待校对':''}`,font:STUDIO_WORD_STYLE.font,bold:true,color:'000000',size:STUDIO_WORD_STYLE.size})]}));
    const placed=placeStudioAnswers(q.stem,q.answerPlacements);
    placed.warnings.forEach(warning=>addIssue(q,warning));
    if (withStem) {
      if(q.answerPlacements?.length&&!placed.warnings.length){
        const lines:ParagraphChild[][]=[[]];
        for(const part of placed.parts)splitMathParagraphs(part.text).forEach((line,i)=>{if(i)lines.push([]);lines.at(-1)!.push(...safeRichText(line,{color:part.red?'C00000':'000000',underline:part.underline,italicMath:part.red?false:undefined,displayMath:false},q,'题干'));});
        lines.forEach((runs,index)=>children.push(standardParagraph(index?'BODY':'QUESTION',{children:runs})));
      }else children.push(...aligned(q.stem,false,q,'题干'));
    }
    // Source pictures remain unchanged and keep their place on the original page; solution overlays accompany the analysis below.
    if (withQuestionFigures) for (const row of studioFigureRows(q)) children.push(standardParagraph('FIGURE',{alignment:row.alignment,children:row.indexes.flatMap((index,i)=>{
      const token=`STUDIO_DIAGRAM_${diagrams.length}`;
      diagrams.push({token,question:{...q,diagrams:q.diagrams.map((x,j)=>j===index?{...x,shapes:[]}:x)},index,widthPt:row.widths?.[i]});
      return [...(i?[new TextRun({text:'\u3000\u3000',font:STUDIO_WORD_STYLE.font,size:STUDIO_WORD_STYLE.size})]:[]),new TextRun(token)];
    })}));
    if(mode!=='steps')(q.tables||[]).forEach((table,tableIndex)=>{try{children.push(studioTable(table,q,tableIndex));}catch(error){if(!bestEffort)throw new Error(`${q.number} / table ${tableIndex+1}`,{cause:error});addIssue(q,`表格${tableIndex+1}：${error instanceof Error?error.message:'表格排版失败'}`);}});
    if(!withStem)for(const p of q.answerPlacements||[])children.push(standardParagraph('BODY',{children:p.kind==='choice'?[...safeRichText('（',{color:'C00000'},q,'短答案'),...safeRichText(p.answer,{color:'C00000',italicMath:false,displayMath:false},q,'短答案'),...safeRichText('）',{color:'C00000'},q,'短答案')]:safeRichText(p.answer,{color:'C00000',underline:true,displayMath:false},q,'短答案')}));
    // When the entire recorded solution is exactly the short answer, the
    // placed/underlined answer already contains all its content.
    const shortOnly=q.answerPlacements?.length===1&&q.analysis.trim()===q.answerPlacements[0].answer.trim();
    if(!shortOnly||withStem&&placed.warnings.length)children.push(...aligned(q.analysis,true,q,'解析'));
    if(withFigures&&(withQuestionFigures||q.drawingDisposition!=='question-only'))q.diagrams.forEach((d,index)=> {
      if (mode === "full" && !d.shapes.length) return;
      const token=`STUDIO_DIAGRAM_${diagrams.length}`; diagrams.push({token,question:q,index});
      if (d.caption) children.push(paragraph(d.caption,true,true,q,'图注'));
      children.push(standardParagraph('FIGURE',{alignment:AlignmentType.CENTER,children:[new TextRun(token)]}));
    });
    if(options.transcription&&includeTranscriptionWarnings){
      const textWarnings=q.warnings.filter(w=>withFigures||!['尚未检查解答图与辅助线','仅答案材料：请确认未补写原件没有的步骤'].includes(w));
      const warnings=[...new Set([...textWarnings,...(withFigures?q.diagrams.flatMap(d=>d.warnings):[]),...(withStem?placed.warnings:[])])];
      const displayedWarnings=mode==='steps'?warnings.filter(w=>w.startsWith('几何符号 □')||w.includes('异常控制字符')):warnings;
      if(displayedWarnings.length)children.push(warningParagraph('转录提示：'+displayedWarnings.join('；')));
      const issues=[...new Set(issueMap.get(q.id)||[])];
      if(issues.length)children.push(warningParagraph('格式问题：'+issues.join('；')));
    }
  }
  const document = new Document({styles:{default:{document:{run:{font:STUDIO_WORD_STYLE.font,size:STUDIO_WORD_STYLE.size}}}},sections:[{children}]});
  const zip = await JSZip.loadAsync(await (await Packer.toBlob(document)).arrayBuffer());
  let xml = await zip.file("word/document.xml")!.async("string");
  let rels = await zip.file("word/_rels/document.xml.rels")!.async("string");
  let contentTypes = await zip.file("[Content_Types].xml")!.async("string");
  for (const [i,entry] of diagrams.entries()) {
    const d = entry.question.diagrams[entry.index], relation=`rIdStudio${i}`;
    // The token's own run becomes the picture; its paragraph already carries the alignment and spacing.
    const pattern=new RegExp(`<w:r>(?:<w:rPr>(?:(?!</w:rPr>)[\\s\\S])*</w:rPr>)?<w:t[^>]*>${entry.token}</w:t></w:r>`);
    try {
    if (d.baseImage) {
      const match = d.baseImage.match(/^data:image\/(png|jpeg|webp);base64,([\s\S]+)$/);
      if (!match) throw new Error("原图格式无效，请重新裁图");
      const extension = match[1]==="jpeg"?"jpg":match[1];
      if (extension === "webp") throw new Error("请将原图转为 PNG 或 JPEG 后导出");
      zip.file(`word/media/studio-${i}.${extension}`,match[2],{base64:true});
      rels=rels.replace("</Relationships>",`<Relationship Id="${relation}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/studio-${i}.${extension}"/></Relationships>`);
      if (!contentTypes.includes(`Extension="${extension}"`)) contentTypes=contentTypes.replace("</Types>",`<Default Extension="${extension}" ContentType="image/${match[1]}"/></Types>`);
    }
    if (!pattern.test(xml)) throw new Error("未找到配图导出位置");
    xml=xml.replace(pattern,()=>studioDiagramVml(d,relation,`studio${i}`,entry.widthPt));
    } catch(error) {
      if(!bestEffort)throw new Error(`${entry.question.number} / diagram ${entry.index+1}: ${error instanceof Error?error.message:String(error)}`,{cause:error});
      addIssue(entry.question,`配图：${error instanceof Error?error.message:'配图排版失败'}，已跳过损坏图形`);
      xml=xml.replace(pattern,'');
    }
  }
  zip.file('word/document.xml',xml);
  zip.file('word/_rels/document.xml.rels',rels);zip.file('[Content_Types].xml',contentTypes);
  return packStudioWord(zip,draft.title);
}

/** The common format measured in the supplied standard papers. Recognition fills this tree;
 * paragraph flow, numbering indents, native math, tables and inline pictures determine the Word layout. */
async function buildStudioDocumentWord(draft:StudioDraft,withFigures:boolean,withWarnings:boolean) {
  draft={...draft,pages:draft.pages.map(page=>{
    if(!page.selected||!page.document)return page;
    const template=normalizeStudioDocumentTemplate(page.document,page.textHint||'');
    return {...page,document:fillStudioDocumentTemplate(template,{blocks:page.document.parts.flatMap(p=>p.sections.flatMap(s=>s.questions.flatMap(q=>q.blocks.map(b=>({id:b.id,text:b.text||'',rows:b.rows||[]}))))),warnings:page.document.warnings},page.textHint||'')};
  })};
  const font=STUDIO_WORD_STYLE.font;
  const spacing={before:0,after:0,line:360};
  const children:Array<Paragraph|Table>=[];
  const text=(value:string,style:{bold?:boolean;color?:string;size?:number;underline?:{type:'single'}}={})=>new TextRun({text:xmlSafeText(value),font,size:21,color:'000000',...style});
  const content=(value:string,underline=false)=>richText(value,{color:'000000',displayMath:false,underline});
  const paragraph=(value:string,first=false,filled?:StudioTextPart[])=>{
    const label=value.match(/^(【(?:分析|解答|点评)】)/)?.[1];
    const number=first?value.match(/^(\d{1,3}[．.、])/)?.[1]:undefined;
    const runs=filled?filled.flatMap(p=>content(p.text,!!p.underline)):label?[text(label,{color:'0000FF'}),...content(value.slice(label.length))]:number?[text(number),...content(value.slice(number.length))]:content(value);
    const role=label==='【分析】'?'ANALYSIS':label==='【解答】'?'SOLUTION':label==='【点评】'?'COMMENT':first?'QUESTION':'BODY';
    return standardParagraph(role,{spacing,children:runs});
  };
  const parts=studioDocumentParts(draft);
  let previousFile='';
  for(const [partIndex,part] of parts.entries()){
    const originalTitle=part.title||parts.find(p=>p.file===part.file&&p.title)?.title||part.file.replace(/\.[^.]+$/,'');
    const newPart=partIndex>0&&(part.kind==='answers'||part.file!==previousFile);
    children.push(standardParagraph('TITLE',{pageBreakBefore:newPart,alignment:AlignmentType.CENTER,spacing,children:[text(originalTitle,{bold:true,size:30})]}));
    if(part.kind==='answers')children.push(standardParagraph('ANSWERS_TITLE',{alignment:AlignmentType.CENTER,spacing,children:[text(part.heading||'参考答案与试题解析',{bold:true,size:16})]}));
    for(const section of part.sections){
      if(section.title)children.push(standardParagraph('SECTION',{spacing,children:[text(section.title,{bold:true})]}));
      for(const question of section.questions){
        let first=true;
        for(const source of question.blocks){
          const block=source as StudioDocumentBlock&{pageId:string};
          if(block.role==='figure'){
            if(!withFigures)continue;
            const page=draft.pages.find(p=>p.id===block.pageId);if(!page?.image)throw new Error(`第 ${question.number} 题配图原件缺失`);
            const {cropStudioImage}=await import('./answer-studio-images');
            // Grow to preserve edge labels, but never cross into an allocated text block.
            // Use the blank gap between blocks as the boundary, not a paper-specific crop.
            let left=0,top=0,right=1000,bottom=1000;const box=block.box,evidence=documentEvidence(page.textHint||'');
            for(const neighbor of page.document!.parts.flatMap(p=>p.sections.flatMap(s=>s.questions.flatMap(q=>q.blocks)))){
              if(neighbor.role==='figure')continue;const b=neighbor.box;
              // Native PDF points are baselines. The reference A4 font height also
              // covers glyphs that slightly overhang the model's paragraph box.
              const points=evidence.filter(p=>p.x>=b.x-4&&p.x<=b.x+b.width+4&&p.y>=b.y-4&&p.y<=b.y+b.height+4);
              const textTop=points.length?Math.min(...points.map(p=>p.y-p.size*20000/PAGE.height)):(b.y+box.y+box.height)/2,textBottom=points.length?Math.max(...points.map(p=>p.y+p.size*5000/PAGE.height)):(b.y+b.height+box.y)/2;
              if(b.x<box.x+box.width&&b.x+b.width>box.x){if(b.y+b.height<=box.y)top=Math.max(top,textBottom);if(b.y>=box.y+box.height)bottom=Math.min(bottom,textTop);}
              if(b.y<box.y+box.height&&b.y+b.height>box.y){if(b.x+b.width<=box.x)left=Math.max(left,(b.x+b.width+box.x)/2);if(b.x>=box.x+box.width)right=Math.min(right,(b.x+box.x+box.width)/2);}
            }
            const crop=await cropStudioImage(page.image,box,1800,{x:left,y:top,width:right-left,height:bottom-top});
            const width=Math.min((11906-2268-312)/20,block.box.width*11906/20000),height=width*crop.height/crop.width,scale=Math.min(1,600/height);
            const data=Uint8Array.from(atob(crop.image.split(',')[1]),c=>c.charCodeAt(0));
            children.push(standardParagraph('FIGURE',{spacing,children:[new ImageRun({type:'png',data,transformation:{width:width*scale*4/3,height:height*scale*4/3}})]}));
          }else if(block.role==='table'){
            const rows=block.rows||[],columns=Math.max(...rows.map(row=>row.length)),width=9326,colWidth=Math.floor(width/columns),border={style:BorderStyle.SINGLE,size:4,color:'000000'};
            children.push(new Table({layout:TableLayoutType.FIXED,width:{size:width,type:WidthType.DXA},columnWidths:Array.from({length:columns},()=>colWidth),indent:{size:312,type:WidthType.DXA},borders:{top:border,bottom:border,left:border,right:border,insideHorizontal:border,insideVertical:border},rows:rows.map(row=>new TableRow({children:Array.from({length:columns},(_,i)=>new TableCell({width:{size:colWidth,type:WidthType.DXA},margins:{top:40,bottom:40,left:80,right:80},children:[new Paragraph({spacing,children:content(row[i]||'')})]}))}))}));
          }else{
            if(typeof block.text!=='string')throw new Error(`第 ${question.number} 题有未填充的结构位置`);
            assertStudioMathSupported(block.text);
            let filled:StudioTextPart[]|undefined;
            const indicated=part.kind==='answers'&&first&&block.role==='stem'?block.text.match(/_{2,}\s*(\$[^$]+\$|[\dA-Za-z.+﹣−-]+)\s*_{2,}/):null;
            if(indicated&&(block.text.slice(0,indicated.index).match(/(?<!\\)\$/g)?.length||0)%2===0)filled=[{text:block.text.slice(0,indicated.index),red:false},{text:'\u3000'+indicated[1]+'\u3000',red:false,underline:true},{text:block.text.slice(indicated.index!+indicated[0].length),red:false}];
            if(!filled&&part.kind==='answers'&&first&&block.role==='stem'&&!block.text.includes('\\underline')){
              const original=parts.find(p=>p.file===part.file&&p.kind==='questions')?.sections.flatMap(s=>s.questions).find(q=>q.number===question.number)?.blocks.find(b=>b.role==='stem')?.text||'';
              const slots=[...original.matchAll(/_{2,}/g)],compact=block.text.replace(/\s/g,''),slot=slots[0];
              if(slots.length===1){
                const prefix=original.slice(0,slot.index).replace(/\s/g,''),suffix=original.slice(slot.index!+slot[0].length).replace(/\s/g,'');
                if(compact.startsWith(prefix)&&compact.endsWith(suffix)&&compact.length>prefix.length+suffix.length){
                  const positions=[...block.text.matchAll(/\S/g)].map(m=>m.index!),start=positions[prefix.length],end=suffix?positions[compact.length-suffix.length]:block.text.length,answer=block.text.slice(start,end).trim().replace(/^_+\s*|\s*_+$/g,'').trim();
                  if(answer&&!answer.includes('_'))filled=placeStudioAnswers(block.text.slice(0,start)+slot[0]+block.text.slice(end),[{kind:'blank',placeholder:slot[0],answer:/^[\dA-Za-z.+﹣−-]+$/.test(answer)?'\u3000'+answer+'\u3000':answer}]).parts;
                }
              }
            }
            children.push(paragraph(block.text,first&&block.role==='stem',filled));first=false;
          }
        }
      }
    }
    previousFile=part.file;
  }
  if(!children.length)throw new Error('原件中没有可输出的试卷正文');
  const notes=draft.pages.filter(p=>p.selected).flatMap(p=>(p.document?.warnings||[]).map(w=>`第 ${p.page} 页：${w}`));
  if(withWarnings&&notes.length){children.push(standardParagraph('BODY',{pageBreakBefore:true,spacing,children:[text('转录问题提示',{bold:true})]}));for(const note of notes)children.push(standardParagraph('BODY',{spacing,children:[text(note,{color:'C00000'})]}));}
  return packStudioWord(await JSZip.loadAsync(await(await Packer.toBlob(new Document({sections:[{children}]}))).arrayBuffer()),parts[0]?.title||draft.title);
}

/** All transcription modes enter the same retained Word package and formatting rules. */
async function packStudioWord(generated:JSZip,title:string) {
  const response=await fetch('/standard-math-paper.docx');
  if(!response.ok)throw new Error('标准试卷 Word 模板读取失败，请刷新后重试');
  // Start with the sanitized copy of the retained reference package. Its real styles,
  // theme, font table, section properties and footer remain the design authority.
  const template=await JSZip.loadAsync(await response.arrayBuffer());
  const templateXml=await template.file('word/document.xml')!.async('string');
  const patterns=new Map([...templateXml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].flatMap(match=>{const role=match[0].match(/MP_TEMPLATE_([A-Z_]+)/)?.[1];return role?[[role,match[0]] as const]:[];}));
  let body=(await generated.file('word/document.xml')!.async('string')).match(/<w:body>([\s\S]*)<\/w:body>/)![1].replace(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g,'');
  body=body.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g,paragraph=>{
    const role=paragraph.match(/<w:pStyle w:val="MP_TEMPLATE_([A-Z_]+)"\/>/)?.[1];if(!role)return paragraph;
    const pattern=patterns.get(role);if(!pattern)throw new Error(`标准模板缺少 ${role} 段落`);
    let properties=pattern.match(/<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>|<w:pPr\b[^>]*\/>/)?.[0]||'<w:pPr/>';
    if(properties.endsWith('/>'))properties=properties.replace('/>','></w:pPr>');
    const existing=paragraph.match(/<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>/)?.[0]||'';
    const retain=['pageBreakBefore','keepNext',...(role==='FIGURE'?['jc']:[])];
    for(const name of retain){
      const property=existing.match(new RegExp(`<w:${name}\\b[^>]*\\/>`))?.[0];if(!property)continue;
      properties=properties.replace(new RegExp(`<w:${name}\\b[^>]*\\/>`),'').replace('</w:pPr>',property+'</w:pPr>');
    }
    // Keep the teacher's red solution annotation while sharing the reference font and layout.
    if(paragraph.includes('w:val="C00000"')&&!paragraph.includes('w:val="000000"'))properties=properties.replace('</w:pPr>','<w:rPr><w:color w:val="C00000"/></w:rPr></w:pPr>');
    const clean=/<w:pPr\b/.test(paragraph)?paragraph.replace(/<w:pPr\b[^>]*>[\s\S]*?<\/w:pPr>|<w:pPr\b[^>]*\/>/,properties):paragraph.replace(/^(<w:p(?:\s[^>]*)?>)/,'$1'+properties);
    return clean;
  });
  // The source uses fixed ordinary parentheses, and scalable braces only for grids/cases.
  // Work from the innermost delimiter so nested coordinates and fractions remain balanced.
  const caseMatrixProperties=mathOmml('\\begin{array}{l}0\\end{array}').match(/<m:mPr>[\s\S]*?<\/m:mPr>/)![0];
  body=body.replace(/<m:oMath\b[^>]*>[\s\S]*?<\/m:oMath>/g,math=>{
    while(true){
      const fixed=math.replace(/<m:d>(<m:dPr>[\s\S]*?<\/m:dPr>)<m:e>((?:(?!<m:d>)[\s\S])*?)<\/m:e><\/m:d>/g,(whole,properties:string,inner:string)=>{
        const begin=properties.match(/<m:begChr m:val="([^"]*)"\/>/)?.[1],end=properties.match(/<m:endChr m:val="([^"]*)"\/>/)?.[1];
        if(!['()','[]'].includes((begin||'')+(end||''))||/<m:(?:m|eqArr)>/.test(inner))return whole;
        const font=inner.match(/<m:r>(?:<m:rPr>[\s\S]*?<\/m:rPr>)?(<w:rPr>[\s\S]*?<\/w:rPr>)/)?.[1]||math.match(/<w:rPr>[\s\S]*?<\/w:rPr>/)?.[0]||'';
        return `<m:r><m:rPr><m:sty m:val="p"/></m:rPr>${font}<m:t>${begin}</m:t></m:r>${inner}<m:r><m:rPr><m:sty m:val="p"/></m:rPr>${font}<m:t>${end}</m:t></m:r>`;
      });
      if(fixed===math)break;math=fixed;
    }
    // The retained papers use one left-aligned matrix column under a case brace.
    // Replace innermost equation arrays first so nested cases remain balanced.
    while(math.includes('<m:eqArr>')){
      const aligned=math.replace(/<m:eqArr>((?:(?!<m:eqArr>)[\s\S])*?)<\/m:eqArr>/g,(_,inner:string)=>{
        let depth=0;const rows=inner.replace(/<m:eqArrPr>[\s\S]*?<\/m:eqArrPr>/,'').replace(/<m:e\/>|<\/?m:e>/g,tag=>{
          if(tag==='<m:e/>')return depth===0?'<m:mr>'+tag+'</m:mr>':tag;
          if(tag==='<m:e>')return depth++===0?'<m:mr>'+tag:tag;
          return --depth===0?tag+'</m:mr>':tag;
        });
        return '<m:m>'+caseMatrixProperties+rows+'</m:m>';
      });
      if(aligned===math)break;math=aligned;
    }
    const withoutSizes=math.replace(/w:eastAsia="Songti SC"/g,'w:eastAsia="新宋体"').replace(/<m:r>[\s\S]*?<\/m:r>/g,run=>run.replace(/<w:sz(?:Cs)? w:val="21"\/>/g,''));
    let depth=0;
    // Every fraction argument in the source has the same nominal size, including
    // three-level continued fractions. Office alone applies script-level reduction.
    const fractionSize=STUDIO_WORD_STYLE.fractionSize;
    const fractions:string=withoutSizes.replace(/<m:f>|<\/m:f>|<m:r>([\s\S]*?)<\/m:r>/g,(tag:string,inner:string|undefined,offset:number,source:string)=>{
      if(inner===undefined){
        if(tag.startsWith('</')){depth--;return tag;}
        depth++;return !source.startsWith('<m:fPr>',offset+tag.length)?`${tag}<m:fPr><m:type m:val="bar"/><m:ctrlPr><w:rPr><w:sz w:val="${fractionSize}"/><w:szCs w:val="${fractionSize}"/></w:rPr></m:ctrlPr></m:fPr>`:tag;
      }
      if(!depth||/<w:sz\b/.test(inner))return tag;
      return `<m:r>${inner.replace('</w:rPr>',`<w:sz w:val="${fractionSize}"/><w:szCs w:val="${fractionSize}"/></w:rPr>`)}</m:r>`;
    });
    return fractions.replace(/<m:r>(<m:rPr>[\s\S]*?<\/m:rPr>)?<w:rPr>([\s\S]*?)<\/w:rPr>/g,(whole,properties='',word:string)=>/<w:sz\b/.test(word)?whole:`<m:r>${properties}<w:rPr>${word}<w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr>`);
  });
  // A zero-width non-joiner retains inline context for a formula-only paragraph.
  // Unlike U+200B, U+200C adds no width in WPS. Without it Word/WPS can promote the equation to display mode and render the
  // reference's 14 pt fraction arguments at full size instead of their inline size.
  const inlineContext='<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="新宋体"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr><w:t>\u200C</w:t></w:r>';
  body=body.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g,paragraph=>{
    if(!paragraph.includes('<m:oMath>'))return paragraph;
    const surrounding=paragraph.replace(/<m:oMath>[\s\S]*?<\/m:oMath>/g,'');
    return [...surrounding.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].some(match=>match[1].trim())?paragraph:paragraph.replace('<m:oMath>',inlineContext+'<m:oMath>');
  });
  let relationships=await template.file('word/_rels/document.xml.rels')!.async('string'),types=await template.file('[Content_Types].xml')!.async('string'),imageId=0;
  const generatedRelationships=await generated.file('word/_rels/document.xml.rels')!.async('string');
  for(const relation of generatedRelationships.matchAll(/<Relationship\b[^>]*\/>/g)){
    const attribute=(name:string)=>relation[0].match(new RegExp(`\\b${name}="([^"]*)"`))?.[1]||'';
    if(!attribute('Type').endsWith('/image'))continue;
    const old=attribute('Id'),source=attribute('Target').replace(/^\//,''),extension=source.split('.').at(-1)!,id=`rIdStudioImage${++imageId}`,target=`media/studio-${imageId}.${extension}`;
    const file=generated.file(source.startsWith('word/')?source:'word/'+source);if(!file)throw new Error('生成的题图关系不完整');
    template.file('word/'+target,await file.async('uint8array'));body=body.split(`r:embed="${old}"`).join(`r:embed="${id}"`).split(`r:id="${old}"`).join(`r:id="${id}"`);
    relationships=relationships.replace('</Relationships>',`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="${target}"/></Relationships>`);
    if(!types.includes(`Extension="${extension}"`))types=types.replace('</Types>',`<Default Extension="${extension}" ContentType="image/${extension==='jpg'?'jpeg':extension}"/></Types>`);
  }
  const section=templateXml.match(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/)![0];let drawingId=0;
  template.file('word/document.xml',templateXml.replace(/<w:body>[\s\S]*<\/w:body>/,`<w:body>${body}${section}</w:body>`).replace(/<wp:docPr\b[^>]*\bid="[^"]*"[^>]*\/>/g,tag=>tag.replace(/\bid="[^"]*"/,`id="${++drawingId}"`)));
  template.file('word/_rels/document.xml.rels',relationships);template.file('[Content_Types].xml',types);
  let settings=ensureWordMathSettings(await template.file('word/settings.xml')!.async('string')).replace(/<m:defJc\b[^>]*\/>/,'<m:defJc m:val="left"/>');
  settings=/<w:updateFields\b/.test(settings)?settings.replace(/<w:updateFields\b[^>]*\/>/,'<w:updateFields w:val="true"/>'):settings.replace('</w:settings>','<w:updateFields w:val="true"/></w:settings>');
  template.file('word/settings.xml',settings);
  template.file('docProps/core.xml',(await template.file('docProps/core.xml')!.async('string')).replace(/<dc:title>[\s\S]*?<\/dc:title>/,`<dc:title>${xmlEscape(title)}</dc:title>`));
  for(const file of Object.values(template.files))if(!file.dir&&/\.(xml|rels)$/.test(file.name)){
    const content=await file.async('string');const safe=xmlSafeText(content);
    if(safe!==content)template.file(file.name,safe);
  }
  return template.generateAsync({type:'blob',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});
}
export function downloadStudioBlob(blob: Blob, name: string) {
  const url=URL.createObjectURL(blob), link=document.createElement("a");
  link.href=url; link.download=name.replace(/[\\/:*?"<>|]/g,"_"); link.click(); setTimeout(()=>URL.revokeObjectURL(url),30_000);
}
