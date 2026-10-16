'use client';
import {useEffect,useId,useRef,useState} from 'react';
import type {AiRoutingConfig,AiTaskRole,ModelTarget,ProviderConfig} from '../../../../lib/ai-provider-types';
import css from '../ai-center.module.css';
const titles:Record<AiTaskRole,string>={recognition:'识题与转录',text:'解析与文字优化',diagram:'几何图重绘',grading:'作业批改'};
const descriptions:Record<AiTaskRole,string>={recognition:'截图、PDF、讲义和答案的识别与录入',text:'生成解析、润色题干与整理文字',diagram:'读取原题图片，重绘可编辑的几何图',grading:'识别学生作业，批改答案并生成反馈'};
const encode=(t:ModelTarget|null)=>t?JSON.stringify(t):'';

export function TaskRouting({routing,providers,change,busy,manageProviders}:{routing:AiRoutingConfig;providers:ProviderConfig[];change:(v:AiRoutingConfig)=>void;busy:boolean;manageProviders:()=>void}) {
 const [picker,setPicker]=useState(''),[query,setQuery]=useState(''),[cursor,setCursor]=useState(0);
 const prefix=useId(),triggers=useRef(new Map<string,HTMLButtonElement>());
 const pickerId=prefix+picker;
 useEffect(()=>{
  if(!picker)return;
  document.getElementById(`${pickerId}-search`)?.focus();
  const outside=(e:PointerEvent)=>{if(!document.getElementById(pickerId)?.contains(e.target as Node))setPicker('');};
  document.addEventListener('pointerdown',outside);
  return()=>document.removeEventListener('pointerdown',outside);
 },[picker,pickerId]);
 useEffect(()=>{if(picker)document.getElementById(`${pickerId}-option-${cursor}`)?.scrollIntoView({block:'nearest'});},[picker,pickerId,cursor]);
 const available=providers.filter(p=>p.enabled&&p.hasApiKey).flatMap(p=>p.models.map(m=>({target:{providerId:p.id,modelId:m.id},name:m.id,detail:m.displayName===m.id?p.name:`${p.name} · ${m.displayName}`})));
 function select(label:string,value:ModelTarget|null,update:(t:ModelTarget|null)=>void,empty='跟随通用默认') {
  const provider=providers.find(p=>p.id===value?.providerId),model=provider?.models.find(m=>m.id===value?.modelId);
  const invalid=Boolean(value&&(!provider?.enabled||!provider.hasApiKey||!model));
  const matches=available.filter(o=>`${o.name} ${o.detail}`.toLowerCase().includes(query.trim().toLowerCase())).sort((a,b)=>Number(encode(b.target)===encode(value))-Number(encode(a.target)===encode(value)));
  const options=[...(!query.trim()?[{target:null as ModelTarget|null,name:empty,detail:'清除此处的单独选择'}]:[]),...matches];
  const active=Math.min(cursor,options.length-1),open=picker===label,id=prefix+label;
  function pick(target:ModelTarget|null){update(target);setPicker('');triggers.current.get(label)?.focus();}
  function toggle(){setPicker(open?'':label);setQuery('');setCursor(0);}
  return <div className={css.picker} id={id} key={label} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget))setPicker(current=>current===label?'':current);}}>
   <span className={css.fieldLabel}>{label.includes('主目标')?'使用模型':label.includes('备用')?'备用模型':label}</span>
   <button ref={el=>{if(el)triggers.current.set(label,el);else triggers.current.delete(label);}} className={css.modelChoice} aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open?`${id}-list`:undefined} disabled={busy} onClick={toggle} onKeyDown={e=>{if(e.key==='ArrowDown'){e.preventDefault();if(!open)toggle();}if(e.key==='Escape')setPicker('');}}>
    <span><strong>{value?.modelId||empty}</strong><small>{value?`${provider?.name||'连接已不存在'}${invalid?' · 当前不可用':''}`:'可按任务单独指定'}</small></span><span aria-hidden="true">⌄</span>
   </button>
   {invalid&&<small className={css.invalid}>请启用连接、补充密钥或重新选择模型。</small>}
   {open&&<div className={css.modelPopover}>
    <input id={`${id}-search`} type="search" role="combobox" aria-label={`搜索${label}`} aria-expanded="true" aria-autocomplete="list" aria-controls={`${id}-list`} aria-activedescendant={active>=0?`${id}-option-${active}`:undefined} placeholder="搜索服务商或模型…" value={query} onChange={e=>{setQuery(e.target.value);setCursor(0);}} onKeyDown={e=>{
     if(e.key==='Escape'){e.preventDefault();setPicker('');triggers.current.get(label)?.focus();}
     if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();if(options.length)setCursor((active+(e.key==='ArrowDown'?1:-1)+options.length)%options.length);}
     if(e.key==='Enter'){e.preventDefault();if(active>=0)pick(options[active].target);}
    }}/>
    <div id={`${id}-list`} role="listbox" aria-label={`${label}候选模型`} className={css.modelOptions}>
     {options.map((o,i)=><button key={encode(o.target)} id={`${id}-option-${i}`} role="option" aria-selected={encode(o.target)===encode(value)} className={i===active?css.activeOption:undefined} tabIndex={-1} onMouseDown={e=>e.preventDefault()} onClick={()=>pick(o.target)}><span><strong>{o.name}</strong><small>{o.detail}</small></span>{encode(o.target)===encode(value)&&<span aria-hidden="true">✓</span>}</button>)}
     {!matches.length&&<p className={css.hint}>{query?'没有匹配模型。':'暂无可选模型，请先添加并启用连接，再获取模型。'}</p>}
    </div>
   </div>}
  </div>;
 }
 return <section aria-label="任务分配">
  <div className={css.toolbar}><div><h2>给题库选择模型</h2><p className={css.hint}>先选通用默认，需要时再为某项任务单独指定。</p></div><button className="secondary" disabled={busy} onClick={manageProviders}>管理连接与模型 →</button></div>
  {!available.length&&<p className={css.notice}>还没有可用模型。请到“提供方”添加连接并获取模型，然后回来分配。</p>}
  <fieldset disabled={busy}>
   <div className={css.defaults}>
    {select('默认文本模型',routing.defaultTextTarget,t=>change({...routing,defaultTextTarget:t}),'选择文本模型')}
    {select('默认图片模型',routing.defaultVisionTarget,t=>change({...routing,defaultVisionTarget:t}),'选择图片模型')}
   </div>
   <p className={css.hint}>包含图片的请求使用图片默认模型，纯文字请求使用文本默认模型。识题、几何图和作业批改通常需要图片能力。</p>
   <div className={css.routes}>{routing.routes.map(r=><article className={css.route} key={r.role}>
    <div className={css.toolbar}><h3>{titles[r.role]}</h3><span className={css.badge}>{r.primary?'单独指定':'跟随默认'}</span></div>
    <p className={css.hint}>{descriptions[r.role]}</p>
    {select(`${titles[r.role]}主目标`,r.primary,t=>change({...routing,routes:routing.routes.map(x=>x.role===r.role?{...x,primary:t}:x)}))}
    <details className={css.backup}><summary>备用模型 <span className={css.hint}>{r.fallbackEnabled?'已启用':'未启用'}</span></summary>
     {select(`${titles[r.role]}备用`,r.fallback,t=>change({...routing,routes:routing.routes.map(x=>x.role===r.role?{...x,fallback:t}:x)}),'选择备用模型')}
     <label className={css.check}><input type="checkbox" checked={r.fallbackEnabled} onChange={e=>change({...routing,routes:routing.routes.map(x=>x.role===r.role?{...x,fallbackEnabled:e.target.checked}:x)})}/>启用备用，并允许向其发送题目与图片</label>
     <p className={css.hint}>部分服务失败或返回空内容时尝试备用，可能额外计费。鉴权、限流和不确定的网络失败不会切换。</p>
    </details>
   </article>)}</div>
   <details><summary>服务器环境配置</summary><label className={css.check}><input type="checkbox" checked={routing.allowEnvironmentFallback} onChange={e=>change({...routing,allowEnvironmentFallback:e.target.checked})}/>没有指定模型和通用默认时，使用服务器环境配置</label><p className={css.hint}>已指定但不可用的连接会报错，请在上方重新选择。</p></details>
  </fieldset>
 </section>;
}
