import { studioSnapshot } from './answer-studio-snapshot';
import { randomClientId } from './client-random-id.mjs';
import {
  attachAnswerOnlyRecords, matchStudioAnswers, mergeStudioRecords, sameStudioStem, studioKey,
  type StudioBox, type StudioDiagram, type StudioDraft, type StudioPage, type StudioQuestion,
  type StudioRecord, type StudioShape,
} from './answer-studio';
import { normalizeStudioTextFields } from './answer-studio-normalize';
import { studioFullFiguresReady, studioFiguresReady, studioTextReady } from './answer-studio-output';
import { runStudioOrdered, runStudioWindow, studioConcurrencyState, StudioRequestError, type StudioRetryNotice, type StudioRetryRuntime } from './answer-studio-concurrency';
export const STUDIO_DRAWINGS_REVISION=3;
export type StudioDrawingContext={answerOnly:boolean;hasSourceDiagrams:boolean};

export type StudioDrawingResult = {
  disposition?:'solution'|'question-only'|'none'|'uncertain';
  diagrams: Array<{baseIndex:number;caption:string;shapes:StudioShape[];warnings:string[]}>;
  warnings:string[];
};
/** Model boxes can touch a stroke or label; retain a small source-page margin. */
export function studioPaddedDiagramBox(box:StudioBox):StudioBox {
  const margin=5,x=Math.max(0,box.x-margin),y=Math.max(0,box.y-margin);
  return {x,y,width:Math.min(1000,box.x+box.width+margin)-x,height:Math.min(1000,box.y+box.height+margin)-y};
}
export function studioMayOmitQuestionFigures(context:StudioDrawingContext,result:StudioDrawingResult) {
  return context.answerOnly&&result.disposition==='question-only'&&!result.diagrams.length&&!result.warnings.length;
}
export function studioDrawingMissing(question:Pick<StudioQuestion,'analysis'|'answerPlacements'>,bases:StudioDiagram[],context:StudioDrawingContext,result:StudioDrawingResult) {
  const requiresGeometry=result.disposition==='solution'||result.disposition==='uncertain'||!bases.length&&context.hasSourceDiagrams;
  return requiresGeometry&&!result.diagrams.some(d=>d.shapes.some(s=>s.kind!=='label'))&&!studioMayOmitQuestionFigures(context,result);
}
export type StudioPipelineServices = {
  recognize(page:StudioPage, context:string, options?:{concurrent:boolean}):Promise<StudioRecord[]>;
  crop(image:string, box:StudioBox):Promise<{image:string;width:number;height:number}>;
  drawings(question:StudioQuestion, bases:StudioDiagram[], evidence:string[],context:StudioDrawingContext):Promise<StudioDrawingResult>;
  checkpoint(draft:StudioDraft):Promise<void>;
  progress(message:string):void;
};

export type StudioPipelineOptions={drawings?:boolean;includeQuestionFigures?:boolean;textConcurrency?:number;drawingConcurrency?:number;retryRuntime?:StudioRetryRuntime};
type PendingPage={hash:string;context:string;concurrent:boolean;records:StudioRecord[]};
/** Additive local checkpoint metadata; no images or API keys are duplicated. */
type StudioRunDraft=StudioDraft&{pendingTranscriptions?:Record<string,PendingPage>};
function needsFreshContext(records:StudioRecord[],draft:StudioDraft,role:StudioPage['role']) {
  const first=records[0];
  return records.some(r=>r.continuation||r.warnings.some(w=>/续题|续页|续解|归属|栏目不明|讲次不明|题号不明|并发/.test(w)))
    ||!!first&&(!first.number.trim()||!first.section.trim()
      ||(role==='answer'?draft.answers:draft.questions).some(r=>studioKey(r)===studioKey(first)));
}
/** Used by both the simple webpage and regression tests; no human approval is fabricated. */
export async function transcribeStudio(draft:StudioDraft, service:StudioPipelineServices, options:StudioPipelineOptions={}) {
  const next:StudioRunDraft=studioSnapshot(draft);
  next.questions=next.questions.map(normalizeStudioTextFields);
  next.answers=next.answers.map(normalizeStudioTextFields);
  const pages=next.pages.filter(p=>p.selected);
  if(!pages.length)throw new Error('没有可处理的页面');
  const save=async()=>{next.updatedAt=Date.now();await service.checkpoint(studioSnapshot(next));};
  const hadUnprocessedPages=pages.some(p=>!p.processed);
  const textState=studioConcurrencyState(options.textConcurrency);
  const reportRetry=(notice:StudioRetryNotice)=>service.progress(`服务暂时繁忙（${notice.status||'网络'}），${Math.ceil(notice.delayMs/1000)} 秒后重试 ${notice.attempt}/2；当前并发 ${notice.limit} 路…`);
  const contextNow=()=>[...next.questions,...next.answers].slice(-18).map(q=>`${q.lesson}｜${q.section} ${q.number} ${q.stem.slice(0,150)} ${q.analysis.slice(-120)}`).join('\n');
  const pending=next.pendingTranscriptions??={};
  const cached=(page:StudioPage)=>{
    const entry=pending[page.id];
    return entry&&entry.hash===page.hash&&typeof entry.context==='string'&&Array.isArray(entry.records)?entry:undefined;
  };
  const pageFailure=(page:StudioPage,error:unknown)=>new Error(`第 ${page.page} 页（${page.name}）转录失败：${error instanceof Error?error.message:'识别服务异常'}。已保存完成页及本批成功结果，可点击“继续转录”重试。`,{cause:error});
  // Establish originals before answers. Never mix both roles in one window.
  for(const role of ['question','answer'] as const) {
    const remaining=pages.filter(p=>p.role===role&&!p.processed);
    // Checkpoint callbacks are serialized; successful out-of-order pages are
    // durable but cannot be merged ahead of a missing predecessor.
    let persistence:Promise<void>=Promise.resolve();
    const persist=(page:StudioPage,entry:PendingPage)=>{
      persistence=persistence.then(async()=>{pending[page.id]=entry;await save();});
      return persistence;
    };
    const recognize=async(page:StudioPage):Promise<PendingPage>=>{
      const context=contextNow(),concurrent=textState.limit>1&&pages.some(p=>p.role===role&&p.processed);
      const [result]=await runStudioWindow([page],async target=>cached(target)||{
        hash:target.hash,context,concurrent,
        records:(await service.recognize(target,context,{concurrent})).map(normalizeStudioTextFields),
      },textState,reportRetry,options.retryRuntime);
      if(result.status==='rejected')throw pageFailure(page,result.reason);
      return result.value;
    };
    const consume=async(page:StudioPage,entry:PendingPage)=>{
      // Finish writes from peers before mutating the ordered snapshot. No
      // request is started while this slot performs a context-sensitive review.
      await persistence;

        const freshContext=contextNow();
        if(entry.concurrent&&entry.context!==freshContext&&needsFreshContext(entry.records,next,page.role)) {
          service.progress(`正在复核第 ${page.page} 页（${page.name}）的跨页归属…`);
          const [review]=await runStudioWindow([page],async target=>(await service.recognize(target,freshContext,{concurrent:false})).map(normalizeStudioTextFields),textState,reportRetry,options.retryRuntime);
          if(review.status==='rejected')throw pageFailure(page,review.reason);
          entry={hash:page.hash,context:freshContext,concurrent:false,records:review.value};
          pending[page.id]=entry;
          await persist(page,entry);
        }
        const records=entry.records;
        if(page.role==='answer') {
          next.answers=mergeStudioRecords([...next.answers,...records]);
          if(next.inputMode==='answers')next.questions=attachAnswerOnlyRecords(next);
        } else {
          for(const r of records) {
            const candidates=next.questions.filter(q=>studioKey(q)===studioKey(r));
            if(!r.continuation&&candidates.some(q=>sameStudioStem(q.stem,r.stem)))continue;
            const questionDiagramSources=r.diagramBoxes.map(box=>({pageId:page.id,box:studioPaddedDiagramBox(box)}));
            if(r.continuation&&candidates.length===1) {
              const q=candidates[0];q.stem+='\n'+r.stem;q.questionSources.push(r.source);q.questionDiagramSources=[...(q.questionDiagramSources||[]),...questionDiagramSources];q.tables=[...(q.tables||[]),...(r.tables||[])];q.drawingsChecked=false;q.warnings.push(...r.warnings);
            } else next.questions.push({id:randomClientId(),lesson:r.lesson,section:r.section,number:r.number,stem:r.stem,analysis:'',questionSources:[r.source],questionDiagramSources,answerIds:[],diagrams:[],tables:r.tables||[],warnings:[...r.warnings,...(r.continuation?['原题续页归属不明确，已独立保留']:[])],resolutions:{},reviewed:false});
          }
        }
        page.processed=true;
        delete pending[page.id];
        persistence=persistence.then(save);await persistence;
      service.progress(`已保存 ${pages.filter(p=>p.processed).length}/${pages.length} 页（${textState.limit} 路并发）`);
    };
    const seeded=pages.some(p=>p.role===role&&p.processed);
    if(!seeded&&remaining.length)await runStudioOrdered(remaining.splice(0,1),recognize,textState,consume,persist);
    await runStudioOrdered(remaining,recognize,textState,consume,persist);
  }
  delete next.pendingTranscriptions;
  if(next.inputMode!=='answers' && (hadUnprocessedPages || !studioTextReady(next))) {
    for(const q of next.questions.filter(q=>!q.answerOnly)) {
      const matched=matchStudioAnswers(q,next.answers);
      q.answerIds=matched.map(a=>a.id);q.analysis=matched.map(a=>a.analysis).join('\n');q.tables=[...(q.tables||[]),...matched.flatMap(a=>a.tables||[])];
      q.warnings=[...new Set([...q.warnings,...matched.flatMap(a=>a.warnings)])];
      if(!matched.length)q.warnings.push('未匹配到对应答案，原题已保留');
    }
    // Never silently drop ambiguous/unmatched answers. Retain them as separate,
    // explicitly labelled entries for the user's later Word corrections.
    const used=new Set(next.questions.flatMap(q=>q.answerIds));
    const extras=attachAnswerOnlyRecords({...next,questions:[],answers:next.answers.filter(a=>!used.has(a.id))});
    extras.forEach(q=>q.warnings.push('未能唯一匹配干净原题，答案已独立保留'));
    next.questions.push(...extras);
  }
  if(!next.questions.length)throw new Error('所选页面未识别出题目或答案，请检查材料和页码');
  for(const q of next.questions)q.answerPlacements=q.answerIds.flatMap(id=>next.answers.find(a=>a.id===id)?.answerPlacements||[]);
  await save();
  // Text-only downloads must neither call drawing AI nor mark diagrams complete.
  if(options.drawings===false)return next;
  const drawingState=studioConcurrencyState(options.drawingConcurrency,2,2);
  const drawingReady=(q:StudioQuestion)=>q.drawingsChecked&&q.drawingsRevision===STUDIO_DRAWINGS_REVISION&&(options.includeQuestionFigures?studioFullFiguresReady(q,next):studioFiguresReady(q,next));
  async function processDrawing(sourceQuestion:StudioQuestion):Promise<StudioQuestion> {
    // Each worker owns its copy. Only the coordinator may replace next.questions.
    const q=structuredClone(sourceQuestion);
    const answers=q.answerIds.map(id=>next.answers.find(a=>a.id===id)!);
    q.answerPlacements=answers.flatMap(a=>a.answerPlacements||[]);
    for(const source of q.questionDiagramSources||[]) {
      if(q.diagrams.some(d=>d.baseSource?.pageId===source.pageId&&JSON.stringify(d.baseSource.box)===JSON.stringify(source.box)))continue;
      const page=next.pages.find(p=>p.id===source.pageId);
      if(!page)throw new Error('缺少原题配图来源页，请恢复包含原件的项目备份');
      const crop=await service.crop(page.image,source.box);
      q.diagrams.push({id:randomClientId(),caption:'',baseImage:crop.image,baseSource:source,width:crop.width,height:crop.height,shapes:[],warnings:[]});
    }
    // Always inspect answer evidence, including questions whose text pass missed
    // diagramBoxes. Empty diagrams is a model decision, never an omitted call.
    let drawingFailed=false;
    const evidence:string[]=[];
    try {
      for(const a of answers) {
        const page=next.pages.find(p=>p.id===a.source.pageId);
        if(!page)throw new Error('缺少答案原件，无法处理配图');
        const boxes=[a.source.box,...a.diagramBoxes];
        const union={x:Math.min(...boxes.map(b=>b.x)),y:Math.min(...boxes.map(b=>b.y)),width:0,height:0};
        union.width=Math.max(...boxes.map(b=>b.x+b.width))-union.x;
        union.height=Math.max(...boxes.map(b=>b.y+b.height))-union.y;
        evidence.push((await service.crop(page.image,union)).image);
        // Full question evidence gives ownership/context; separate close-ups keep
        // small printed connections legible in the visual reconstruction pass.
        for(const box of a.diagramBoxes)evidence.push((await service.crop(page.image,box)).image);
      }
    } catch(error) {
      q.warnings.push(`配图裁切失败：${error instanceof Error?error.message:'无法读取原图区域'}，已保留文字并继续导出`);
      q.drawingDisposition='uncertain';
      drawingFailed=true;
    }
    if(evidence.length) {
      // A new drawing revision replaces the old overlay, never adds it twice.
      // Keep source pixels and provenance unchanged.
      const bases:StudioDiagram[]=q.diagrams.filter(d=>!!d.baseImage).map(d=>({...d,shapes:[],warnings:[],caption:''}));
      const context={answerOnly:!options.includeQuestionFigures&&next.inputMode==='answers',hasSourceDiagrams:answers.some(a=>a.diagramBoxes.length>0)};
      const result=await service.drawings(q,bases,evidence,context);
      if(studioDrawingMissing(q,bases,context,result))throw new Error('原件有配图，但未能确认是仅题目图或生成有效解答图');
      // Apply atomically, so a failed request can be retried without duplicate shapes.
      const diagrams=structuredClone(bases);
      for(const d of result.diagrams) {
        if(d.baseIndex===-1)diagrams.push({id:randomClientId(),caption:d.caption,baseImage:'',width:500,height:400,shapes:d.shapes,warnings:d.warnings});
        else {const base=diagrams[d.baseIndex];if(!base)throw new Error('配图底图关系无效');base.shapes.push(...d.shapes);base.warnings.push(...d.warnings);base.caption=d.caption;}
      }
      q.diagrams=diagrams;q.warnings.push(...result.warnings);
      q.drawingsOmittedQuestionFigures=studioMayOmitQuestionFigures(context,result);
      q.drawingDisposition=result.disposition;
    }
    q.warnings=[...new Set(q.warnings.filter(w=>w!=='尚未检查解答图与辅助线'&&w!=='仅答案材料：请确认未补写原件没有的步骤'))];
    q.drawingsChecked=!drawingFailed;q.drawingsRevision=STUDIO_DRAWINGS_REVISION;q.reviewed=false;
    q.drawingsIncludeQuestionFigures=!!options.includeQuestionFigures;
    return q;
  }
  const drawingIndexes=next.questions.map((_,i)=>i).filter(i=>!drawingReady(next.questions[i]));
  let drawingOffset=0;
  while(drawingOffset<drawingIndexes.length) {
    const batch=drawingIndexes.slice(drawingOffset,drawingOffset+drawingState.limit);
    drawingOffset+=batch.length;
    service.progress(`正在处理配图 ${drawingOffset-batch.length+1}—${drawingOffset}/${drawingIndexes.length} 题（最多 ${drawingState.limit} 路）…`);
    const results=await runStudioWindow(batch,index=>processDrawing(next.questions[index]),drawingState,reportRetry,options.retryRuntime);
    let fatal:unknown;
    for(const [position,index] of batch.entries()) {
      const result=results[position];
      if(result.status==='fulfilled')next.questions[index]=result.value;
      else {
        const q=next.questions[index],error=result.reason;
        q.warnings=[...new Set([...q.warnings,`配图处理失败：${error instanceof Error?error.message:'识别服务异常'}，已保留文字和原件，可再次生成重试`])];
        q.drawingsChecked=false;q.drawingDisposition='uncertain';q.reviewed=false;
        if(error instanceof StudioRequestError&&[401,403,429,503].includes(error.status))fatal=error;
      }
      // Serial writes only: never let an older snapshot overwrite a newer one.
      await save();
    }
    if(fatal)throw new Error(`配图服务暂时不可用：${fatal instanceof Error?fatal.message:'请求失败'}。已保留完成内容，请稍后重新生成，或先下载无图版本。`,{cause:fatal});
  }
  return next;
}
