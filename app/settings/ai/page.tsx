'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {fetchMe} from '../../../lib/api-client';
import type {AuthUser} from '../../../lib/types';
import {SiteHeader} from '../../components/SiteHeader';
import type {AiCenterPublic,AiRoutingConfig,ProviderConfig,ProviderDiagnostic,ProviderKind,ProviderWrite} from '../../../lib/ai-provider-types';
import {KIND_LABELS,newProvider} from '../../../lib/ai-provider-presets';
import {api,ConfirmDialog,providerDraft} from './_components/common';
import {ProviderEditor} from './_components/provider-editor';
import {ModelCatalog} from './_components/model-catalog';
import {TaskRouting} from './_components/task-routing';
import {ConnectionTestPanel} from './_components/connection-test-panel';
import css from './ai-center.module.css';
type Operation='save'|'model'|'discover'|'test'|'route'|'delete';
type Confirmation={title:string;message:string;accept:()=>void};
const endpoint='/api/admin/ai-providers';
export default function AiSettingsPage(){
 const [user,setUser]=useState<AuthUser|null|undefined>(undefined);
 const [data,setData]=useState<AiCenterPublic|null>(null),[selected,setSelected]=useState(''),[draft,setDraft]=useState<ProviderWrite|null>(null),[routing,setRouting]=useState<AiRoutingConfig|null>(null);
 const [view,setView]=useState<'providers'|'routing'>('providers'),[tab,setTab]=useState<'connection'|'models'|'diagnostics'>('connection'),[search,setSearch]=useState('');
 const [records,setRecords]=useState<ProviderDiagnostic[]>([]),[notice,setNotice]=useState(''),[error,setError]=useState(''),[field,setField]=useState<string>(),[confirm,setConfirm]=useState<Confirmation|null>(null);
 const [busy,setBusy]=useState<Partial<Record<Operation,boolean>>>({}),[modelDirty,setModelDirty]=useState(false),[modelEpoch,setModelEpoch]=useState(0);
 const controllers=useRef<Partial<Record<Operation,AbortController>>>({}),generation=useRef(0),root=useRef<HTMLElement>(null);
 const saved=data?.providers.find(p=>p.id===selected);
 const connectionDirty=Boolean(draft&&(!saved||JSON.stringify(draft)!==JSON.stringify(providerDraft(saved))));
 const routeDirty=Boolean(data&&routing&&JSON.stringify(data.routing)!==JSON.stringify(routing));
 const dirty=connectionDirty||routeDirty||modelDirty,working=Object.values(busy).some(Boolean);
 const report=useCallback((e:unknown)=>{const value=e as Error&{field?:string};setError(value.message||'操作未完成');setField(value.field);if(value.field)queueMicrotask(()=>{const target=root.current?.querySelector<HTMLElement>(`[name="${CSS.escape(value.field!)}"]`)||(value.field==='apiKey'?root.current?.querySelector<HTMLElement>('select[aria-label="密钥操作"]'):null);target?.focus();});},[]);
 useEffect(()=>{const controller=new AbortController();void fetchMe().then(result=>{if(!controller.signal.aborted)setUser(result.user);}).catch(()=>{if(!controller.signal.aborted)setUser(null);});api<AiCenterPublic>(endpoint,undefined,'GET',controller.signal).then(d=>{if(controller.signal.aborted)return;setData(d);setRouting(d.routing);if(d.providers[0]){setSelected(d.providers[0].id);setDraft(providerDraft(d.providers[0]));}}).catch(e=>{if(!controller.signal.aborted)report(e);});return()=>{controller.abort();Object.values(controllers.current).forEach(c=>c?.abort());};},[report]);
 useEffect(()=>{if(!dirty)return;const unload=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',unload);return()=>window.removeEventListener('beforeunload',unload);},[dirty]);
 useEffect(()=>{if(!saved||tab!=='diagnostics')return;const c=new AbortController();api<{diagnostics:ProviderDiagnostic[]}>(`${endpoint}/${saved.id}/diagnostics`,undefined,'GET',c.signal).then(r=>{if(!c.signal.aborted)setRecords(r.diagnostics);}).catch(e=>{if(!c.signal.aborted)report(e);});return()=>c.abort();},[saved,tab,report]);
 function cancelAll(){generation.current++;Object.values(controllers.current).forEach(c=>c?.abort());controllers.current={};setBusy({});}
 function resetDrafts(){setDraft(saved?providerDraft(saved):null);if(data)setRouting(data.routing);setModelDirty(false);setModelEpoch(v=>v+1);setError('');setField(undefined);}
 function move(action:()=>void){const go=()=>{cancelAll();resetDrafts();action();setNotice('');};if(dirty)setConfirm({title:'放弃未保存修改？',message:'当前编辑尚未保存。已保存的连接和密钥不会改变。',accept:go});else go();}
 function choose(id:string){const p=data?.providers.find(p=>p.id===id);move(()=>{setSelected(id);setDraft(p?providerDraft(p):null);setTab('connection');setRecords([]);});}
 function add(kind:ProviderKind='openai_compatible',copy?:ProviderConfig){move(()=>{setView('providers');setSelected('');setTab('connection');setDraft(copy?{...providerDraft(copy),name:`${copy.name} 副本`.slice(0,80),expectedRevision:0,enabled:false,credential:{action:'keep'}}:newProvider(kind));});}
 async function perform(kind:Operation,task:(signal:AbortSignal)=>Promise<unknown>,message:string,selectId?:()=>string):Promise<boolean>{
  controllers.current[kind]?.abort();const c=new AbortController();controllers.current[kind]=c;const epoch=generation.current;setBusy(v=>({...v,[kind]:true}));setError('');setField(undefined);setNotice('');
  try{await task(c.signal);if(c.signal.aborted||generation.current!==epoch)return false;const d=await api<AiCenterPublic>(endpoint,undefined,'GET',c.signal);if(c.signal.aborted||generation.current!==epoch)return false;setData(d);setRouting(d.routing);const id=selectId?.()??selected;const p=d.providers.find(p=>p.id===id);setSelected(id);setDraft(p?providerDraft(p):null);setNotice(message);return true;}
  catch(e){if(!c.signal.aborted&&generation.current===epoch)report(e);return false;}
  finally{if(generation.current===epoch&&controllers.current[kind]===c){delete controllers.current[kind];setBusy(v=>({...v,[kind]:false}));}}
 }
 function cancel(kind:Operation){controllers.current[kind]?.abort();setBusy(v=>({...v,[kind]:false}));setNotice('已取消；不会开始新的上游请求。已发送请求仍可能计费。');}
 function save(confirmed=false){if(!draft)return;if(saved?.referenceCount&&!draft.enabled&&!confirmed){setConfirm({title:'停用被引用的提供方？',message:`有 ${saved.referenceCount} 处引用此连接；停用将使相关任务不可用，不会自动改用列表第一项。`,accept:()=>save(true)});return;}let id=selected;void perform('save',async signal=>{const r=await api<{provider:ProviderConfig}>(id?`${endpoint}/${id}`:endpoint,{...draft,confirmDisable:confirmed},id?'PATCH':'POST',signal);id=r.provider.id;},'连接已保存。任务分配和模型测试需分别设置。',()=>id);}
 const providerPath=saved?`${endpoint}/${saved.id}`:'';
 const visible=data?.providers.filter(p=>`${p.name} ${p.baseUrl}`.toLowerCase().includes(search.toLowerCase()))||[];
 const selector=<label>当前提供方<select aria-label="当前提供方" value={selected} onChange={e=>choose(e.target.value)}><option value="">{draft?'新建连接':'选择提供方'}</option>{data?.providers.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>;
 return <><SiteHeader active="tools" user={user??null} loading={user===undefined} onSignOut={exit=>move(()=>{void exit();})}/><main className={css.root} ref={root}><div className={css.shell}>
 <header className={css.header}><div><p className={css.eyebrow}>AI / Provider center</p><h1>AI 配置中心</h1><p className={css.hint}>管理接入服务，明确每种任务的模型与数据去向。</p></div><div className={css.actions}>{data&&<span className={css.badge}>{data.encryptionReady?'密钥加密可用':'密钥加密未就绪'}</span>}{Boolean(data?.providers.length)&&<button data-primary disabled={working} onClick={()=>add()}>添加提供方</button>}</div></header>
 {error&&<div role="alert" className={css.warning}>{error}<div className={css.actions}><button onClick={()=>move(()=>{window.location.reload();})}>重新加载</button></div></div>}{notice&&<div role="status" className={css.notice}>{notice}</div>}
 {!data&&!error&&<p role="status">正在读取配置…</p>}
 {data&&!data.providers.length&&!draft?<section className={`${css.panel} ${css.empty}`}><h2>添加第一个提供方</h2><p>先保存连接，再选择模型与任务。不预设任何模型已可用。</p><button data-primary onClick={()=>add()}>添加第一个提供方</button></section>:data&&<><nav className={css.nav} aria-label="配置中心视图"><button aria-pressed={view==='providers'} onClick={()=>move(()=>setView('providers'))}>提供方</button><button aria-pressed={view==='routing'} onClick={()=>move(()=>setView('routing'))}>任务分配</button></nav>
 {view==='routing'&&routing?<div className={css.panel}><TaskRouting providers={data.providers} routing={routing} busy={working} change={setRouting}/></div>:<div className={css.grid}><aside className={css.sidebar}><label>搜索提供方<input type="search" value={search} onChange={e=>setSearch(e.target.value)}/></label><div className={css.list}>{visible.map(p=><button key={p.id} aria-pressed={p.id===selected} onClick={()=>choose(p.id)}><strong>{p.name}</strong><small>{KIND_LABELS[p.kind]} · {new URL(p.baseUrl).host}</small><small>{p.enabled?'允许使用':'已停用'} · {p.referenceCount} 处引用</small></button>)}</div><details><summary>环境变量配置 · 只读</summary><p className={css.hint}>{data.environmentFallback.configured?'存在环境凭据':'没有环境凭据'}；仅在路由允许且没有明确目标时使用。</p><code>{data.environmentFallback.baseUrl}</code></details></aside>
 <div><div className={css.mobile}>{selector}</div><div className={css.panel}>{draft?<><div className={css.toolbar}><div><h2>{saved?.name||'新建提供方'}</h2><span className={css.badge}>{connectionDirty?'未保存修改':saved?.referenceCount?'已保存 · 任务已引用':'已保存，尚未分配任务'}</span></div>{saved&&<details><summary>更多操作</summary><div className={css.actions}><button disabled={working} onClick={()=>add(saved.kind,saved)}>复制连接（无 Key）</button><button disabled={working} onClick={()=>setConfirm({title:'删除提供方？',message:'有任务、默认或备用引用时后端会拒绝删除。未引用的连接及其诊断将删除。',accept:()=>{void perform('delete',signal=>api(providerPath,{expectedRevision:saved.revision},'DELETE',signal),'提供方已删除。',()=>data.providers.find(p=>p.id!==saved.id)?.id||'');}})}>删除提供方</button></div></details>}</div>
 {!saved&&<div className={css.nav} aria-label="新建预设">{Object.entries(KIND_LABELS).map(([k,l])=><button key={k} onClick={()=>add(k as ProviderKind)}>{l}</button>)}</div>}
 <nav className={css.nav} aria-label="提供方详情">{([['connection','连接配置'],['models','模型目录'],['diagnostics','诊断']] as const).map(([v,l])=><button key={v} disabled={v!=='connection'&&!saved} aria-pressed={tab===v} onClick={()=>move(()=>setTab(v))}>{l}</button>)}</nav>
 {tab==='connection'&&<ProviderEditor key={selected||'new'} draft={draft} saved={saved} change={setDraft} disabled={working} fieldError={field}/>}
 {tab==='models'&&saved&&<ModelCatalog key={`${saved.id}:${modelEpoch}`} provider={saved} busy={working} discoverBusy={Boolean(busy.discover)} dirtyChange={setModelDirty} close={()=>move(()=>{})} discover={()=>{void perform('discover',signal=>api(`${providerPath}/models/discover`,{fingerprint:saved.fingerprint},'POST',signal),'目录已刷新；模型推理尚需单独测试。');}} cancel={()=>cancel('discover')} save={body=>perform('model',signal=>api(`${providerPath}/models`,{...(body as object),expectedRevision:saved.revision,expectedConfigurationRevision:data.routing.revision},'POST',signal),'模型已保存。')} remove={m=>setConfirm({title:'删除模型？',message:`删除 ${m.id}。仍被路由引用时将拒绝删除。`,accept:()=>{void perform('model',signal=>api(`${providerPath}/models`,{id:m.id,expectedRevision:saved.revision,expectedConfigurationRevision:data.routing.revision},'DELETE',signal),'模型已删除。');}})}/>}
 {tab==='diagnostics'&&saved&&<ConnectionTestPanel key={`${saved.id}:${saved.revision}`} provider={saved} records={records} busy={working} testBusy={Boolean(busy.test)} cancel={()=>cancel('test')} test={body=>{void perform('test',async signal=>{const r=await api<{result:{code:string;error?:string}}>(`${providerPath}/test`,{...(body as object),fingerprint:saved.fingerprint},'POST',signal);if(r.result.code!=='OK'){const failed=await api<{diagnostics:ProviderDiagnostic[]}>(`${providerPath}/diagnostics`,undefined,'GET',signal);if(!signal.aborted)setRecords(failed.diagnostics);throw new Error(r.result.error||r.result.code);}},'合成样本通过；不等于复杂题库质量验收。');}}/>}
 </>:<p className={css.empty}>选择一个提供方，或添加新连接。</p>}</div></div></div>}
 {((view==='providers'&&draft&&tab==='connection')||view==='routing')&&<footer className={css.savebar}><span>{view==='routing'?(routeDirty?'任务分配有未保存修改':'任务分配已保存'):(connectionDirty?'连接有未保存修改':'连接已保存')}</span><div className={css.actions}><button disabled={!dirty||working} onClick={()=>move(()=>{})}>放弃修改</button><button data-primary disabled={working||(view==='routing'?!routeDirty:!connectionDirty)} onClick={()=>view==='routing'?void perform('route',signal=>api('/api/admin/ai-routing',routing,'PUT',signal),'任务分配已保存。'):save()}>{working?'处理中…':view==='routing'?'保存任务分配':'保存配置'}</button>{busy.save&&<button onClick={()=>cancel('save')}>取消保存</button>}</div></footer>}
 </>}{confirm&&<ConfirmDialog title={confirm.title} accept={()=>{const action=confirm.accept;setConfirm(null);action();}} cancel={()=>setConfirm(null)}>{confirm.message}</ConfirmDialog>}
 </div></main></>;
}
