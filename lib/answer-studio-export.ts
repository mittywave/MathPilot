import { WORD_MATH_STYLE } from './math-capabilities.mjs';
import { Document, Packer, Paragraph, TextRun, AlignmentType, Table, TableRow, TableCell, BorderStyle, WidthType, TableLayoutType, type ParagraphChild } from "docx";
import JSZip from "jszip";
import { richText } from "./answer-studio-rich-text";
import { assertStudioExportable, hasStudioControlCharacters, type StudioDraft, type StudioQuestion, type StudioSource } from "./answer-studio";
import { diagramBounds, studioDiagramVml } from "./answer-studio-diagram";
import { ensureWordMathSettings, fullSizeInlineFractions } from "./word-math-sizing.mjs";
import { splitMathText } from "./answer-studio-math-text";
import { standaloneRuledArray, standaloneRuledArrayLine as ruledArrayLine } from './math-grid';
import { mathOmml } from './math-omml';
import { isStudioDisplayMathLine } from './studio-math-layout';
import { repairMathSource, scanMathSource, splitMathParagraphs } from './math-source.mjs';
import { normalizeStudioTextFields } from './answer-studio-normalize';
import { xmlSafeText } from './xml-text';
import { placeStudioAnswers } from './answer-studio-layout';
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

// A4 with 1080-twip margins; the body line is 9746 twips (about 487 pt) wide.
const PAGE={width:11906,height:16838,margin:1080};
const LINE_PT=(PAGE.width-2*PAGE.margin)/20;
// The two ideographic spaces between pictures on one row, in 11 pt body text.
const FIGURE_GAP_PT=22;

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
  const children: Array<Paragraph|Table> = [new Paragraph({ style:"Title", alignment:AlignmentType.CENTER, children:[new TextRun({text:`${draft.title} ${outputLabel}${options.reviewCopy?' 待校对样张':''}`,bold:true,size:32,color:"000000"})],spacing:{after:300} })];
  if(options.reviewCopy)children.push(new Paragraph({children:[new TextRun({text:'此样张仅供原件核对和排版检查，未通过正式校对，不可作为完成稿使用。',color:'C00000'})]}));
  const safeRichText=(text:string,style:{color?:string;underline?:boolean;italicMath?:boolean;displayMath?:boolean;mathAlignment?:'left'|'center'|'right'},q:StudioQuestion,field:string):ParagraphChild[]=>{
    if(xmlSafeText(text)!==text)addIssue(q,`${field}：含不可显示字符，已用替代符标记`);
    return richText(text,style,error=>{
      const detail=error instanceof Error?error.message:'公式转换失败';
      if(!bestEffort)throw new Error(`${q.number} / ${field}: ${detail}`,{cause:error});
      addIssue(q,`${field}：${detail}`);
    });
  };
  const paragraph = (text: string, red: boolean, keepNext=false,q?:StudioQuestion,field='文本') => new Paragraph({ keepNext, style:red?'StudioAnswer':'Normal', spacing:{line:360,after:80}, children:q?safeRichText(text,{ color:red?'C00000':'000000' },q,field):richText(text,{ color:red?'C00000':'000000' }) });
  // Warnings are evidence about recognition, not mathematical content to be
  // typeset. They often quote damaged OCR such as `6\sqrt{3}` without math
  // delimiters; sending the whole sentence through the math splitter makes
  // the backslash start a false equation and can block an otherwise valid
  // full export. Preserve warning text literally so the original evidence is
  // still visible and editable in Word.
  const warningParagraph = (text:string) => new Paragraph({style:'StudioAnswer',spacing:{line:360,after:80},children:[new TextRun({text,color:'C00000',size:22,font:{ascii:'Times New Roman',hAnsi:'Times New Roman',eastAsia:'Songti SC',cs:'Times New Roman'}})]});
  if(includeTranscriptionWarnings&&globalIssues.length)children.push(warningParagraph('格式问题：'+[...new Set(globalIssues)].join('；')));
  const figureSpacing={before:100,after:140};
  const studioTable = (table:{rows:string[][];red?:boolean},q:StudioQuestion,tableIndex:number) => {
    const columns=Math.max(...table.rows.map(row=>row.length));
    const width=Math.max(1,Math.floor(9300/columns));
    const border={style:BorderStyle.SINGLE,size:4,color:'D9D9D9'};
    return new Table({layout:TableLayoutType.FIXED,width:{size:9300,type:WidthType.DXA},columnWidths:Array.from({length:columns},()=>width),borders:{top:border,bottom:border,left:border,right:border,insideHorizontal:border,insideVertical:border},rows:table.rows.map((row,rowIndex)=>new TableRow({children:Array.from({length:columns},(_,index)=>new TableCell({width:{size:width,type:WidthType.DXA},margins:{top:80,bottom:80,left:120,right:120},children:[new Paragraph({spacing:{line:300,after:0},children:safeRichText(row[index]??'', {color:table.red?'C00000':'000000',italicMath:table.red?false:undefined,displayMath:false},q,`表格${tableIndex+1}第${rowIndex+1}行第${index+1}列`)})]}))}))});
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
    if(width>9300)throw new Error('Ruled array is too wide for the page; split it into smaller standalone blocks');
    return new Table({layout:TableLayoutType.FIXED,columnWidths:widths,width:{size:width,type:WidthType.DXA},borders:{top:none,bottom:none,left:none,right:none,insideHorizontal:none,insideVertical:none},rows:grid.rows.map((row,r)=>new TableRow({cantSplit:true,children:grid.columns.map((column,c)=>new TableCell({
      width:{size:widths[c],type:WidthType.DXA},margins:{top:20,bottom:20,left:0,right:c<grid.columns.length-1?(column.gap===undefined?110:spaces[column.gap]??110):0},
      borders:{left:none,right:none,top:r===0?rule(grid.rules.get(0)):none,bottom:rule(grid.rules.get(r+1))},
      children:[new Paragraph({alignment:column.align==='left'?AlignmentType.LEFT:column.align==='right'?AlignmentType.RIGHT:AlignmentType.CENTER,spacing:{after:0},children:row[c]?.trim()?safeRichText(`$${row[c]}$`,{color:red?'C00000':'000000',displayMath:false,mathAlignment:column.align},q,`${field} / array ${r+1},${c+1}`):[]})],
    }))}))});
  };
  const aligned=(text:string,red:boolean,q:StudioQuestion,field:string)=>{
    let inPart=false;
    return studioAnswerParagraphs(text).flatMap((line,lineIndex)=>{
      try {
        const ruled=ruledArrayLine(line.text);
        if(ruled)return [ruledTable(ruled,red,q,field),new Paragraph({spacing:{line:120,after:80},children:[]})];
      }catch(error){
        if(!bestEffort)throw error;
        addIssue(q,`${field}: ${error instanceof Error?error.message:String(error)}`);
        return new Paragraph({children:[new TextRun({text:`〔公式待核对：${line.text}〕`,color:'C00000',size:WORD_MATH_STYLE.baseSize})]});
      }
      const match=line.text.match(/^([（(]\d+[)）])\s*([\s\S]*)$/);
      if(match)inPart=true;
      const display=isStudioDisplayMathLine(match?match[2]:line.text);
      // A question number printed at the very start (“2.”) is one run as well; split into “2” and “.” the library
      // cannot recognise it and prints the paper's number in front of it (“4．2.”).
      const number=!match&&!display&&lineIndex===0?line.text.match(/^(\d{1,3}(?:[．、]|\.(?!\d)))\s*([\s\S]*)$/):null;
      const lead=match??number;
      // The label runs straight into its text, as printed. A tab after it overran the two-character hanging indent
      // when the label was a full-width “（1）”, leaving a gap that every reader drew at a different width.
      return new Paragraph({style:display?(red?'StudioMathAnswer':'StudioMathBody'):red?'StudioAnswer':'Normal',keepNext:line.keepNext,spacing:{line:360,after:80},indent:inPart?{left:420,...(match?{hanging:420}:{})}:undefined,children:lead?[new TextRun({text:lead[1],italics:false,color:red?'C00000':'000000'}),...safeRichText(lead[2],{color:red?'C00000':'000000',...(number?{displayMath:false}:{})},q,field)]:safeRichText(line.text,{color:red?'C00000':'000000'},q,field)});
    });
  };
  let lesson='';
  for (const q of draft.questions) {
    if(q.lesson!==lesson){lesson=q.lesson;if(lesson!==draft.title)children.push(new Paragraph({keepNext:true,spacing:{before:300,after:120},children:[new TextRun({text:lesson,bold:true,size:28,color:'000000'})]}));}
    children.push(new Paragraph({ keepNext:true,spacing:{before:240,after:120}, children:[new TextRun({text:`${q.section} ${q.number}${options.reviewCopy?' 待校对':''}`,bold:true,color:"000000",size:24})] }));
    const placed=placeStudioAnswers(q.stem,q.answerPlacements);
    placed.warnings.forEach(warning=>addIssue(q,warning));
    if (withStem) {
      if(q.answerPlacements?.length&&!placed.warnings.length){
        const lines:ParagraphChild[][]=[[]];
        for(const part of placed.parts)splitMathParagraphs(part.text).forEach((line,i)=>{if(i)lines.push([]);lines.at(-1)!.push(...safeRichText(line,{color:part.red?'C00000':'000000',underline:part.underline,italicMath:part.red?false:undefined,displayMath:false},q,'题干'));});
        lines.forEach(runs=>children.push(new Paragraph({spacing:{line:360,after:80},children:runs})));
      }else children.push(...aligned(q.stem,false,q,'题干'));
    }
    // Source pictures remain unchanged and keep their place on the original page; solution overlays accompany the analysis below.
    if (withQuestionFigures) for (const row of studioFigureRows(q)) children.push(new Paragraph({alignment:row.alignment,spacing:figureSpacing,children:row.indexes.flatMap((index,i)=>{
      const token=`STUDIO_DIAGRAM_${diagrams.length}`;
      diagrams.push({token,question:{...q,diagrams:q.diagrams.map((x,j)=>j===index?{...x,shapes:[]}:x)},index,widthPt:row.widths?.[i]});
      return [...(i?[new TextRun('\u3000\u3000')]:[]),new TextRun(token)];
    })}));
    if(mode!=='steps')(q.tables||[]).forEach((table,tableIndex)=>{try{children.push(studioTable(table,q,tableIndex));}catch(error){if(!bestEffort)throw new Error(`${q.number} / table ${tableIndex+1}`,{cause:error});addIssue(q,`表格${tableIndex+1}：${error instanceof Error?error.message:'表格排版失败'}`);}});
    if(!withStem)for(const p of q.answerPlacements||[])children.push(new Paragraph({style:'StudioAnswer',spacing:{line:360,after:80},children:p.kind==='choice'?[...safeRichText('（',{color:'C00000'},q,'短答案'),...safeRichText(p.answer,{color:'C00000',italicMath:false,displayMath:false},q,'短答案'),...safeRichText('）',{color:'C00000'},q,'短答案')]:safeRichText(p.answer,{color:'C00000',underline:true,displayMath:false},q,'短答案')}));
    // When the entire recorded solution is exactly the short answer, the
    // placed/underlined answer already contains all its content.
    const shortOnly=q.answerPlacements?.length===1&&q.analysis.trim()===q.answerPlacements[0].answer.trim();
    if(!shortOnly||withStem&&placed.warnings.length)children.push(...aligned(q.analysis,true,q,'解析'));
    if(withFigures&&(withQuestionFigures||q.drawingDisposition!=='question-only'))q.diagrams.forEach((d,index)=> {
      if (mode === "full" && !d.shapes.length) return;
      const token=`STUDIO_DIAGRAM_${diagrams.length}`; diagrams.push({token,question:q,index});
      if (d.caption) children.push(paragraph(d.caption,true,true,q,'图注'));
      children.push(new Paragraph({alignment:AlignmentType.CENTER,spacing:figureSpacing,children:[new TextRun(token)]}));
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
  const font={ascii:"Times New Roman",hAnsi:"Times New Roman",eastAsia:"Songti SC",cs:"Times New Roman"};
  const document = new Document({styles:{default:{document:{run:{font,size:22},paragraph:{spacing:{line:360}}}},paragraphStyles:[{id:"Title",name:"Title",basedOn:"Normal",run:{color:"000000",size:32,bold:true}},{id:"StudioAnswer",name:"Studio Answer",basedOn:"Normal",run:{color:"C00000",font,size:22}},{id:"StudioMathAnswer",name:"Studio Display Math Answer",basedOn:"StudioAnswer",run:{color:"C00000",font,size:WORD_MATH_STYLE.baseSize}},{id:"StudioMathBody",name:"Studio Display Math",basedOn:"Normal",run:{color:"000000",font,size:WORD_MATH_STYLE.baseSize}}]},sections:[{properties:{page:{size:{width:PAGE.width,height:PAGE.height},margin:{top:PAGE.margin,right:PAGE.margin,bottom:PAGE.margin,left:PAGE.margin}}},children}]});
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
  // Include the paragraph end-mark properties as well as OMML run properties:
  // equation importers may use the surrounding paragraph's character color.
  xml=xml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g,p=>/w:val="Studio(?:Math)?Answer"/.test(p) ? p.replace('</w:pPr>',`<w:rPr><w:color w:val="C00000"/></w:rPr></w:pPr>`) : p);
  zip.file("word/document.xml",fullSizeInlineFractions(xml));
  zip.file("word/_rels/document.xml.rels",rels); zip.file("[Content_Types].xml",contentTypes);
  // Word/WPS can promote a formula-only paragraph to display math. Keep those
  // lines aligned with the proof instead of inheriting the exam export's center.
  const mathSettings=ensureWordMathSettings(await zip.file("word/settings.xml")!.async("string"));
  zip.file("word/settings.xml",mathSettings.replace(/<m:defJc\b[^>]*\/>/,'<m:defJc m:val="left"/>'));
  // All output paths (plain text, metadata, native equations and VML labels)
  // must produce XML 1.0 even when unrecognized OCR is retained as evidence.
  for(const file of Object.values(zip.files))if(!file.dir&&/\.(xml|rels)$/.test(file.name)){
    const content=await file.async('string');const safe=xmlSafeText(content);
    if(safe!==content)zip.file(file.name,safe);
  }
  return zip.generateAsync({type:"blob",mimeType:"application/vnd.openxmlformats-officedocument.wordprocessingml.document"});
}
export function downloadStudioBlob(blob: Blob, name: string) {
  const url=URL.createObjectURL(blob), link=document.createElement("a");
  link.href=url; link.download=name.replace(/[\\/:*?"<>|]/g,"_"); link.click(); setTimeout(()=>URL.revokeObjectURL(url),30_000);
}
