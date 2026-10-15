"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- client-only vinext navigation */
import { useCallback, useEffect, useRef, useState } from 'react';
import { SiteHeader } from '../../components/SiteHeader';
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
function UploadZone({id,title,files,onFiles,onActivate,compact=false}:{id:string;title:string;files:File[];onFiles:(list:FileList|File[],append?:boolean)=>void;onActivate:()=>void;compact?:boolean}) {
  const names=files.map(file=>file.name);
  return <div className="upload-field">
    <input id={id} type="file" hidden multiple accept={STUDIO_ACCEPT} aria-label={`上传${title}`} onChange={event=>{if(event.target.files?.length){onActivate();onFiles(event.target.files);}event.target.value='';}}/>
    <button id={`${id}-entry`} type="button" className={`drop-entry${compact||files.length?' compact':''}${files.length?' has-files':''}`} aria-labelledby={`${id}-title`} aria-describedby={`${id}-formats`}
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
  // Results live only in this page now, so leaving mid-run or before the Word file exists would lose them.
  useEffect(()=>{
    if(!busy&&!(saved&&!downloads.length))return;
    const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};
    window.addEventListener('beforeunload',warn);
    return()=>window.removeEventListener('beforeunload',warn);
  },[busy,saved,downloads]);
  const changed=useCallback(()=>{setDownloads(links.current.invalidate());setSaved(null);setNotice('');setFailed(false);},[]);
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
      const roles:Array<'question'|'answer'>=mode==='paired'?['question','answer']:['answer'];
      const visible=roles.flatMap(role=>{const entry=document.getElementById(`studio-${role}-files-entry`);if(!entry||entry.closest('details:not([open])')||!entry.getClientRects().length)return [];const box=entry.getBoundingClientRect();if(box.bottom<=0||box.top>=innerHeight||box.right<=0||box.left>=innerWidth)return [];const hit=document.elementFromPoint((Math.max(0,box.left)+Math.min(innerWidth,box.right))/2,(Math.max(0,box.top)+Math.min(innerHeight,box.bottom))/2);return hit&&entry.contains(hit)?[{role,entry}]:[];});
      const target=visible.find(item=>item.role===lastEntry.current)||visible.find(item=>!(item.role==='question'?questionFiles:answerFiles).length)||visible.find(item=>item.role==='answer')||visible[0];
      if(!target)return;event.preventDefault();files(target.role,incoming,true);target.entry.focus({preventScroll:true});
      if(!matchMedia('(prefers-reduced-motion:reduce)').matches)target.entry.animate([{boxShadow:'0 0 0 3px var(--green)'},{boxShadow:'0 0 0 0 transparent'}],{duration:700});
    };
    document.addEventListener('paste',paste);return()=>document.removeEventListener('paste',paste);
  },[answerFiles,busy,files,mode,questionFiles]);
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
  const missing=[!title.trim()&&{label:'资料名称',target:'.studio-controls .field-label input'},!saved&&mode==='paired'&&!questionFiles.length&&{label:'原题',target:'#studio-question-files-entry'},!saved&&!answerFiles.length&&{label:mode==='paired'?'手写答案':'答案材料',target:'#studio-answer-files-entry'}].filter(field=>field!==false);
  return <><SiteHeader active="tools" user={user} loading={!loaded} trail={[{label:'工具箱',href:'/tools'},{label:'手写转录'}]} onSignOut={async exit=>{if(busy||(saved&&!downloads.length)){setNotice('请完成转录并生成 Word 后再退出登录。');setFailed(true);return;}await exit();}} />
    {!loaded?<main className="homework-loading">正在读取…</main>:!user?<main className="homework-loading"><p>{failed ? notice : "请先登录 MathPilot。"}</p><a href="/">返回题库登录</a></main>:<main className="answer-studio">
    <fieldset className="studio-fields studio-workspace" disabled={busy}>
      <aside className="studio-controls">
        <div className="mode-choice" role="radiogroup" aria-label="材料类型">
          <label><input id="studio-mode-paired" aria-label="提供原题和答案" type="radio" name="studio-mode" checked={mode==='paired'} onChange={()=>{changed();setMode('paired');}}/><b>原题和答案</b></label>
          <label><input id="studio-mode-answers" aria-label="只有答案材料" type="radio" name="studio-mode" checked={mode==='answers'} onChange={()=>{changed();setMode('answers');}}/><b>只有答案</b></label>
        </div>
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

        {mode==='paired'&&<UploadZone id="studio-question-files" title="原题" compact files={questionFiles} onActivate={()=>{if(!busy&&!running.current)lastEntry.current='question';}} onFiles={(list,append)=>files('question',list,append)}/>}

        {(!saved||!studioTextReady(saved))&&<button className="primary simple-start" aria-describedby={!busy&&missing.length?'studio-missing':undefined} disabled={busy||missing.length>0} onClick={()=>void start()}>{busy?'正在转录…':saved?'继续转录':'开始转录'}</button>}
        {!busy&&missing.length>0&&<p className="missing-reason" id="studio-missing">还差：{missing.map((field,index)=><span key={field.label}>{index>0?'、':''}<button type="button" className="text-button" onClick={()=>{const control=document.querySelector<HTMLElement>(field.target);control?.focus({preventScroll:true});control?.scrollIntoView({block:'nearest'});}}>{field.label}</button></span>)}</p>}
        {(busy||failed)&&<p className={`studio-notice${failed?' studio-error':''}`} role={failed?'alert':'status'}>{notice||(busy?'正在处理…':'操作失败，请重试。')}</p>}
      </aside>
      <section className="simple-panel">
        <UploadZone id="studio-answer-files" title={mode==='paired'?'手写答案':'答案材料'} files={answerFiles} onActivate={()=>{if(!busy&&!running.current)lastEntry.current='answer';}} onFiles={(list,append)=>files('answer',list,append)}/>
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
        {studioOutputBlocker(saved,output)&&<p id="studio-output-missing" className="studio-notice" role="status">{studioOutputBlocker(saved,output)}</p>}
        {!downloads.some(file=>file.label==='下载 Word')&&<button className="primary simple-start" aria-describedby={studioOutputBlocker(saved,output)?'studio-output-missing':undefined} disabled={busy||!!studioOutputBlocker(saved,output)} onClick={()=>void start(output)}>{busy?'正在生成…':'生成 Word'}</button>}
        {downloads.filter(file=>file.label==='下载 Word').map(file=><a key={file.url} className="studio-download" href={file.url} download={file.name}>下载{studioOutputs.find(item=>item.value===output)!.label}</a>)}
      </section>}
      <small className="studio-privacy">所选材料会发送至已配置的 AI 服务。每次打开都是新任务，结果不会留在浏览器中，刷新或关闭页面后清空，请及时生成并下载 Word；识别有疑问处是否写入 Word 可用上方勾选项设置。</small>

      </section>
    </fieldset>
  </main>}</>;
}
