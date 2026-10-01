import { homeworkDb } from './homework';
import { HOMEWORK_PAGE_CONTRACT, type PageExtraction } from '../completed-homework-coverage';
export type ExtractionPage = { id:string;page_order:number;processed_asset_id:string;quality_json:string };
export async function coverageFingerprint(pages:ExtractionPage[],index:number){
  const data=JSON.stringify({contract:HOMEWORK_PAGE_CONTRACT,primary:pages[index].id,context:pages.slice(Math.max(0,index-1),index+2).map(p=>[p.id,p.page_order,p.processed_asset_id])});
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(data)))].map(b=>b.toString(16).padStart(2,'0')).join('');
}
export async function readPageCoverage(submissionId:string){
  const db=homeworkDb();
  const [pageResult,rowResult]=await Promise.all([
    db.prepare('SELECT id,page_order,processed_asset_id,quality_json FROM submission_pages WHERE submission_id=? ORDER BY page_order').bind(submissionId).all<ExtractionPage>(),
    db.prepare('SELECT * FROM submission_page_extractions WHERE submission_id=?').bind(submissionId).all<{page_id:string;fingerprint:string;status:string;result_json:string;error:string}>(),
  ]);
  const pages=pageResult.results as ExtractionPage[];const rows=new Map((rowResult.results as Array<{page_id:string;fingerprint:string;status:string;result_json:string;error:string}>).map(r=>[r.page_id,r]));
  const checked=await Promise.all(pages.map(async(page,index)=>{
    const row=rows.get(page.id),fingerprint=await coverageFingerprint(pages,index);
    const valid=Boolean(row?.status==='complete'&&row.fingerprint===fingerprint);
    const result=valid?JSON.parse(row!.result_json) as PageExtraction:null;
    return {pageNumber:page.page_order+1,valid,kind:result?.kind??null,reason:result?.reason??row?.error??''};
  }));
  return {total:pages.length,processed:checked.filter(p=>p.valid).length,unreadable:checked.filter(p=>p.valid&&p.kind==='unreadable').length,missing:checked.filter(p=>!p.valid).map(p=>p.pageNumber),pages:checked};
}
export async function assertCompletePageCoverage(submissionId:string){
  const coverage=await readPageCoverage(submissionId);
  if(!coverage.total||coverage.processed!==coverage.total)throw new Error(`作业页面尚未全部核验：${coverage.processed}/${coverage.total} 页，未完成页：${coverage.missing.join('、')}`);
  return coverage;
}
