// Isolated, local-only export regression harness. Not part of the product UI.
// Reads an already exported DOCX: it does NOT emulate or charge for AI OCR.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import JSZip from 'jszip';
import { parseDocxWebContent, docxWebInlineText } from '../lib/docx-web-content';
import { buildStudioWord } from '../lib/answer-studio-export';
import { normalizeStudioTextFields } from '../lib/answer-studio-normalize';
import { emptyStudioDraft, type StudioQuestion } from '../lib/answer-studio';
import { MathText } from '../app/components/StudioMathText';
import { studioOutputs, type StudioOutputMode } from '../lib/answer-studio-output';
import samples from '../tests/fixtures/answer-studio-s9-math.json';
import 'katex/dist/katex.min.css';

function Harness(){
  const [questions,setQuestions]=useState<StudioQuestion[]>([]),[message,setMessage]=useState('请选择报告对应的 DOCX；仅在本机读取，不上传至 AI 或题库。');
  const [url,setUrl]=useState(''),[filename,setFilename]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{void fetch('/sample.docx').then(async response=>{if(!response.ok)return;const file=new File([await response.arrayBuffer()],'03 S9 sample.docx',{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});await open(file);}).catch(()=>{});},[]);
  async function open(file?:File){
    if(!file)return;
    try{
      setBusy(true);setUrl('');
      const zip=await JSZip.loadAsync(file),xml=await zip.file('word/document.xml')!.async('string');
      const paragraphs=xml.match(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)||[];
      const next=samples.samples.map(({index})=>{
        const block=parseDocxWebContent([paragraphs[index]||'']).blocks[0];
        if(!block||block.type!=='paragraph')throw Error(`找不到报告段落 ${index}`);
        // A stranded dollar immediately before native OMML is a literal
        // source error, not an additional opening math delimiter.
        const inlines=block.inlines;
        const text=inlines.map((item,i)=>item.type==='math'&&i>0&&inlines[i-1].type==='text'&&(inlines[i-1] as {value:string}).value==='$'
          ? item.latex : docxWebInlineText([item])).join('');
        return {id:`p-${index}`,lesson:'报告原段落回归',section:'段落',number:String(index),stem:'',analysis:text,answerIds:[],questionSources:[],diagrams:[],tables:[],warnings:[],resolutions:{},reviewed:false,answerOnly:true,drawingsChecked:true,drawingsRevision:3,drawingsIncludeQuestionFigures:false,drawingDisposition:'none'} as StudioQuestion;
      });
      setQuestions(next);setMessage(`已从 ${paragraphs.length} 段原文中提取报告的 ${next.length} 处；这是导出器回归，不是整册重新识别。`);
    }catch(e){setMessage(String(e));}finally{setBusy(false);}
  }
  async function generate(mode:StudioOutputMode){
    try{
      setBusy(true);if(url)URL.revokeObjectURL(url);setUrl('');
      const draft={...emptyStudioDraft(),inputMode:'answers' as const,title:'S9寒公式回归样张',questions};
      const blob=await buildStudioWord(draft,mode,{transcription:true,bestEffort:true});
      setUrl(URL.createObjectURL(blob));setFilename(`S9寒公式回归_${mode}.docx`);setMessage('已生成，可下载。原文含义未改写；不明确的几何符号留在 Word 中标记。');
    }catch(e){setMessage(String(e));}finally{setBusy(false);}
  }
  return <main><h1>答案导出回归验证</h1><p>仅使用生产代码的文字规范化、网页公式与 Word 导出器。无登录、无数据库、无模型请求。</p>
    <label>导入待验证 DOCX<input type="file" accept=".docx" disabled={busy} onChange={e=>void open(e.target.files?.[0])}/></label>
    <p role="status">{message}</p>
    <div className="actions">{studioOutputs({inputMode:'answers'}).map(o=><button key={o.value} disabled={busy||!questions.length} onClick={()=>void generate(o.value)}>{o.label}</button>)}</div>
    {url&&<a href={url} download={filename}>下载回归 Word</a>}
    <section>{questions.map(q=><article key={q.id}><h2>原段落 {q.number}</h2><div className="sample"><MathText text={normalizeStudioTextFields(q).analysis}/></div></article>)}</section>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);
