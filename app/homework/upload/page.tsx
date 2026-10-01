"use client";
import { useEffect, useState } from 'react';
import DocumentScanner, { type ScannedHomeworkPage } from '../../components/DocumentScanner';
import { homeworkApi, uploadHomeworkAsset } from '../../../lib/homework-api-client';
import { renderImportFile } from '../../../lib/file-import';
import type { HomeworkSubmission, StudentSummary } from '../../../lib/types';
export default function CompletedHomeworkUpload(){
  const [students,setStudents]=useState<StudentSummary[]>([]),[studentId,setStudentId]=useState(''),[title,setTitle]=useState(''),[pages,setPages]=useState<ScannedHomeworkPage[]>([]),[references,setReferences]=useState<File[]>([]),[documents,setDocuments]=useState<File[]>([]);
  const [scannerBusy,setScannerBusy]=useState(false);
  const [busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[message,setMessage]=useState(''),[draft,setDraft]=useState<HomeworkSubmission|null>(null);
  useEffect(()=>{void homeworkApi.students().then(r=>{setStudents(r.students);const requested=new URLSearchParams(location.search).get('studentId');setStudentId(r.students.find(s=>s.id===requested)?.id??r.students[0]?.id??'');}).catch(e=>setMessage(e.message)).finally(()=>setLoading(false));},[]);
  async function start(){
    if(!studentId||!title.trim()||!pages.length||busy||scannerBusy)return;
    if(pages.length>30){setMessage('单份作业最多30页，请分成多份上传');return;}
    setBusy(true);setMessage('正在保存学生作业原件…');
    try{
      const submission=draft??(await homeworkApi.createCompletedSubmission(studentId,title.trim())).submission;setDraft(submission);
      for(const file of documents)await uploadHomeworkAsset({blob:file,fileName:file.name,role:'submission_document',pageOrder:0,submissionId:submission.id});
      const saved=[];
      for(const [index,page] of pages.entries()){
        const original=await uploadHomeworkAsset({blob:page.original,fileName:`作业原件第${index+1}页.jpg`,role:'submission_original',pageOrder:index,submissionId:submission.id});
        const processed=await uploadHomeworkAsset({blob:page.processed,fileName:`作业校准第${index+1}页.jpg`,role:'submission_processed',pageOrder:index,submissionId:submission.id});
        saved.push({originalAssetId:original.id,processedAssetId:processed.id,quality:page.quality});setMessage(`正在上传作业 ${index+1}/${pages.length} 页…`);
      }
      let order=0;
      for(const file of references){
        const images=file.type.startsWith('image/')?[file]:await Promise.all((await renderImportFile(file,()=>{})).map(async p=>(await fetch(p.image)).blob()));
        for(const blob of images){if(order>=30)throw new Error("参考答案最多30页");await uploadHomeworkAsset({blob,fileName:file.name,role:'answer',pageOrder:order++,assignmentId:submission.assignmentId});}
      }
      await homeworkApi.updateSubmission(submission.id,{action:'save-pages',pages:saved});
      await homeworkApi.updateSubmission(submission.id,{action:'submit'});
      location.href=`/homework/submissions/${submission.id}`;
    }catch(e){setMessage(e instanceof Error?e.message:'上传失败，请重试');setBusy(false);}
  }
  return <main className="homework-upload-page"><header><a href="/homework">← 作业批改与记录</a><a href={studentId?`/?view=wrong-book&studentId=${encodeURIComponent(studentId)}`:'/?view=wrong-book'}>学生错题本</a></header><section className="homework-panel"><h1>上传学生作业</h1><p>Agent 自动批改，完全错误的题目自动归入学生错题本。</p>{message&&<div role="status" className="homework-notice">{message}</div>}{loading?<p>正在读取学生档案…</p>:<><div className="completed-upload-fields"><label>学生<select value={studentId} disabled={busy||!!draft} onChange={e=>setStudentId(e.target.value)}>{students.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label>作业名称<input value={title} disabled={busy||!!draft} onChange={e=>setTitle(e.target.value)} placeholder="例如：一元一次方程练习" /></label></div>{!students.length&&<p>请先在学生档案中创建学生。<a href="/homework?view=students">创建学生档案</a></p>}<h2>学生已完成的作业</h2><p>支持图片、PDF，每份最多30页。看不清的题目单独待处理，其余正常批改。</p><DocumentScanner pages={pages} onChange={setPages} disabled={busy} onBusyChange={setScannerBusy} allowPdf onSourceFile={file=>setDocuments(current=>[...current,file])}/><details className="completed-reference"><summary>参考答案（选填）</summary><p>有答案时优先使用；未提供时由 Agent 独立解题并校验。</p><input type="file" aria-label="上传参考答案" accept="image/*,application/pdf" multiple disabled={busy} onChange={e=>setReferences([...(e.target.files??[])])}/>{references.map((f,index)=><p key={index}>{f.name}</p>)}</details><button className="primary upload-submit" disabled={busy||scannerBusy||!studentId||!title.trim()||!pages.length} onClick={start}>{busy?'正在提交…':'开始自动批改'}</button></>}</section></main>;
}
