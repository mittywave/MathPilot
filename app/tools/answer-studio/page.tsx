"use client";
import { useCallback, useEffect, useRef, useState } from 'react';
import { SiteHeader } from '../../components/SiteHeader';
import { jobPageImage, jobsApi, postJson, RecognitionJobTable, uploadJobPage, useRecognitionJobs } from '../../components/RecognitionJobs';
import { fetchMe, loginPath } from '../../../lib/api-client';
import type { AuthUser } from '../../../lib/types';
import { studioInputMode, type StudioDraft, type StudioInputMode } from '../../../lib/answer-studio';
import {studioDocumentReady,studioDocumentQuestionCount} from '../../../lib/answer-studio-contract';
import type { StudioJob } from '../../../lib/server/answer-studio-jobs';
import { studioSnapshot } from '../../../lib/answer-studio-snapshot';
import { studioStorage } from '../../../lib/answer-studio-storage';
import { cropStudioImage, readStudioFilesInBatches } from '../../../lib/answer-studio-images';
import { recognizeStudioDrawings } from '../../../lib/answer-studio-drawings';
import { transcribeStudio, type StudioDrawingResult } from '../../../lib/answer-studio-pipeline';
import { StudioDownloads, type StudioDownload } from '../../../lib/answer-studio-downloads';
import { studioIncludesQuestionFigures, studioOutputBlocker, studioOutputs, studioTextReady, type StudioOutputMode } from '../../../lib/answer-studio-output';
import { studioApi as api, StudioRequestError, STUDIO_TEXT_CONCURRENCY, STUDIO_CONCURRENCY_CHOICES } from '../../../lib/answer-studio-concurrency';
import './studio.css';

function StudioIcon({name}:{name:'spark'|'download'|'steps'|'text'|'check'}) {
  const paths={
    check:<path d="m5 12 4 4L19 6"/>,
    spark:<><path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5L12 3Z"/><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z"/></>,
    download:<><path d="M12 3v12M7 11l5 5 5-5M4 20h16"/></>,
    steps:<><path d="M6 5h12M6 12h12M6 19h12"/><path d="M3 5h.01M3 12h.01M3 19h.01"/></>,
    text:<><path d="M5 5h14M5 10h14M5 15h9M5 20h7"/></>,
  } as const;
  return <svg className="studio-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}

const STUDIO_ACCEPT='application/pdf,image/png,image/jpeg,image/webp';

// Intake keeps the original files; the existing transcription pipeline reads them when the task starts.
const isStudioFile=(file:File)=>/\.pdf$/i.test(file.name)||/^image\/(png|jpeg|webp)$/.test(file.type);
function UploadZone({id,title,files,onFiles,onActivate}:{id:string;title:string;files:File[];onFiles:(list:FileList|File[],append?:boolean)=>void;onActivate:()=>void}) {
  const names=files.map(file=>file.name);
  return <div className="upload-field">
    <input id={id} type="file" hidden multiple accept={STUDIO_ACCEPT} aria-label={`上传${title}`} onChange={event=>{if(event.target.files?.length){onActivate();onFiles(event.target.files);}event.target.value='';}}/>
    <button id={`${id}-entry`} type="button" className={`drop-entry${files.length?' compact has-files':''}`} aria-labelledby={`${id}-title`} aria-describedby={`${id}-formats`}
      title={files.length?'粘贴或拖入可追加文件，点击可重新选择':undefined}
      onClick={()=>{onActivate();document.getElementById(id)?.click();}}
      onDragEnter={event=>{if(event.dataTransfer.types.includes('Files')&&!event.currentTarget.matches(':disabled')){event.preventDefault();event.currentTarget.classList.add('dragging');}}}
      onDragOver={event=>{if(event.dataTransfer.types.includes('Files')&&!event.currentTarget.matches(':disabled'))event.preventDefault();}}
      onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))event.currentTarget.classList.remove('dragging');}}
      onDrop={event=>{if(!event.dataTransfer.types.includes('Files'))return;event.preventDefault();event.currentTarget.classList.remove('dragging');if(event.currentTarget.matches(':disabled'))return;onActivate();onFiles(event.dataTransfer.files,true);}}>
      <kbd>⌘V</kbd><span><b id={`${id}-title`}>{files.length?`${title} · 已选 ${files.length} 个文件`:`粘贴或拖入${title}`}</b><small id={`${id}-formats`}>{files.length?names.slice(0,3).join('、')+(names.length>3?` 等 ${names.length} 个`:''):'图片或 PDF，可一次放多个'}</small>{!files.length&&<em>也可点击选择文件</em>}</span>
    </button>
  </div>;
}

const modeLabels:Record<StudioInputMode,string>={questions:'只有原题，转成可编辑的题目 Word',answers:'只有答案，转录答案和解析',paired:'原题和答案，配对生成题目解析'};

export default function AnswerStudioPage() {
  const [user,setUser]=useState<AuthUser|null>(null),[loaded,setLoaded]=useState(false);
  const [title,setTitle]=useState('');
  const [questionFiles,setQuestionFiles]=useState<File[]>([]),[answerFiles,setAnswerFiles]=useState<File[]>([]);
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[failed,setFailed]=useState(false);
  const [saved,setSaved]=useState<StudioDraft|null>(null),[downloads,setDownloads]=useState<StudioDownload[]>([]);
  const [output,setOutput]=useState<StudioOutputMode>('full');
  const [includeTranscriptionWarnings,setIncludeTranscriptionWarnings]=useState(true);
  const [textConcurrency,setTextConcurrency]=useState(STUDIO_TEXT_CONCURRENCY);
  const [openJobId,setOpenJobId]=useState('');
  const links=useRef(new StudioDownloads()),running=useRef(false);
  const lastEntry=useRef<'question'|'answer'|null>(null);
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
  // Text transcription runs on the server; the list polls only while a job is still moving.
  const report=useCallback((message:string)=>{setFailed(Boolean(message));setNotice(message);},[]);
  const transcriptions=useRecognitionJobs('transcription',Boolean(user),report,job=>{if(openJobId===job.id){setSaved(null);setOpenJobId('');setDownloads(links.current.invalidate());}});
  // Uploading pages and drawing figures for Word still happen in this page.
  useEffect(()=>{
    if(!busy)return;
    const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};
    window.addEventListener('beforeunload',warn);
    return()=>window.removeEventListener('beforeunload',warn);
  },[busy]);
  const changed=useCallback(()=>{setDownloads(links.current.invalidate());setSaved(null);setOpenJobId('');setNotice('');setFailed(false);},[]);
  const files=useCallback((role:'question'|'answer',selected:FileList|File[]|null,append=false)=>{
    if(busy||running.current)return;
    const incoming=Array.from(selected||[]),list=incoming.filter(isStudioFile);
    if(!list.length){if(incoming.length){setNotice('仅支持 PDF、PNG、JPEG、WebP 文件');setFailed(true);}return;}
    changed();if(role==='question')setQuestionFiles(current=>append?[...current,...list]:list);else setAnswerFiles(current=>append?[...current,...list]:list);
    if(!title.trim())setTitle(list[0].name.replace(/\.[^.]+$/,''));
    if(list.length<incoming.length){setNotice(`已忽略 ${incoming.length-list.length} 个不支持的文件`);setFailed(true);}
  },[busy,changed,title]);
  useEffect(()=>{
    if(busy)return;
    const paste=(event:ClipboardEvent)=>{
      if(running.current)return;
      const incoming=Array.from(event.clipboardData?.files||[]).filter(isStudioFile);if(!incoming.length)return;
      const roles:Array<'question'|'answer'>=['question','answer'];
      const visible=roles.flatMap(role=>{const entry=document.getElementById(`studio-${role}-files-entry`);if(!entry||entry.closest('details:not([open])')||!entry.getClientRects().length)return [];const box=entry.getBoundingClientRect();if(box.bottom<=0||box.top>=innerHeight||box.right<=0||box.left>=innerWidth)return [];const hit=document.elementFromPoint((Math.max(0,box.left)+Math.min(innerWidth,box.right))/2,(Math.max(0,box.top)+Math.min(innerHeight,box.bottom))/2);return hit&&entry.contains(hit)?[{role,entry}]:[];});
      const target=visible.find(item=>item.role===lastEntry.current)||visible.find(item=>!(item.role==='question'?questionFiles:answerFiles).length)||visible.find(item=>item.role==='answer')||visible[0];
      if(!target)return;event.preventDefault();files(target.role,incoming,true);target.entry.focus({preventScroll:true});
      if(!matchMedia('(prefers-reduced-motion:reduce)').matches)target.entry.animate([{boxShadow:'0 0 0 3px var(--green)'},{boxShadow:'0 0 0 0 transparent'}],{duration:700});
    };
    document.addEventListener('paste',paste);return()=>document.removeEventListener('paste',paste);
  },[answerFiles,busy,files,questionFiles]);
  // Pages are rendered here, uploaded in source order, then transcribed by the server even after this page closes.
  async function submit(){
    if(running.current)return;
    running.current=true;setBusy(true);setFailed(false);setDownloads(links.current.invalidate());
    let unfinished='';
    try{
      if(!user)throw new Error('请先登录');
      if(!title.trim())throw new Error('请填写资料名称');
      if(!questionFiles.length&&!answerFiles.length)throw new Error('请上传原题或答案文件');
      const {job}=await jobsApi<{job:StudioJob}>('/api/answer-studio/jobs',postJson({title:title.trim(),textConcurrency}));
      unfinished=job.id;transcriptions.setJobs(current=>[job,...current]);
      // The server reads the mode from these roles when the job starts.
      const input=([[questionFiles,'question'],[answerFiles,'answer']] as [File[],'question'|'answer'][]).filter(([selected])=>selected.length);
      let uploaded=0;
      for(const [selected,role] of input) await readStudioFilesInBatches(selected,role,'',setNotice,async batch=>{
        for(const page of batch){
          setNotice(`正在上传第 ${uploaded+1} 页（${page.name}）…上传完成前请勿离开本页`);
          await uploadJobPage(job.id,page);
          uploaded++;
        }
      },undefined,true);
      await jobsApi(`/api/answer-studio/jobs/${job.id}`,{method:'POST'});
      unfinished='';setQuestionFiles([]);setAnswerFiles([]);setTitle('');
    }catch(e){
      setFailed(true);setNotice(e instanceof Error?e.message:'上传失败');
      // Without the files a half-uploaded job can never start, so do not leave it in the list.
      if(unfinished)await jobsApi(`/api/answer-studio/jobs/${unfinished}`,{method:'DELETE'}).catch(()=>undefined);
    }
    finally{running.current=false;setBusy(false);void transcriptions.refresh();}
  }
  async function openJob(job:StudioJob){
    if(running.current)return;
    running.current=true;setBusy(true);setFailed(false);setDownloads(links.current.invalidate());
    try{
      const {job:checked}=await jobsApi<{job:StudioJob}>(`/api/answer-studio/jobs/${job.id}`,{method:'POST'});
      if(checked.status!=='done'){
        setSaved(null);setOpenJobId('');setFailed(true);setNotice('需要更新的页面已加入后台重识别，其余完成页保留。完成后请再次打开。');
        void transcriptions.refresh();return;
      }
      const {draft}=await jobsApi<{draft:StudioDraft}>(`/api/answer-studio/jobs/${job.id}`);
      // Figures are cut from the original pages, so Word generation needs them back in the browser.
      for(const [index,page] of draft.pages.entries()){
        setNotice(`正在读取原件 ${index+1}/${draft.pages.length}…`);
        page.image=await jobPageImage(job.id,page.id,`第 ${page.page} 页`);
      }
      setQuestionFiles([]);setAnswerFiles([]);setTitle(draft.title);setOutput('full');
      setSaved(draft);setOpenJobId(job.id);setNotice('');
    }catch(e){setFailed(true);setNotice(e instanceof Error?e.message:'打开失败');}
    finally{running.current=false;setBusy(false);}
  }
  // Figures and Word are built here from the finished server draft.
  async function generate(variant:StudioOutputMode){
    if(running.current||!saved)return;
    running.current=true;setBusy(true);setFailed(false);setDownloads(links.current.invalidate());
    try{
      const draft=studioSnapshot(saved);
      const blocker=studioOutputBlocker(draft,variant);if(blocker)throw new Error(blocker);
      const result=await transcribeStudio(draft,{
        progress:setNotice,checkpoint:async value=>{setSaved(value);},
        crop:(image,box)=>cropStudioImage(image,box,1200),
        recognize:async()=>{throw new StudioRequestError('文字转录已在后台完成，不应再次识别',0,0,false);},
        drawings:(question,bases,evidence,context)=>recognizeStudioDrawings(question,bases,evidence,body=>api<StudioDrawingResult>('/api/answer-studio/drawings',body),undefined,context),
      },{drawingConcurrency:2,drawings:variant==='full',includeQuestionFigures:variant==='full'&&studioIncludesQuestionFigures(draft)});
      setNotice('正在生成 Word…');
      const {buildStudioWord}=await import('../../../lib/answer-studio-export');
      const label=studioOutputs(result).find(item=>item.value===variant)!.label;
      const blob=await buildStudioWord(result,variant,{transcription:true,includeTranscriptionWarnings});
      setDownloads(links.current.offer(blob,`${result.title}_${label}.docx`,'下载 Word'));
      setNotice('');
    }catch(e){setFailed(true);setNotice(e instanceof Error?e.message:'生成失败');}
    finally{running.current=false;setBusy(false);}
  }
  const inputMode=studioInputMode([...(questionFiles.length?['question' as const]:[]),...(answerFiles.length?['answer' as const]:[])]);
  const missing=[!title.trim()&&{label:'资料名称',target:'.studio-controls .field-label input'},!saved&&!inputMode&&{label:'原题或答案',target:'#studio-question-files-entry'}].filter(field=>field!==false);
  return <><SiteHeader active="tools" user={user} loading={!loaded} trail={[{label:'工具箱',href:'/tools'},{label:'文件转录'}]} onSignOut={async exit=>{if(busy){setNotice('请等上传或生成 Word 完成后再退出登录。');setFailed(true);return;}await exit();}} />
    {transcriptions.confirmNode}
    {!loaded?<main className="homework-loading">正在读取…</main>:!user?<main className="homework-loading"><p>{failed ? notice : "请先登录 MathPilot。"}</p><a href={loginPath("/tools/answer-studio")}>去登录</a></main>:<main className="answer-studio">
    <fieldset className="studio-fields studio-workspace" disabled={busy}>
      <aside className="studio-controls">
        <label className="field-label"><span className="field-heading">资料名称</span><input value={title} onChange={e=>{changed();setTitle(e.target.value);}} placeholder="例如：第一讲 三角形的外心"/></label>
        <details style={{marginTop:12,fontSize:14}}>
          <summary style={{cursor:'pointer'}}>高级</summary>
          <label htmlFor="studio-text-concurrency" style={{display:'flex',alignItems:'center',flexWrap:'wrap',gap:8,marginTop:8}}>
            <span>同时处理的页数</span>
            <select id="studio-text-concurrency" value={textConcurrency} disabled={busy} style={{width:'auto',minWidth:110,padding:'6px 10px'}} onChange={e=>setTextConcurrency(Number(e.target.value))}>
              {STUDIO_CONCURRENCY_CHOICES.map(value=><option key={value} value={value}>{value} 页{value===1?'（逐页）':value===4?'（推荐）':''}</option>)}
            </select>
          </label>
          <small>默认同时处理 4 页。页数越多通常越快，也更容易触发服务限流；遇限流会自动降速，跨页连续解答较多时可选 1 页。</small>
        </details>

        {!saved&&inputMode&&<p className="studio-mode-line" id="studio-mode-line">转录方式：{modeLabels[inputMode]}</p>}
        {!saved&&<button className="primary simple-start" aria-describedby={!busy&&missing.length?'studio-missing':undefined} disabled={busy||missing.length>0} onClick={()=>void submit()}>{busy?'正在上传…':'开始转录'}</button>}
        {!busy&&missing.length>0&&<p className="missing-reason" id="studio-missing">还差：{missing.map((field,index)=><span key={field.label}>{index>0?'、':''}<button type="button" className="text-button" onClick={()=>{const control=document.querySelector<HTMLElement>(field.target);control?.focus({preventScroll:true});control?.scrollIntoView({block:'nearest'});}}>{field.label}</button></span>)}</p>}
        {(busy||failed)&&<p className={`studio-notice${failed?' studio-error':''}`} role={failed?'alert':'status'}>{notice||(busy?'正在处理…':'操作失败，请重试。')}</p>}
      </aside>
      <section className="simple-panel">
        <div className="studio-uploads">
          <UploadZone id="studio-question-files" title="原题" files={questionFiles} onActivate={()=>{if(!busy&&!running.current)lastEntry.current='question';}} onFiles={(list,append)=>files('question',list,append)}/>
          <UploadZone id="studio-answer-files" title="答案" files={answerFiles} onActivate={()=>{if(!busy&&!running.current)lastEntry.current='answer';}} onFiles={(list,append)=>files('answer',list,append)}/>
        </div>
      {saved&&studioTextReady(saved)&&<section className="studio-results" aria-labelledby="studio-results-title">
        <h2 id="studio-results-title">转录结果</h2>
        <div className="result-summary" role="status"><span className="result-summary-icon"><StudioIcon name="check"/></span><span className="result-summary-number">{studioDocumentReady(saved)?studioDocumentQuestionCount(saved):saved.questions.length}</span><span className="result-summary-label">道题已识别</span></div>
        <fieldset className="studio-fields output-choices" disabled={busy}><legend className="output-legend"><span className="section-icon"><StudioIcon name="download"/></span>选择下载内容</legend>
          {studioOutputs(saved).map(item=><label key={item.value} htmlFor={`studio-output-${item.value}`} aria-label={item.label} className={output===item.value?'output-choice selected':'output-choice'}>
            <input id={`studio-output-${item.value}`} type="radio" name="studio-output" value={item.value} checked={output===item.value} onChange={()=>{setOutput(item.value);setDownloads(links.current.invalidate());setNotice(item.value==='full'?'已选择完整解题版，生成时将处理尚未完成的配图。':'已选择无图版本，将跳过配图处理，直接生成 Word。');setFailed(false);}}/>
            <span className="output-icon"><StudioIcon name={item.value==='full'?'spark':item.value==='text'?'text':'steps'}/></span><span className="output-copy"><strong>{item.label}</strong><small>{item.description}</small></span>
          </label>)}
        </fieldset>
        <label htmlFor="studio-include-transcription-warnings" aria-label="在 Word 中加入转录问题提示" style={{display:'flex',alignItems:'flex-start',gap:8,margin:'8px 2px 4px',padding:'2px 0',cursor:'pointer'}}>
          <input id="studio-include-transcription-warnings" type="checkbox" checked={includeTranscriptionWarnings} disabled={busy} style={{flex:'0 0 auto',width:18,height:18,margin:'3px 0 0'}} onChange={e=>{const checked=e.target.checked;setIncludeTranscriptionWarnings(checked);setDownloads(links.current.invalidate());setNotice(checked?'生成的 Word 将保留转录提示和格式问题。':'生成的 Word 将不附加转录提示或格式问题。');setFailed(false);}}/>
          <span style={{display:'block',minWidth:0}}><span style={{display:'block',fontWeight:600,fontSize:14,lineHeight:1.45}}>在 Word 中加入转录问题提示</span><small style={{display:'block',marginTop:2,lineHeight:1.45}}>显示识别疑点和格式问题；关闭后不附加这些红色提示。</small></span>
        </label>
        {studioOutputBlocker(saved,output)&&<p id="studio-output-missing" className="studio-notice" role="status">{studioOutputBlocker(saved,output)}</p>}
        {!downloads.some(file=>file.label==='下载 Word')&&<button className="primary simple-start" aria-describedby={studioOutputBlocker(saved,output)?'studio-output-missing':undefined} disabled={busy||!!studioOutputBlocker(saved,output)} onClick={()=>void generate(output)}>{busy?'正在生成…':'生成 Word'}</button>}
        {downloads.filter(file=>file.label==='下载 Word').map(file=><a key={file.url} className="studio-download" href={file.url} download={file.name}>下载{studioOutputs(saved).find(item=>item.value===output)!.label}</a>)}
      </section>}
      <RecognitionJobTable kind="transcription" jobs={transcriptions.jobs} openJobId={openJobId} busy={busy} cancellingJobId={transcriptions.cancellingJobId} canOpen={job=>job.status==='done'}
        onOpen={job=>void openJob(job)} onResume={job=>void transcriptions.resume(job)} onCancel={job=>void transcriptions.cancel(job)} onRemove={job=>void transcriptions.remove(job)}/>
      <small className="studio-privacy">所选材料会发送至已配置的 AI 服务，并保存在服务器上直到删除任务。上传完成后可以离开本页，文字转录在后台继续；配图和 Word 在本页生成，生成期间请勿离开。识别有疑问处是否写入 Word 可用上方勾选项设置。</small>

      </section>
    </fieldset>
  </main>}</>;
}
