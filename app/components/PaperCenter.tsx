"use client";
import { createPortal } from "react-dom";
import { Fragment, useEffect, useRef, useState } from "react";
import { FolderIcon } from "./CategoryTree";
import type { AuthUser, ExamPaper, LibraryModule, PaperDetail, PaperFolder, PaperMetadata } from "../../lib/types";
import { emptyPaperMetadata, inferPaperFolder, paperDraftIssues, paperFolderDescendants, paperFolderPath, type PaperDraft } from "../../lib/papers";
import { jobsApi, postJson, uploadJobPage } from "./RecognitionJobs";
import { PaperMoreMenu } from "./PaperMoreMenu";
import { useConfirm } from "./ConfirmDialog";
import { QuestionBody } from "./QuestionBody";

type Notice=(message:string,tone?:"success"|"error")=>void;
const patch=(body:unknown)=>({...postJson(body),method:"PATCH"});
const errorText=(error:unknown)=>error instanceof Error?error.message:"操作失败，请重试";
// All three paper dialogs share keyboard focus and Escape handling, including the flipped sidebar's portal.
function usePaperDialog(open:boolean,onClose:()=>void,busy=false) {
  const ref=useRef<HTMLElement>(null),close=useRef(onClose),pending=useRef(busy);
  useEffect(()=>{close.current=onClose;pending.current=busy;},[onClose,busy]);
  useEffect(()=>{
    if(!open)return;
    const origin=document.activeElement instanceof HTMLElement?document.activeElement:null,previousOverflow=document.body.style.overflow;
    document.body.style.overflow="hidden";
    const frame=requestAnimationFrame(()=>{(ref.current?.querySelector<HTMLElement>("input:not(:disabled),select:not(:disabled),textarea:not(:disabled),button:not(:disabled)")??ref.current)?.focus();});
    const keydown=(event:KeyboardEvent)=>{
      if(!ref.current||event.isComposing)return;
      if(event.key==="Escape"&&!pending.current){event.preventDefault();event.stopImmediatePropagation();close.current();}
      if(event.key!=="Tab")return;
      const controls=[...ref.current.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]')].filter(el=>el.getClientRects().length>0);
      if(!controls.length){event.preventDefault();return;}
      const first=controls[0],last=controls.at(-1)!;
      if(event.shiftKey&&(document.activeElement===first||!ref.current.contains(document.activeElement))){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&(document.activeElement===last||!ref.current.contains(document.activeElement))){event.preventDefault();first.focus();}
    };
    document.addEventListener("keydown",keydown,true);
    return()=>{cancelAnimationFrame(frame);document.removeEventListener("keydown",keydown,true);document.body.style.overflow=previousOverflow;if(origin?.isConnected)origin.focus();};
  },[open]);
  return ref;
}

export function PaperDirectory({folders,selected,onSelect,onChanged,user,onNotice}:{folders:PaperFolder[];selected:string;onSelect:(id:string)=>void;onChanged:()=>void;user:AuthUser|null;onNotice:Notice}) {
  const [closed,setClosed]=useState<string[]>([]),[editor,setEditor]=useState<{id?:string;name:string;parentId:string}|null>(null),[busy,setBusy]=useState(false);
  const [confirmNode,confirm]=useConfirm();
  const dialogRef=usePaperDialog(Boolean(editor),()=>setEditor(null),busy);
  async function change(raw:Record<string,unknown>){setBusy(true);try{await jobsApi("/api/paper-folders",postJson(raw));setEditor(null);onChanged();}catch(error){onNotice(errorText(error),"error");}finally{setBusy(false);}}
  async function remove(folder:PaperFolder){if(!await confirm({title:`删除文件夹「${folder.name}」`,body:"只能删除空文件夹，试卷和题库题目不会被删除。",confirmLabel:"删除文件夹",danger:true}))return;try{await jobsApi("/api/paper-folders",{...postJson({id:folder.id}),method:"DELETE"});if(selected===folder.id)onSelect(folder.parentId??"");onChanged();}catch(error){onNotice(errorText(error),"error");}}
  function tree(parent:string|null,depth=0):React.ReactNode{return folders.filter(f=>f.parentId===parent).map(folder=>{
    const children=folders.some(f=>f.parentId===folder.id),open=!closed.includes(folder.id);
    const toggle=()=>setClosed(list=>open?[...list,folder.id]:list.filter(id=>id!==folder.id));
    return <Fragment key={folder.id}><div className={`paper-folder-row${selected===folder.id?" active":""}`} style={{paddingLeft:depth*15}}>
      {children?<button className="paper-folder-chevron" title={open?"收起子文件夹":"展开子文件夹"} aria-label={`${open?"收起":"展开"}${folder.name}`} aria-expanded={open} onClick={toggle}><span aria-hidden="true">›</span></button>:<span className="paper-folder-icon" aria-hidden="true"><FolderIcon /></span>}
      <button className="paper-folder-name" onClick={()=>children&&selected===folder.id?toggle():onSelect(folder.id)} title={folder.name}>{folder.name}<small>{folder.count}</small></button>
      {user&&<PaperMoreMenu portal label={`${folder.name}文件夹操作`}><button onClick={()=>setEditor({name:"",parentId:folder.id})}>新建子文件夹</button><button onClick={()=>setEditor({id:folder.id,name:folder.name,parentId:folder.parentId??""})}>重命名 / 移动</button><button onClick={()=>void change({id:folder.id,direction:"up"})}>上移</button><button onClick={()=>void change({id:folder.id,direction:"down"})}>下移</button>{user.role==="admin"&&<button className="danger-text" onClick={()=>void remove(folder)}>删除空文件夹</button>}</PaperMoreMenu>}
    </div>{children&&<div className="tree-children" data-open={open} inert={!open} aria-hidden={!open}><div className="tree-children-content">{tree(folder.id,depth+1)}</div></div>}</Fragment>;
  });}
  return <><div className="tree paper-folder-tree" aria-label="试卷文件夹"><button className={`tree-row${!selected?" active":""}`} onClick={()=>onSelect("")}>全部试卷<span className="count">{folders.filter(f=>!f.parentId).reduce((n,f)=>n+f.count,0)}</span></button>{tree(null)}</div>
    {user&&<button className="manage-button" onClick={()=>setEditor({name:"",parentId:selected})}>＋ 新建文件夹</button>}
    {editor&&createPortal(<div className="modal-backdrop"><section ref={dialogRef} tabIndex={-1} className="modal paper-folder-dialog" role="dialog" aria-modal="true" aria-label="编辑试卷文件夹"><div className="modal-head"><h2>{editor.id?"编辑文件夹":"新建文件夹"}</h2><button className="close" aria-label="关闭" disabled={busy} onClick={()=>setEditor(null)}>×</button></div>
      <label className="field">文件夹名称<input value={editor.name} maxLength={100} onChange={e=>setEditor({...editor,name:e.target.value})}/></label>
      <label className="field">上级文件夹<select value={editor.parentId} onChange={e=>setEditor({...editor,parentId:e.target.value})}><option value="">顶层</option>{folders.filter(f=>!editor.id||!paperFolderDescendants(folders,editor.id).has(f.id)).map(f=><option key={f.id} value={f.id}>{paperFolderPath(folders,f.id)}</option>)}</select></label>
      <div className="modal-actions"><button className="secondary" disabled={busy} onClick={()=>setEditor(null)}>取消</button><button className="primary-button" disabled={busy||!editor.name.trim()} onClick={()=>void change(editor)}>{busy?"保存中…":"保存"}</button></div>
    </section></div>,document.body)}{confirmNode&&createPortal(confirmNode,document.body)}</>;
}

export function PaperCenter({folderId,folders,refresh,user,modules,onOpen,onAdd,addLabel="加入组卷篮",onNotice,onFolders,onLibraryChanged}:{folderId:string;folders:PaperFolder[];refresh:number;user:AuthUser|null;modules:LibraryModule[];onOpen:(id:string)=>void;onAdd?:(paper:PaperDetail)=>void|Promise<void>;addLabel?:string;onNotice:Notice;onFolders:(folders:PaperFolder[])=>void;onLibraryChanged:()=>void}) {
  const [query,setQuery]=useState(""),[filters,setFilters]=useState({year:"",grade:"",examType:""}),[pagination,setPagination]=useState({key:"",offset:0}),[total,setTotal]=useState(0),[papers,setPapers]=useState<ExamPaper[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState("");
  const [facets,setFacets]=useState<Record<string,string[]>>({}),[editing,setEditing]=useState<ExamPaper|null>(null),[version,setVersion]=useState(0),[confirmNode,confirm]=useConfirm();
  const prior=useRef(new Map<string,string>()),latestReady=useRef(onLibraryChanged);latestReady.current=onLibraryChanged;
  const moving=papers.some(p=>["queued","running"].includes(p.status)&&!p.stalled);
  const filterKey=JSON.stringify([folderId,query,filters]),offset=pagination.key===filterKey?pagination.offset:0;
  const setOffset=(update:(n:number)=>number)=>setPagination({key:filterKey,offset:update(offset)});
  useEffect(()=>{
    const controller=new AbortController();
    const fetchList=async()=>{try{const params=new URLSearchParams({folder:folderId,q:query,...filters,offset:String(offset)}), result=await jobsApi<{papers:ExamPaper[];total:number;folders:PaperFolder[];facets:Record<string,string[]>}>(`/api/papers?${params}`,{signal:controller.signal});
      if(result.papers.some(p=>p.status==="done"&&prior.current.has(p.id)&&prior.current.get(p.id)!=="done"))latestReady.current();
      for(const p of result.papers)prior.current.set(p.id,p.status);setPapers(result.papers);setTotal(result.total);setFacets(result.facets);onFolders(result.folders);setError("");
    }catch(e){if(!controller.signal.aborted)setError(errorText(e));}finally{if(!controller.signal.aborted)setLoading(false);}};
    const timeout=setTimeout(()=>void fetchList(),180),timer=moving?setInterval(()=>void fetchList(),3000):undefined;
    return()=>{controller.abort();clearTimeout(timeout);clearInterval(timer);};
  },[folderId,query,filters,offset,refresh,version,moving,onFolders]);
  async function action(paper:ExamPaper,action:"start"|"cancel"){try{await jobsApi(`/api/papers/${paper.id}`,patch({action}));setVersion(v=>v+1);}catch(e){onNotice(errorText(e),"error");}}
  async function remove(paper:ExamPaper){if(!await confirm({title:`删除试卷「${paper.title}」`,body:"删除试卷及上传原件，已经入库的题目和永久 ID 会保留。",confirmLabel:"删除试卷",danger:true}))return;try{await jobsApi(`/api/papers/${paper.id}`,{method:"DELETE"});setVersion(v=>v+1);onNotice("试卷已删除，题库题目仍保留");}catch(e){onNotice(errorText(e),"error");}}
  async function add(paper:ExamPaper){try{const result=await jobsApi<{paper:PaperDetail}>(`/api/papers/${paper.id}`);await onAdd?.(result.paper);}catch(e){onNotice(errorText(e),"error");}}
  return <div className="paper-center"><div className="filters paper-filters"><label className="search"><span>⌕</span><input aria-label="搜索试卷" placeholder="搜索试卷标题…" value={query} onChange={e=>setQuery(e.target.value)}/></label>
    {([ ["year","年份 / 学年"],["grade","年级"],["examType","考试类型"] ] as const).map(([key,label])=><select key={key} aria-label={label} value={filters[key]} onChange={e=>setFilters({...filters,[key]:e.target.value})}><option value="">全部{label}</option>{facets[key]?.map(v=><option key={v}>{v}</option>)}</select>)}
  </div><div className="library-position">{folderId?paperFolderPath(folders,folderId):"全部试卷"} · {total} 套</div>
  {error&&<p role="alert" className="paper-error">{error}<button onClick={()=>setVersion(v=>v+1)}>重试</button></p>}
  {loading?<div className="wrong-book-loading">正在读取试卷…</div>:!papers.length?<div className="empty-state"><div>卷</div><h3>{query||Object.values(filters).some(Boolean)?"没有符合条件的试卷":"这里还没有试卷"}</h3><p>{user?"可在题库的试卷中心录入 Word 或 PDF。":"试卷收录后会显示在这里。"}</p></div>:<div className="paper-list">{papers.map(paper=><article className="paper-row" key={paper.id}>
    <div className="paper-row-main"><h2><button disabled={paper.status!=="done"} onClick={()=>onOpen(paper.id)}>{paper.title}</button></h2><div className="paper-row-meta">{[paper.metadata.year,paper.metadata.school||paper.metadata.district,`${paper.metadata.grade}${paper.metadata.term?`（${paper.metadata.term}）`:""}`,paper.metadata.examType,paper.status==="done"?`${paper.questionCount} 题`:""].filter(Boolean).map((label,i)=><span key={`${i}-${label}`}>{label}</span>)}<span>{new Date(paper.createdAt).toLocaleDateString("zh-CN")} 录入</span></div>
      {paper.status!=="done"&&<p className={`paper-job-state ${paper.error||paper.stalled?"error":""}`} role="status">{paper.stalled?"处理已中断，可从断点继续":paper.error||paper.progress||({uploading:"上传尚未完成，请重新选择原文件继续",queued:"等待识别…",running:"正在识别与归类…",failed:"录入未完成"} as Record<string,string>)[paper.status]}</p>}
    </div><div className="paper-row-actions">
      {paper.status==="done"?<><button onClick={()=>onOpen(paper.id)}>查看</button>{user&&onAdd&&<button onClick={()=>void add(paper)}>{addLabel}</button>}</>:user&&<>{(paper.status==="failed"||paper.stalled)&&<><button onClick={()=>void action(paper,"start")}>继续</button><button onClick={()=>setEditing(paper)}>修正</button></>}{["queued","running"].includes(paper.status)&&!paper.stalled&&<button onClick={()=>void action(paper,"cancel")}>取消</button>}</>}
      {user&&<><a href={`/api/papers/${paper.id}?source=1`}>下载原件</a><PaperMoreMenu portal label={`${paper.title}操作`}>{paper.status==="done"&&<button onClick={()=>setEditing(paper)}>编辑信息 / 移动</button>}{user.role==="admin"&&<button className="danger-text" onClick={()=>void remove(paper)}>删除试卷</button>}</PaperMoreMenu></>}
    </div></article>)}</div>}
    {total>40&&<div className="paper-pagination"><button disabled={!offset} onClick={()=>setOffset(n=>Math.max(0,n-40))}>上一页</button><span>{Math.floor(offset/40)+1} / {Math.ceil(total/40)}</span><button disabled={offset+40>=total} onClick={()=>setOffset(n=>n+40)}>下一页</button></div>}
    {editing&&createPortal(<PaperEditor paper={editing} folders={folders} modules={modules} onClose={()=>setEditing(null)} onSaved={()=>{setEditing(null);setVersion(v=>v+1);}} onNotice={onNotice}/>,document.body)} {confirmNode&&createPortal(confirmNode,document.body)}
  </div>;
}

function MetadataFields({metadata,onChange,modules}:{metadata:PaperMetadata;onChange:(m:PaperMetadata)=>void;modules:LibraryModule[]}) {
  return <div className="paper-metadata-fields"><label>试卷类别<select value={metadata.kind} onChange={e=>onChange({...metadata,kind:e.target.value as PaperMetadata["kind"]})}><option value="school">期中期末 / 统考</option><option value="mock">中考模拟</option><option value="admission">自主招生</option><option value="custom">自定义</option></select></label>
    {([["year","年份 / 学年"],["school","学校"],["district","地区"],["grade","年级"],["term","学期"],["examType","考试类型"]] as const).map(([key,label])=><label key={key}>{label}<input value={metadata[key]} onChange={e=>onChange({...metadata,[key]:e.target.value})}/></label>)}
    {metadata.kind==="custom"&&<label>题库模块<select value={metadata.moduleId} onChange={e=>onChange({...metadata,moduleId:e.target.value})}><option value="">请选择</option>{modules.map(m=><option value={m.id} key={m.id}>{m.name}</option>)}</select></label>}
  </div>;
}
export function PaperImportDialog({folders,modules,onClose,onUploaded,onNotice}:{folders:PaperFolder[];modules:LibraryModule[];onClose:()=>void;onUploaded:(folder:string)=>void;onNotice:Notice}) {
  const [file,setFile]=useState<File|null>(null),[folder,setFolder]=useState(""),[moduleId,setModule]=useState(""),[busy,setBusy]=useState(false),[progress,setProgress]=useState(""),[error,setError]=useState(""),[dragging,setDragging]=useState(false);
  const dialogRef=usePaperDialog(true,onClose,busy);
  const fileRef=useRef<HTMLInputElement>(null);
  function chooseFiles(files:File[]){
    if(busy||!files.length)return;
    setDragging(false);setProgress("");setError("");
    if(files.length!==1){setFile(null);setError("每次只能录入一份试卷，请选择一个文件");return;}
    const next=files[0];
    if(!/\.(docx|pdf)$/i.test(next.name)||!next.size||next.size>80*1024*1024){setFile(null);setError("请选择一份非空、80MB 以内的 Word（.docx）或 PDF 文件；旧版 .doc 请先另存为 .docx");return;}
    setFile(next);
  }
  async function upload(){if(!file||!folders.length||busy)return;setBusy(true);setError("");try{
    setProgress("正在保存试卷原文件…");
    const result=await jobsApi<{paper:ExamPaper;existing:boolean}>(`/api/papers?${new URLSearchParams({fileName:file.name,folder,moduleId})}`,{method:"POST",headers:{"Content-Type":file.type||"application/octet-stream"},body:file});
    if(result.existing&&result.paper.status!=="uploading"){onNotice(result.paper.status==="done"?"这份文件已经收录，已保留原试卷和 ID":"这份文件已有录入任务，可在试卷列表继续");onUploaded(result.paper.folderId);onClose();return;}
    const {renderImportFile,structuredDocxQuestions}=await import("../../lib/file-import");
    const {contentFingerprint}=await import("../../lib/content-fingerprint.mjs");
    const pages=/\.docx$/i.test(file.name)?await renderImportFile(file,(current,total)=>setProgress(`正在读取 Word ${current}/${total} 页…`)):[];
    const structured=structuredDocxQuestions(pages);
    if(structured.length){
      const sourceQuestions=pages.find(page=>page.sourceQuestions?.length)?.sourceQuestions??[];
      const firstLine=pages[0]?.textHint?.split(/\n/).find(line=>/试卷|考试|(?:数学|期中|期末).*卷/.test(line)&&!/^\s*\d+[.、]/.test(line))?.trim();
      const draft:PaperDraft={title:firstLine?.slice(0,200)||result.paper.title,metadata:{...emptyPaperMetadata(),...(moduleId?{kind:"custom" as const,moduleId}:{})},issues:[],questions:structured.map(({questionNumber,warnings,...q},index)=>({number:questionNumber,section:sourceQuestions[index]?.section||q.type,page:q.sourcePage,categoryPath:[],warnings,question:{...q,id:"",moduleId:"",categoryId:"",difficulty:"中等",source:result.paper.title,createdAt:0,updatedAt:0,answer:q.answer==="见解析"&&!q.analysis?"":q.answer}}))};
      setProgress(`已读取 ${structured.length} 道题，正在提交后台归类…`);await jobsApi(`/api/papers/${result.paper.id}`,patch({action:"prepare",draft}));
    }else{
      let count=0;const uploadPage=async(page:{image:string;page:number;textHint?:string;documentSection?:"questions"|"answers"})=>{count++;setProgress(`正在上传第 ${count} 页，请暂时保持窗口打开…`);await uploadJobPage(result.paper.jobId!,{...page,id:`paper-page-${page.page}`,name:file.name,hash:await contentFingerprint(page.image)},`/api/papers/${result.paper.id}`);};
      if(pages.length){for(const page of pages)await uploadPage({image:page.image,page:page.pageNumber,textHint:page.textHint,documentSection:page.documentSection});}
      else{const {readStudioFilesInBatches}=await import("../../lib/answer-studio-images");await readStudioFilesInBatches([file],"question","",setProgress,async batch=>{for(const page of batch)await uploadPage(page);});}
      if(!count)throw new Error("文件中没有可识别的页面");
    }
    await jobsApi(`/api/papers/${result.paper.id}`,patch({action:"start"}));onNotice("试卷已转入后台，识别完整后会自动入库");onUploaded(folder?result.paper.folderId:"");onClose();
  }catch(e){setError(errorText(e));}finally{setBusy(false);}}
  return <div className="modal-backdrop"><section ref={dialogRef} tabIndex={-1} className="modal paper-import-dialog" role="dialog" aria-modal="true" aria-label="录入整套试卷"
    onPaste={event=>{const files=[...event.clipboardData.files];if(files.length){event.preventDefault();event.stopPropagation();chooseFiles(files);}}}
    onDragOver={event=>{if(event.dataTransfer.types.includes("Files")){event.preventDefault();event.dataTransfer.dropEffect=busy?"none":"copy";}}}
    onDrop={event=>{if(event.dataTransfer.types.includes("Files")){event.preventDefault();event.stopPropagation();setDragging(false);chooseFiles([...event.dataTransfer.files]);}}}>
    <div className="modal-head"><h2>录入试卷</h2><button className="close" aria-label="关闭录入" disabled={busy} onClick={onClose}>×</button></div><p className="subtext">上传完整 Word 或 PDF，系统自动拆题、归类并加入题库。答案可以放在同一份文件中。</p>
    <div className="paper-file-field">
      <button type="button" className="file-dropzone paper-file-dropzone" data-dragging={dragging} disabled={busy} aria-label={file?`更换试卷文件：${file.name}`:"选择试卷文件，也可拖入或粘贴"} aria-describedby="paper-file-help" onClick={()=>fileRef.current?.click()}
        onDragEnter={event=>{if(!busy&&event.dataTransfer.types.includes("Files"))setDragging(true);}}
        onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))setDragging(false);}}>
        <svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 3H8a2 2 0 0 0-2 2v22a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V10Z"/><path d="M19 3v7h7M16 24V14m-4 4 4-4 4 4"/></svg>
        <strong>{dragging?"松开以选择这份试卷":file?file.name:"点击选择或将试卷拖到这里"}</strong>
        <span>{file?`${/\.pdf$/i.test(file.name)?"PDF":"Word"} · ${file.size>=1024*1024?`${(file.size/1024/1024).toFixed(1)} MB`:`${Math.max(1,Math.ceil(file.size/1024))} KB`} · 点击更换`:"也可直接粘贴文件（⌘V / Ctrl+V）"}</span>
        <small id="paper-file-help">支持 Word（.docx）或 PDF · 每次一份 · 最大 80MB</small>
      </button>
      <input ref={fileRef} hidden type="file" aria-label="试卷文件" accept=".docx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" disabled={busy} onChange={event=>{chooseFiles([...event.target.files??[]]);event.target.value="";}}/>
      {file&&<div className="paper-file-selected" role="status"><span>已选择试卷文件</span><button type="button" disabled={busy} onClick={()=>{setFile(null);setError("");setProgress("");dialogRef.current?.querySelector<HTMLButtonElement>(".paper-file-dropzone")?.focus();}}>移除</button></div>}
    </div>
    <label className="field">试卷文件夹<select value={folder} disabled={busy} onChange={e=>setFolder(e.target.value)}><option value="">自动按试卷标题归档</option>{folders.map(f=><option value={f.id} key={f.id}>{paperFolderPath(folders,f.id)}</option>)}</select></label>
    {!folder&&<p className="paper-folder-hint">{file?`按文件名暂放「${paperFolderPath(folders,inferPaperFolder(folders,file.name))||"暂无文件夹"}」，识别原卷标题后自动归档。`:"根据原卷标题匹配现有文件夹；信息不足时保留在上级目录。"}</p>}
    <label className="field">题目归属<select value={moduleId} disabled={busy} onChange={e=>setModule(e.target.value)}><option value="">自动按试卷类别归类</option>{modules.map(m=><option value={m.id} key={m.id}>自定义 · {m.name}</option>)}</select></label>
    {progress&&busy&&<p className="paper-job-state" role="status">{progress}</p>}{error&&<p className="paper-error" role="alert">{error}</p>}
    <div className="modal-actions"><button className="secondary" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" disabled={busy||!file||!folders.length} onClick={()=>void upload()}>{busy?"准备中…":"开始录入"}</button></div>
  </section></div>;
}

function PaperEditor({paper,folders,modules,onClose,onSaved,onNotice}:{paper:ExamPaper;folders:PaperFolder[];modules:LibraryModule[];onClose:()=>void;onSaved:()=>void;onNotice:Notice}) {
  const [title,setTitle]=useState(paper.title),[folder,setFolder]=useState(paper.metadata.autoFolder?"":paper.folderId),[metadata,setMetadata]=useState(paper.metadata),[draft,setDraft]=useState<PaperDraft|null>(null),[loading,setLoading]=useState(paper.status!=="done"),[busy,setBusy]=useState(false),[error,setError]=useState("");
  useEffect(()=>{if(paper.status==="done")return;let live=true;void jobsApi<{draft:PaperDraft|null}>(`/api/papers/${paper.id}?draft=1`).then(result=>{if(live){setDraft(result.draft);if(result.draft){setTitle(result.draft.title);setMetadata(result.draft.metadata);}}}).catch(e=>{if(live)setError(errorText(e));}).finally(()=>{if(live)setLoading(false);});return()=>{live=false;};},[paper.id,paper.status]);
  const dialogRef=usePaperDialog(true,onClose,busy);
  function itemChange(index:number,changes:Partial<PaperDraft["questions"][number]>){setDraft(current=>current?{...current,classified:false,questions:current.questions.map((q,i)=>i===index?{...q,...changes}:q)}:null);}
  async function save(){setBusy(true);setError("");try{await jobsApi(`/api/papers/${paper.id}`,patch({title,folderId:folder,metadata}));if(draft){const updated={...draft,title,metadata};const issues=paperDraftIssues(updated);if(issues.length)throw new Error(issues.slice(0,5).join("；"));await jobsApi(`/api/papers/${paper.id}`,patch({action:"prepare",draft:updated}));await jobsApi(`/api/papers/${paper.id}`,patch({action:"start"}));}onNotice(draft?"修正已保存，正在继续入库":"试卷信息已更新");onSaved();}catch(e){setError(errorText(e));}finally{setBusy(false);}}
  return <div className="modal-backdrop"><section ref={dialogRef} tabIndex={-1} className={`modal paper-editor${draft?" with-questions":""}`} role="dialog" aria-modal="true" aria-label="编辑试卷"><div className="modal-head"><h2>{paper.status==="done"?"编辑试卷信息":"修正试卷"}</h2><button className="close" aria-label="关闭编辑" disabled={busy} onClick={onClose}>×</button></div>
    <label className="field">试卷标题<input value={title} onChange={e=>setTitle(e.target.value)}/></label><label className="field">文件夹<select value={folder} onChange={e=>setFolder(e.target.value)}><option value="">自动按试卷标题归档</option>{folders.map(f=><option key={f.id} value={f.id}>{paperFolderPath(folders,f.id)}</option>)}</select></label>
    <MetadataFields metadata={metadata} modules={modules} onChange={setMetadata}/>
    {loading?<p>正在读取识别结果…</p>:paper.status!=="done"&&!draft?<p>页面识别尚未完成，请关闭后点击“继续”重试未完成的页面。</p>:null}
    {paper.error&&<p className="paper-error">{paper.error}</p>}
    {draft&&<div className="paper-draft-questions">{!!draft.issues.length&&<div className="paper-error"><p>{draft.issues.join("；")}</p><button onClick={()=>setDraft({...draft,issues:[],expectedCount:draft.questions.length})}>已核对题数及题号配对</button></div>}
      {draft.questions.map((entry,index)=><details key={index} className="paper-draft-question"><summary>{entry.section} · 第 {entry.number} 题{entry.warnings.length||entry.incomplete?" · 有待核对内容":""}</summary><QuestionBody question={entry.question} number={entry.number}/>
        <div className="paper-metadata-fields"><label>原题号<input value={entry.number} onChange={e=>itemChange(index,{number:e.target.value})}/></label><label>分区标题<input value={entry.section} onChange={e=>itemChange(index,{section:e.target.value})}/></label></div>
        <label className="field">题干<textarea value={entry.question.stem} onChange={e=>itemChange(index,{question:{...entry.question,stem:e.target.value,stemDocxXml:undefined,stemParagraphs:undefined}})}/></label>
        <label className="field">选项（每行一个）<textarea value={entry.question.options.join("\n")} onChange={e=>itemChange(index,{question:{...entry.question,options:e.target.value.split("\n"),optionsDocxXml:undefined}})}/></label>
        <label className="field">答案<textarea value={entry.question.answer} onChange={e=>itemChange(index,{question:{...entry.question,answer:e.target.value}})}/></label>
        <label className="field">解析<textarea value={entry.question.analysis} onChange={e=>itemChange(index,{question:{...entry.question,analysis:e.target.value,analysisDocxXml:undefined}})}/></label>
        <label className="field">知识目录（各层用 / 分隔，留空自动归类）<input value={entry.categoryPath.join(" / ")} onChange={e=>itemChange(index,{categoryPath:e.target.value.split("/").map(s=>s.trim()).filter(Boolean)})}/></label>
        {(entry.warnings.length>0||entry.incomplete)&&<div className="paper-error"><p>{entry.warnings.join("；")}{entry.incomplete&&"；跨页内容待补全"}</p><button onClick={()=>itemChange(index,{warnings:[],incomplete:false})}>本题内容已核对修正</button></div>}
      </details>)}
    </div>}
    {error&&<p className="paper-error" role="alert">{error}</p>}<div className="modal-actions"><button className="secondary" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" disabled={busy||loading||!title.trim()||paper.status!=="done"&&!draft} onClick={()=>void save()}>{busy?"保存中…":draft?"保存并继续入库":"保存"}</button></div>
  </section></div>;
}
