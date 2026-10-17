"use client";
/* eslint-disable @next/next/no-html-link-for-pages -- vinext beta currently breaks next/link RSC prefetch on these client-only pages. */
import { useEffect, useState } from 'react';
import { SiteHeader } from '../../../components/SiteHeader';
import HomeworkPagePicker, { type HomeworkPage } from '../../../components/HomeworkPagePicker';
import { CURRICULA, useHomeworkUpload } from '../../../components/use-homework-upload';
import { homeworkApi } from '../../../../lib/homework-api-client';
import type { AuthUser, HomeworkCurriculum, HomeworkOutputs, StudentSummary } from '../../../../lib/types';
const OUTPUT_OPTIONS:Array<[keyof HomeworkOutputs,string,string]>=[
  ['wrongBook','加入学生错题本','完全错误的题目归入该学生的错题本'],
  ['report','生成批改报告','汇总本次作业的薄弱点与下一步建议'],
  ['profile','计入定档','把这次的知识点和题型正确率计入该学生的定档'],
];
export default function CompletedHomeworkUpload(){
  const [students,setStudents]=useState<StudentSummary[]>([]),[studentId,setStudentId]=useState(''),[title,setTitle]=useState(''),[pages,setPages]=useState<HomeworkPage[]>([]),[references,setReferences]=useState<File[]>([]),[documents,setDocuments]=useState<File[]>([]);
  const [pickerBusy,setPickerBusy]=useState(false),[originalPickerBusy,setOriginalPickerBusy]=useState(false);
  const [originals,setOriginals]=useState<HomeworkPage[]>([]);
  const [user,setUser]=useState<AuthUser|null|undefined>(undefined),[fromStudent,setFromStudent]=useState(false);
  const [outputs,setOutputs]=useState<HomeworkOutputs>({wrongBook:true,report:true,profile:true});
  const upload=useHomeworkUpload(),{curriculum,busy,draft}=upload;
  const reading=pickerBusy||originalPickerBusy;
  const international=curriculum==='international';
  const [loading,setLoading]=useState(true),[loadError,setLoadError]=useState('');
  useEffect(()=>{void homeworkApi.me().then(async me=>{setUser(me.user);if(!me.user)return;const r=await homeworkApi.students();setStudents(r.students);const requested=new URLSearchParams(location.search).get('studentId');const selected=r.students.find(s=>s.id===requested);setFromStudent(Boolean(selected));setStudentId(selected?.id??r.students[0]?.id??'');}).catch(e=>{setUser(current=>current??null);setLoadError(e.message);}).finally(()=>setLoading(false));},[]);
  async function start(){
    if(!studentId||!title.trim()||!pages.length||busy||reading)return;
    const submission=await upload.start({studentId,title,outputs,pages,documents,references,originals:originals.map((page,index)=>new File([page.blob],`学校作业原件第${index+1}页.jpg`,{type:page.blob.type}))});
    if(submission)location.href=`/tools/homework/submissions/${submission.id}`;
  }
  const message=upload.message||loadError;
  const missing=[!studentId&&{label:'学生',target:'.completed-upload-fields select'},!title.trim()&&{label:'作业名称',target:'.completed-upload-fields input'},!pages.length&&{label:'学生的作业页面',target:'.completed-upload-materials button.drop-entry'}].filter(field=>field!==false);
  const student=students.find(s=>s.id===studentId);
  const trail=fromStudent&&student?[{label:'学生档案',href:'/?view=wrong-book'},{label:student.name,href:`/?view=wrong-book&studentId=${encodeURIComponent(student.id)}&tab=homework`},{label:'上传作业'}]:[{label:'工具箱',href:'/tools'},{label:'作业批改',href:'/tools/homework'},{label:'上传作业'}];
  return <><SiteHeader active={fromStudent?'students':'tools'} user={user??null} loading={user===undefined} trail={trail}/>
    {loading?<main className="homework-loading">正在读取学生档案…</main>:!user?<main className="homework-loading"><p>请先登录教师账号。</p><a href="/">返回题库登录</a></main>:<main className="homework-upload-page">
      {message&&<div role={busy?"status":"alert"} className={`homework-notice${busy?"":" inline-error"}`}>{message}</div>}
      <aside className="completed-upload-controls">
        <div className="completed-upload-fields"><label>学生<select value={studentId} disabled={busy||!!draft} onChange={e=>setStudentId(e.target.value)}>{students.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label>作业名称<input value={title} disabled={busy||!!draft} onChange={e=>setTitle(e.target.value)} placeholder={international?'例如：9709 P1 Week 3 Quiz':'例如：一元一次方程练习'} /></label><label>课程<select aria-label="课程" value={curriculum} disabled={busy||!!draft} onChange={e=>upload.chooseCurriculum(e.target.value as HomeworkCurriculum)}>{CURRICULA.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label></div>
        {international&&<p className="homework-curriculum-note">按每个小问的印刷分值和 mark scheme 给分；看不清或空白的作答记 0 分。报告可下载 PDF。</p>}
        {!students.length&&<p>请先在学生档案中创建学生。<a href="/?view=wrong-book">创建学生档案</a></p>}
        <fieldset className="homework-outputs" disabled={busy||!!draft}><legend>批改结果写入</legend>{OUTPUT_OPTIONS.map(([key,label,hint])=><label key={key}><input type="checkbox" aria-label={label} checked={outputs[key]} onChange={e=>setOutputs(current=>({...current,[key]:e.target.checked}))}/><span><b>{label}</b><small>{hint}</small></span></label>)}</fieldset>
        <button className="primary upload-submit" aria-describedby={!busy&&!reading&&missing.length?'homework-upload-missing':undefined} disabled={busy||reading||!studentId||!title.trim()||!pages.length} onClick={start}>{busy?'正在提交…':'开始自动批改'}</button>
        {!busy&&!reading&&missing.length>0&&<p className="missing-reason" id="homework-upload-missing">还差：{missing.map((field,index)=><span key={field.label}>{index>0?'、':''}<button type="button" className="text-button" onClick={()=>{const control=document.querySelector<HTMLElement>(field.target);control?.focus({preventScroll:true});control?.scrollIntoView({block:'nearest'});}}>{field.label}</button></span>)}</p>}
      </aside>
      <section className="completed-upload-materials">
        <h2>学生已完成的作业</h2><p>看不清的题目单独待处理，其余正常批改。</p>
        <HomeworkPagePicker pages={pages} onChange={setPages} disabled={busy} onBusyChange={setPickerBusy} onSourceFile={file=>setDocuments(current=>[...current,file])}/>
        <details className="completed-reference"><summary>学校作业原件（选填）</summary><p>上传学校发的空白试题或练习原件，用于核对题干与配图。未上传也可以正常批改。</p><HomeworkPagePicker pages={originals} onChange={setOriginals} disabled={busy||!!draft} onBusyChange={setOriginalPickerBusy} label="粘贴或拖入学校作业原件"/></details>
        <details className="completed-reference" open={international||undefined}><summary>{international?'Mark Scheme（建议上传）':'参考答案（选填）'}</summary><p>{international?'有 mark scheme 时逐个得分点对照；未提供时按考试局惯例拟定得分点并校验。':'有答案时优先使用；未提供时独立解题并校验。'}</p><input type="file" aria-label="上传参考答案" accept="image/*,application/pdf" multiple disabled={busy||!!draft} onChange={e=>setReferences([...(e.target.files??[])])}/>{references.map((f,index)=><p key={index}>{f.name}</p>)}</details>
      </section>
    </main>}</>;
}
