'use client';
import {useState} from 'react';
import type {ProviderConfig,ProviderWrite,WireProtocol,EndpointProfile} from '../../../../lib/ai-provider-types';
import {KIND_LABELS,PROTOCOL_LABELS,PROVIDER_PRESETS,newProvider,credentialScope,providerEndpoint,SUB2API_MODES,sub2ApiMode,suggestedSub2ApiBase,withSub2ApiMode} from '../../../../lib/ai-provider-presets';
import css from '../ai-center.module.css';

export function ProviderEditor({draft,saved,change,disabled,fieldError}:{draft:ProviderWrite;saved?:ProviderConfig;change:(p:ProviderWrite)=>void;disabled:boolean;fieldError?:string}) {
  const [show,setShow]=useState(false);
  const mode=sub2ApiMode(draft.wireApi);
  const key=draft.credential.action==='replace'?draft.credential.value:'';
  let changed=false,suggestion='';
  try {changed=Boolean(saved?.hasApiKey&&credentialScope(saved.baseUrl,saved.endpoints)!==credentialScope(draft.baseUrl,draft.endpoints));} catch {changed=Boolean(saved?.hasApiKey);}
  try {suggestion=suggestedSub2ApiBase(draft.baseUrl,mode);} catch { /* Wait for a valid address. */ }
  function path(name:keyof Omit<EndpointProfile,'auth'>){try{return providerEndpoint(draft.baseUrl,draft.endpoints[name],'{model}')?.replace('%7Bmodel%7D','{model}')||'不获取目录，手动添加模型';}catch{return '请填写有效地址';}}
  const preset=Object.entries(PROVIDER_PRESETS).find(([,p])=>p.kind===draft.kind&&p.baseUrl===draft.baseUrl&&p.wireApi===draft.wireApi)?.[0]||(draft.kind==='sub2api'?'sub2api':'custom');
  return <section aria-label="连接配置"><fieldset disabled={disabled}>
    {!saved&&<label>服务商预设<select aria-label="服务商预设" value={preset} onChange={e=>change({...newProvider(e.target.value as keyof typeof PROVIDER_PRESETS),enabled:draft.enabled,credential:{action:'keep'}})}>{Object.entries(PROVIDER_PRESETS).map(([id,p])=><option key={id} value={id}>{p.name}</option>)}</select><small>选好服务商，地址和协议会自动填入。中转网关填写自己的接口地址。</small></label>}
    <label>名称<input name="name" maxLength={80} value={draft.name} onChange={e=>change({...draft,name:e.target.value})} placeholder="给这个连接起一个容易辨认的名字"/></label>
    <label>API 地址<input aria-label="API 地址" name="baseUrl" aria-invalid={fieldError==='baseUrl'} autoComplete="off" placeholder="https://你的网关/v1" value={draft.baseUrl} onChange={e=>change({...draft,baseUrl:e.target.value})}/><small>填写服务商给出的完整基础地址，保留 /v1 等前缀。</small></label>
    {draft.kind==='sub2api'&&<div><label>Sub2API 接口格式<select aria-label="Sub2API 接口格式" value={mode} onChange={e=>change(withSub2ApiMode(draft,e.target.value as keyof typeof SUB2API_MODES))}>{Object.entries(SUB2API_MODES).map(([v,m])=><option key={v} value={v}>{m.label}</option>)}</select></label>{suggestion&&suggestion!==draft.baseUrl&&<div className={css.endpoints}><small>此格式的常用地址</small><code>{suggestion}</code><button className="secondary" type="button" onClick={()=>change({...draft,baseUrl:suggestion,credential:{action:'replace',value:''}})}>采用建议地址</button></div>}</div>}
    <label>API Key<div className={css.keyInput}><input aria-label="API Key" name="apiKey" aria-invalid={fieldError==='apiKey'} autoComplete="new-password" type={show?'text':'password'} value={key} placeholder={saved?.hasApiKey?'已保存密钥；留空保留，输入新 Key 可替换':'粘贴 API Key'} onChange={e=>change({...draft,credential:e.target.value?{action:'replace',value:e.target.value}:{action:'keep'}})}/><button className="secondary" type="button" aria-label={show?'隐藏 API Key':'显示 API Key'} title={show?'隐藏 API Key':'显示 API Key'} onClick={()=>setShow(!show)}>{show?'隐藏':'显示'}</button></div><small>{draft.credential.action==='clear'?'保存后将清除密钥并停用此连接。':saved?.hasApiKey?'密钥已加密保存，页面不会读取原值。':'密钥将在服务器端加密保存。'}</small></label>
    {changed&&<p className={css.warning}>连接地址或认证方式已变化，请填写新地址对应的 API Key 后保存。</p>}
    <label className={css.check}><input type="checkbox" checked={draft.enabled} onChange={e=>change({...draft,enabled:e.target.checked})}/>启用此连接</label>
    <details><summary>高级设置 <span className={css.hint}>协议、超时与接口路径</span></summary>
      <div className={css.fields}>
        <label>接入类型<select aria-label="接入类型" value={draft.kind} onChange={e=>change({...draft,kind:e.target.value as ProviderWrite['kind']})}>{Object.entries(KIND_LABELS).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
        <label>API 协议<select aria-label="API 协议" name="wireApi" value={draft.wireApi} onChange={e=>change({...draft,wireApi:e.target.value as WireProtocol})}>{Object.entries(PROTOCOL_LABELS).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
        <label>请求超时（毫秒）<input name="timeoutMs" type="number" min={1000} max={600000} value={draft.timeoutMs} onChange={e=>change({...draft,timeoutMs:Number(e.target.value)})}/></label>
        <label>目录超时（毫秒）<input name="catalogTimeoutMs" type="number" min={1000} max={60000} value={draft.catalogTimeoutMs} onChange={e=>change({...draft,catalogTimeoutMs:Number(e.target.value)})}/></label>
        <label>结构化输出<select aria-label="结构化输出" value={draft.outputStrategy} onChange={e=>change({...draft,outputStrategy:e.target.value as ProviderWrite['outputStrategy']})}><option value="auto">自动选择</option><option value="schema">Schema</option><option value="json">JSON mode</option><option value="prompt">格式提示 + 本地校验</option></select></label>
        <label>默认思考档位<input name="reasoningEffort" maxLength={40} value={draft.reasoningEffort} onChange={e=>change({...draft,reasoningEffort:e.target.value})} placeholder="通常留空，按模型单独设置"/></label>
        <label>认证方案<select aria-label="认证方案" value={draft.endpoints.auth} onChange={e=>change({...draft,endpoints:{...draft.endpoints,auth:e.target.value as EndpointProfile['auth']}})}><option value="bearer">Bearer</option><option value="x-api-key">x-api-key</option><option value="x-goog-api-key">x-goog-api-key</option></select></label>
        {(['models','responses','chat','gemini','messages'] as const).map(n=><label key={n}>{n} 相对路径<input name={n} value={draft.endpoints[n]||''} onChange={e=>change({...draft,endpoints:{...draft.endpoints,[n]:n==='models'&&!e.target.value?null:e.target.value}})}/></label>)}
      </div>
      <div className={css.endpoints} aria-label="实际端点预览"><small>实际请求地址</small><code>目录：{path('models')}</code>{(draft.wireApi==='auto'?['responses','chat_completions']:[draft.wireApi]).map(p=><code key={p}>{PROTOCOL_LABELS[p as WireProtocol]}：{path(p==='responses'?'responses':p==='chat_completions'?'chat':p==='gemini_generate_content'?'gemini':'messages')}</code>)}</div>
      <p className={css.hint}>地址按原样使用，不自动添加 /v1。没有模型目录的服务可将 models 留空，再手动添加模型。</p>
      {saved?.hasApiKey&&<button className="danger-text" type="button" onClick={()=>change({...draft,enabled:false,credential:{action:'clear'}})}>清除密钥并停用</button>}
    </details>
  </fieldset></section>;
}
