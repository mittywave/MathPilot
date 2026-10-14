"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- client-only vinext navigation */
import { useEffect, useRef, useState } from 'react';
import { fetchMe } from '../../../lib/api-client';
import type { AuthUser } from '../../../lib/types';
import { deduplicateStudioPages, emptyStudioDraft, type StudioDraft, type StudioRecord } from '../../../lib/answer-studio';
import { studioPreparedImages } from '../../../lib/answer-studio-prepared-images';
import { studioSnapshot } from '../../../lib/answer-studio-snapshot';
import { studioStorage } from '../../../lib/answer-studio-storage';
import { cropStudioImage, readStudioFilesInBatches, resizeStudioImage } from '../../../lib/answer-studio-images';
import { recognizeStudioDrawings } from '../../../lib/answer-studio-drawings';
import { transcribeStudio, type StudioDrawingResult } from '../../../lib/answer-studio-pipeline';
import { StudioDownloads, type StudioDownload } from '../../../lib/answer-studio-downloads';
import { studioIncludesQuestionFigures, studioOutputBlocker, studioOutputs, studioTextReady, type StudioOutputMode } from '../../../lib/answer-studio-output';
import { studioApi as api, STUDIO_TEXT_CONCURRENCY, STUDIO_CONCURRENCY_CHOICES } from '../../../lib/answer-studio-concurrency';
import './studio.css';

function StudioIcon({name}:{name:'pen'|'files'|'file'|'spark'|'download'|'steps'|'text'|'check'|'back'|'upload'}) {
  const paths={
    check:<path d="m5 12 4 4L19 6"/>,
    upload:<><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/></>,
    back:<path d="m10 5-7 7 7 7M3 12h18"/>,
    pen:<><path d="m4 16.5 9.8-9.8 3.5 3.5-9.8 9.8L4 21l.5-4.5Z"/><path d="m12.5 8 3.5 3.5M4 21l4.5-.5"/></>,
    files:<><path d="M7 3h8l3 3v15H7z"/><path d="M15 3v4h3M4 7v14h3M10 12h5M10 16h5"/></>,
    file:<><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h4M9 13h6M9 17h4"/></>,
    spark:<><path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3Z"/><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z"/></>,
    download:<><path d="M12 3v12M7 11l5 5 5-5M4 20h16"/></>,
    steps:<><path d="M6 5h12M6 12h12M6 19h12"/><path d="M3 5h.01M3 12h.01M3 19h.01"/></>,
    text:<><path d="M5 5h14M5 10h14M5 15h9M5 20h7"/></>,
  } as const;
  return <svg className="studio-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}

const STUDIO_ACCEPT='application/pdf,image/png,image/jpeg,image/webp';

// A visible drop zone instead of the bare browser file input: it says what to put here, how
// (click or drag), and which formats work. The real input covers the zone, so click and drop are native.
function UploadZone({id,icon,title,hint,files,onFiles}:{id:string;icon:'file'|'pen';title:string;hint:string;files:File[];onFiles:(list:FileList|null)=>void}) {
  const names=files.map(file=>file.name);
  return <div className="upload-field">
    <span className="field-heading" id={`${id}-title`}><StudioIcon name={icon}/>{title}</span>
    <div className={files.length?'upload-zone has-files':'upload-zone'}>
      <input id={id} type="file" multiple accept={STUDIO_ACCEPT} aria-labelledby={`${id}-title`} aria-describedby={`${id}-formats`}
        onDragEnter={e=>e.currentTarget.parentElement?.classList.add('dragging')} onDragLeave={e=>e.currentTarget.parentElement?.classList.remove('dragging')}
        onDrop={e=>e.currentTarget.parentElement?.classList.remove('dragging')} onChange={e=>onFiles(e.target.files)}/>
      <span className="upload-zone-icon"><StudioIcon name={files.length?'check':'upload'}/></span>
      {files.length
        ?<span className="upload-zone-copy"><strong>已选择 {files.length} 个文件</strong><small className="upload-zone-names">{names.slice(0,3).join('、')}{names.length>3?` 等 ${names.length} 个`:''}</small><small>点击或拖入可重新选择</small></span>
        :<span className="upload-zone-copy"><strong>点击选择文件，或拖到这里</strong><small>{hint}，可一次选多个</small></span>}
    </div>
    <p className="upload-formats" id={`${id}-formats`}><span>支持</span><b>PDF 文件</b><b>图片 PNG · JPG · WebP</b></p>
  </div>;
}

export default function AnswerStudioPage() {
  const [user,setUser]=useState<AuthUser|null>(null),[loaded,setLoaded]=useState(false);
  const [mode,setMode]=useState<'paired'|'answers'>('paired'),[title,setTitle]=useState('');
  const [questionFiles,setQuestionFiles]=useState<File[]>([]),[answerFiles,setAnswerFiles]=useState<File[]>([]);
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[failed,setFailed]=useState(false);
  const [saved,setSaved]=useState<StudioDraft|null>(null),[downloads,setDownloads]=useState<StudioDownload[]>([]);
  const [output,setOutput]=useState<StudioOutputMode>('full');
  const [includeTranscriptionWarnings,setIncludeTranscriptionWarnings]=useState(true);
  const [textConcurrency,setTextConcurrency]=useState(STUDIO_TEXT_CONCURRENCY);
  const links=useRef(new StudioDownloads()),running=useRef(false);
  useEffect(()=>{
    let active=true;const urls=links.current;
    // React development refresh runs cleanup while preserving component state.
    // Clear any hrefs whose object URLs were revoked by that cleanup.
    setDownloads(urls.invalidate());
    void fetchMe().then(async result=>{
      if(!active)return;setUser(result.user);
      // Every visit starts a new task: drop whatever an earlier visit left in this browser
      // (including drafts saved by older versions) instead of restoring it.
      if(result.user)await studioStorage(result.user.id,'delete').catch(()=>undefined);
    }).catch(e=>{if(active){setNotice(e instanceof Error?e.message:'登录状态读取失败');setFailed(true);}}).finally(()=>{if(active)setLoaded(true);});
    return()=>{active=false;urls.invalidate();};
  },[]);
  // Results live only in this page now, so leaving mid-run or before the Word file exists would lose them.
  useEffect(()=>{
    if(!busy&&!(saved&&!downloads.length))return;
    const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};
    window.addEventListener('beforeunload',warn);
    return()=>window.removeEventListener('beforeunload',warn);
  },[busy,saved,downloads]);
  function changed(){setDownloads(links.current.invalidate());setSaved(null);setNotice('');setFailed(false);}
  function files(role:'question'|'answer',selected:FileList|null){
    changed();const list=Array.from(selected||[]);if(role==='question')setQuestionFiles(list);else setAnswerFiles(list);
    if(!title.trim()&&list[0])setTitle(list[0].name.replace(/\.[^.]+$/,''));
  }
  async function start(variant?:StudioOutputMode){
    if(running.current)return;
    running.current=true;setBusy(true);setFailed(false);setDownloads(links.current.invalidate());
    try{
      if(!user)throw new Error('请先登录');
      if(!title.trim())throw new Error('请填写资料名称');
      const resume=!!saved;
      if(!resume&&(!answerFiles.length||(mode==='paired'&&!questionFiles.length)))throw new Error(mode==='paired'?'请上传原件和答案文件':'请上传答案文件');
      const draft=resume?studioSnapshot(saved):{...emptyStudioDraft(),title:title.trim(),inputMode:mode};
      if(variant){const blocker=studioOutputBlocker(draft,variant);if(blocker)throw new Error(blocker);}
      // Progress is kept in memory for "继续转录" after a failure; nothing is stored between visits.
      const checkpoint=async(value:StudioDraft)=>{setSaved(value);};
      if(!resume){
        const input:[File[],'question'|'answer',string][]=mode==='paired'?[[questionFiles,'question',''],[answerFiles,'answer','']]:[[answerFiles,'answer','']];
        for(const [selected,role,range] of input) await readStudioFilesInBatches(selected,role,range,setNotice,async(batch,meta)=>{
          draft.pages=deduplicateStudioPages([...draft.pages,...batch]);
          await checkpoint(draft);
          setNotice(`已读取 ${meta.fileName} 第 ${meta.batchIndex}/${meta.batchCount} 批（${draft.pages.length} 页），继续转录中…`);
        });
      }
      await checkpoint(draft);
      const preparedImage=studioPreparedImages((page:typeof draft.pages[number])=>resizeStudioImage(page.image));
      const result=await transcribeStudio(draft,{
        progress:setNotice,checkpoint,
        crop:(image,box)=>cropStudioImage(image,box,1200),
        recognize:async(page,context,requestOptions)=>(await api<{records:StudioRecord[]}>('/api/answer-studio/recognize',{image:await preparedImage(page),role:page.role,answerOnly:draft.inputMode==='answers',lesson:draft.title,pageId:page.id,context,concurrent:!!requestOptions?.concurrent})).records,
        drawings:(question,bases,evidence,context)=>recognizeStudioDrawings(question,bases,evidence,body=>api<StudioDrawingResult>('/api/answer-studio/drawings',body),undefined,context),
      },{textConcurrency,drawingConcurrency:2,drawings:variant==='full',includeQuestionFigures:variant==='full'&&studioIncludesQuestionFigures(draft)});
      if(!variant){setNotice(`文字转录完成：${result.questions.length} 题。请选择结果版本；无图版本无需等待配图。`);return;}
      setNotice('正在生成 Word…');
      const {buildStudioWord}=await import('../../../lib/answer-studio-export');
      const label=studioOutputs.find(item=>item.value===variant)!.label;
      const blob=await buildStudioWord(result,variant,{transcription:true,includeTranscriptionWarnings});
      setDownloads(links.current.offer(blob,`${result.title}_${label}.docx`,'下载 Word'));
      setNotice('');
    }catch(e){setFailed(true);setNotice(e instanceof Error?e.message:'转录失败');}
    finally{
      running.current=false;setBusy(false);
    }
  }
  if(!loaded)return <main className="answer-studio"><p>正在读取…</p></main>;
  if(!user)return <main className="answer-studio"><h1>手写转录</h1><p>请先登录 MathPilot。</p><a href="/">返回题库</a></main>;
  return <main className="answer-studio answer-studio-simple">
    <header><div><a className="studio-back" href="/tools"><StudioIcon name="back"/><span>返回工具箱</span></a><div className="studio-title"><span className="studio-title-icon"><StudioIcon name="pen"/></span><h1>手写转录</h1></div></div><small>{user.local?'本地管理员':user.email}</small></header>
    <section className="simple-panel">
      <fieldset className="studio-fields" disabled={busy}><legend><span className="section-icon"><StudioIcon name="files"/></span>选择材料类型</legend>
        <div className="mode-choice">
          <label className="mode-card"><input id="studio-mode-paired" aria-label="提供原题和答案" type="radio" name="studio-mode" checked={mode==='paired'} onChange={()=>{changed();setMode('paired');}}/><span className="choice-copy"><strong>提供原题和答案</strong><small>分别上传干净原题与手写答案</small></span></label>
          <label className="mode-card"><input id="studio-mode-answers" aria-label="只有答案材料" type="radio" name="studio-mode" checked={mode==='answers'} onChange={()=>{changed();setMode('answers');}}/><span className="choice-copy"><strong>只有答案材料</strong><small>上传带答案的讲义或答案页，有原题文字也会一并转录</small></span></label>
        </div>
        <label className="field-label"><span className="field-heading"><StudioIcon name="file"/>资料名称</span><input value={title} onChange={e=>{changed();setTitle(e.target.value);}} placeholder="例如：第一讲 三角形的外心"/></label>
        {mode==='paired'&&<UploadZone id="studio-question-files" icon="file" title="上传原题" hint="干净、未作答的原题页" files={questionFiles} onFiles={list=>files('question',list)}/>}
        <UploadZone id="studio-answer-files" icon="pen" title={mode==='paired'?'上传手写答案':'上传答案材料'} hint={mode==='paired'?'写有手写答案的页面':'带答案的讲义或答案页'} files={answerFiles} onFiles={list=>files('answer',list)}/>
<details style={{marginTop:12,fontSize:14}}>
          <summary style={{cursor:'pointer'}}>转录速度：最多 {textConcurrency} 路</summary>
          <label htmlFor="studio-text-concurrency" style={{display:'flex',alignItems:'center',flexWrap:'wrap',gap:8,marginTop:8}}>
            <span>同时识别页数</span>
            <select id="studio-text-concurrency" value={textConcurrency} disabled={busy} style={{width:'auto',minWidth:110,padding:'6px 10px'}} onChange={e=>setTextConcurrency(Number(e.target.value))}>
              {STUDIO_CONCURRENCY_CHOICES.map(value=><option key={value} value={value}>{value} 路{value===1?'（逐页）':value===4?'（推荐）':''}</option>)}
            </select>
          </label>
          <small>默认 4 路，遇限流自动降速；跨页连续解答较多时可选 1 路。完整解题版配图最多 2 路。</small>
        </details>
      </fieldset>
      {(!saved||!studioTextReady(saved))&&<button className="primary simple-start" disabled={busy} onClick={()=>void start()}>{busy?'正在转录…':saved?'继续转录':'开始转录'}</button>}
      {(busy||failed)&&<p className={`studio-notice${failed?' studio-error':''}`} role="status">{notice||(busy?'正在处理…':'操作失败，请重试。')}</p>}
      {saved&&studioTextReady(saved)&&<section className="studio-results" aria-labelledby="studio-results-title">
        <h2 id="studio-results-title">转录结果</h2>
        <div className="result-summary" role="status"><span className="result-summary-icon"><StudioIcon name="check"/></span><span className="result-summary-number">{saved.questions.length}</span><span className="result-summary-label">道题已识别</span></div>
        <fieldset className="studio-fields output-choices" disabled={busy}><legend className="output-legend"><span className="section-icon"><StudioIcon name="download"/></span>选择下载内容</legend>
          {studioOutputs.map(item=><label key={item.value} htmlFor={`studio-output-${item.value}`} aria-label={item.label} className={output===item.value?'output-choice selected':'output-choice'}>
            <input id={`studio-output-${item.value}`} type="radio" name="studio-output" value={item.value} checked={output===item.value} onChange={()=>{setOutput(item.value);setDownloads(links.current.invalidate());setNotice(item.value==='full'?'已选择完整解题版，生成时将处理尚未完成的配图。':'已选择无图版本，将跳过配图处理，直接生成 Word。');setFailed(false);}}/>
            <span className="output-icon"><StudioIcon name={item.value==='full'?'spark':item.value==='text'?'text':'steps'}/></span><span className="output-copy"><strong>{item.label}</strong><small>{item.value==='full'?(studioIncludesQuestionFigures(saved)?'原题、解析、原题图和解答图。':'原题文字、解析和解答图（含必要底图）。'):item.description}</small></span>
          </label>)}
        </fieldset>
        <label htmlFor="studio-include-transcription-warnings" aria-label="在 Word 中加入转录问题提示" style={{display:'flex',alignItems:'flex-start',gap:8,margin:'8px 2px 4px',padding:'2px 0',cursor:'pointer'}}>
          <input id="studio-include-transcription-warnings" type="checkbox" checked={includeTranscriptionWarnings} disabled={busy} style={{flex:'0 0 auto',width:18,height:18,margin:'3px 0 0'}} onChange={e=>{const checked=e.target.checked;setIncludeTranscriptionWarnings(checked);setDownloads(links.current.invalidate());setNotice(checked?'生成的 Word 将保留转录提示和格式问题。':'生成的 Word 将不附加转录提示或格式问题。');setFailed(false);}}/>
          <span style={{display:'block',minWidth:0}}><span style={{display:'block',fontWeight:600,fontSize:14,lineHeight:1.45}}>在 Word 中加入转录问题提示</span><small style={{display:'block',marginTop:2,lineHeight:1.45}}>显示识别疑点和格式问题；关闭后不附加这些红色提示。</small></span>
        </label>
        {studioOutputBlocker(saved,output)&&<p className="studio-notice" role="status">{studioOutputBlocker(saved,output)}</p>}
        {!downloads.some(file=>file.label==='下载 Word')&&<button className="primary simple-start" disabled={busy||!!studioOutputBlocker(saved,output)} onClick={()=>void start(output)}>{busy?'正在生成…':'生成 Word'}</button>}
        {downloads.filter(file=>file.label==='下载 Word').map(file=><a key={file.url} className="studio-download" href={file.url} download={file.name}>下载{studioOutputs.find(item=>item.value===output)!.label}</a>)}
      </section>}
      <small className="studio-privacy">所选材料会发送至已配置的 AI 服务。每次打开都是新任务，结果不会留在浏览器中，刷新或关闭页面后清空，请及时生成并下载 Word；识别有疑问处是否写入 Word 可用上方勾选项设置。</small>
    </section>
  </main>;
}
