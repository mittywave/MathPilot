"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- vinext beta currently breaks next/link RSC prefetch on these client-only pages. */
import { useEffect, useState } from 'react';
import HomeworkPagePicker, { type HomeworkPage } from '../../../components/HomeworkPagePicker';
import { CURRICULA, useHomeworkUpload } from '../../../components/use-homework-upload';
import { homeworkApi } from '../../../../lib/homework-api-client';
import type { HomeworkCurriculum, HomeworkOutputs, StudentSummary } from '../../../../lib/types';
const OUTPUT_OPTIONS:Array<[keyof HomeworkOutputs,string,string]>=[
  ['wrongBook','加入学生错题本','完全错误的题目归入该学生的错题本'],
  ['report','生成批改报告','汇总本次作业的薄弱点与下一步建议'],
  ['profile','整合到学生画像','把本次结果计入该学生的知识图谱掌握情况'],
];
export default function CompletedHomeworkUpload(){
  const [students,setStudents]=useState<StudentSummary[]>([]),[studentId,setStudentId]=useState(''),[title,setTitle]=useState(''),[pages,setPages]=useState<HomeworkPage[]>([]),[references,setReferences]=useState<File[]>([]),[documents,setDocuments]=useState<File[]>([]);
  const [pickerBusy,setPickerBusy]=useState(false);
  const [outputs,setOutputs]=useState<HomeworkOutputs>({wrongBook:true,report:true,profile:false});
  const upload=useHomeworkUpload(),{curriculum,busy,draft,referencesSaved}=upload;
  const international=curriculum==='international';
  const [loading,setLoading]=useState(true),[loadError,setLoadError]=useState('');
  useEffect(()=>{void homeworkApi.students().then(r=>{setStudents(r.students);const requested=new URLSearchParams(location.search).get('studentId');setStudentId(r.students.find(s=>s.id===requested)?.id??r.students[0]?.id??'');}).catch(e=>setLoadError(e.message)).finally(()=>setLoading(false));},[]);
  async function start(){
    if(!studentId||!title.trim()||!pages.length||busy||pickerBusy)return;
    const submission=await upload.start({studentId,title,outputs,pages,documents,references});
    if(submission)location.href=`/tools/homework/submissions/${submission.id}`;
  }
  const message=upload.message||loadError;
  return <main className="homework-upload-page"><header><a href="/tools/homework">← 作业批改</a><a href={studentId?`/?view=wrong-book&studentId=${encodeURIComponent(studentId)}`:'/?view=wrong-book'}>学生错题本</a></header><section className="homework-panel"><h1>上传学生作业</h1><p>Agent 自动批改，批改结果按下方选择写入学生档案。</p>{message&&<div role="status" className="homework-notice">{message}</div>}{loading?<p>正在读取学生档案…</p>:<><div className="completed-upload-fields"><label>学生<select value={studentId} disabled={busy||!!draft} onChange={e=>setStudentId(e.target.value)}>{students.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label>作业名称<input value={title} disabled={busy||!!draft} onChange={e=>setTitle(e.target.value)} placeholder={international?'例如：9709 P1 Week 3 Quiz':'例如：一元一次方程练习'} /></label><label>课程<select aria-label="课程" value={curriculum} disabled={busy||!!draft} onChange={e=>upload.chooseCurriculum(e.target.value as HomeworkCurriculum)}>{CURRICULA.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label></div>{international&&<p className="homework-curriculum-note">按每个小问的印刷分值和 mark scheme 给分；看不清或空白的作答记 0 分。报告供家长与学生共读，可下载 PDF。</p>}{!students.length&&<p>请先在学生档案中创建学生。<a href="/?view=wrong-book">创建学生档案</a></p>}<h2>学生已完成的作业</h2><p>支持照片、PDF，每份最多30页。看不清的题目单独待处理，其余正常批改。</p><HomeworkPagePicker pages={pages} onChange={setPages} disabled={busy} onBusyChange={setPickerBusy} onSourceFile={file=>setDocuments(current=>[...current,file])}/><details className="completed-reference" open={international||undefined}><summary>{international?'Mark Scheme（建议上传）':'参考答案（选填）'}</summary><p>{international?'有 mark scheme 时逐个得分点对照；未提供时由 Agent 按考试局惯例拟定得分点并校验。':'有答案时优先使用；未提供时由 Agent 独立解题并校验。'}</p><input type="file" aria-label="上传参考答案" accept="image/*,application/pdf" multiple disabled={busy||referencesSaved} onChange={e=>setReferences([...(e.target.files??[])])}/>{references.map((f,index)=><p key={index}>{f.name}</p>)}</details><fieldset className="homework-outputs" disabled={busy||!!draft}><legend>批改结果写入</legend>{OUTPUT_OPTIONS.map(([key,label,hint])=><label key={key}><input type="checkbox" aria-label={label} checked={outputs[key]} onChange={e=>setOutputs(current=>({...current,[key]:e.target.checked}))}/><span><b>{label}</b><small>{hint}</small></span></label>)}</fieldset><button className="primary upload-submit" disabled={busy||pickerBusy||!studentId||!title.trim()||!pages.length} onClick={start}>{busy?'正在提交…':'开始自动批改'}</button></>}</section></main>;
}
