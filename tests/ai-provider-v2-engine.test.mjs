import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSource} from './load-source.mjs';
import {sqliteD1} from './helpers/ai-v2-sqlite.mjs';
const schema={type:'object',properties:{ok:{type:'boolean',const:true}},required:['ok'],additionalProperties:false};
const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVQIHWP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
async function setup(protocol='responses',kind='custom'){
 const db=sqliteD1(),bindings={DB:db,LOCAL_ADMIN_MODE:'true',AI_PROVIDER_ENCRYPTION_KEY:'unit-synthetic-encryption'};
 const repo=await loadSource('lib/server/ai/provider-repository.ts',bindings),presets=await loadSource('lib/ai-provider-presets.ts'),engine=await loadSource('lib/server/ai/engine.ts',bindings);
 const p=await repo.saveProvider(null,{...presets.newProvider(kind),name:'Fixture',baseUrl:'https://fixture.invalid/tenant',wireApi:protocol,credential:{action:'replace',value:'synthetic-unit-credential'},enabled:true});
 await repo.saveManualModel(p.id,{id:'Case/Alias',expectedRevision:1,expectedConfigurationRevision:(await repo.readCenter()).routing.revision,capabilities:{text:'supported',vision:'supported',structured:'supported'}});
 const state=await repo.readCenter(),provider=state.providers[0],runtime={provider,model:provider.models[0],key:'synthetic-unit-credential'};
 return {db,bindings,repo,engine,presets,runtime,input:{role:'text',prompt:'Synthetic JSON test',schema,schemaName:'unit_probe',timeoutMs:2000}};
}
const json=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json',...headers}});
const good=(protocol='responses',text='{"ok":true}')=>protocol==='responses'?{status:'completed',output:[{type:'reasoning',summary:[],content:[{type:'output_text',text:'PRIVATE REASONING NOT JSON'}]},{type:'message',status:'completed',content:[{type:'output_text',text}]}]}:protocol==='chat_completions'?{choices:[{finish_reason:'stop',message:{content:text,reasoning_content:'PRIVATE REASONING NOT JSON'}}]}:protocol==='gemini_generate_content'?{candidates:[{finishReason:'STOP',content:{parts:[{thought:true,text:'PRIVATE REASONING'},{text}]}}]}:{stop_reason:'end_turn',content:[{type:'thinking',thinking:'PRIVATE REASONING'},{type:'text',text}]};
async function mocked(fn,work){const previous=globalThis.fetch,calls=[];globalThis.fetch=async(url,options)=>{const call={url:String(url),body:JSON.parse(options?.body||'{}'),headers:options?.headers,signal:options?.signal};calls.push(call);return fn(call,calls.length);};try{return {result:await work(),calls};}finally{globalThis.fetch=previous;}}
for(const protocol of ['responses','chat_completions','gemini_generate_content','anthropic_messages'])test(`${protocol}: actual wire image format, alias, final-only output and local schema validation`,async()=>{
 const m=await setup(protocol);const {result,calls}=await mocked(()=>json(good(protocol)),()=>m.engine.executeTargets(m.runtime,null,{...m.input,images:[image]}));
 assert.equal(result.code,'OK');assert.equal(result.text,'{"ok":true}');assert.equal(calls.length,1);assert.ok(!result.text.includes('REASONING'));assert.equal(calls[0].headers.Authorization,'Bearer synthetic-unit-credential');
 const b=calls[0].body;if(protocol==='responses')assert.equal(b.input[0].content[1].type,'input_image');
 if(protocol==='chat_completions')assert.equal(b.messages[0].content[1].type,'image_url');
 if(protocol==='gemini_generate_content'){assert.ok(calls[0].url.endsWith('/models/Case%2FAlias:generateContent'));assert.equal(b.contents[0].parts[1].inlineData.mimeType,'image/png');}
 if(protocol==='anthropic_messages'){assert.equal(b.messages[0].content[1].source.media_type,'image/png');assert.equal(calls[0].headers['anthropic-version'],'2023-06-01');}
});
test('DeepSeek Chat sends json_object/thinking/max_tokens, Responses uses its own text.format contract',async()=>{
 for(const protocol of ['chat_completions','responses']){
  const m=await setup(protocol,'deepseek');m.runtime.provider.outputStrategy='schema';m.runtime.provider.reasoningEffort='high';m.runtime.model.metadata.effortLevels=['low','high'];
  const {calls,result}=await mocked(()=>json(good(protocol)),()=>m.engine.executeTargets(m.runtime,null,m.input));assert.equal(result.code,'OK');const b=calls[0].body;
  if(protocol==='chat_completions'){assert.deepEqual(b.response_format,{type:'json_object'});assert.deepEqual(b.thinking,{type:'enabled'});assert.equal(b.reasoning_effort,'high');assert.ok(b.max_tokens);assert.ok(!('max_completion_tokens' in b));}
  else {assert.equal(b.text.format.type,'json_schema');assert.ok(!('strict' in b.text.format));assert.ok(!('store' in b));assert.deepEqual(b.reasoning,{effort:'high'});}
 }
});
for(const [name,payload,status,expected] of [
 ['auth',{error:{message:'synthetic-unit-credential',code:'auth_error'}},401,'UPSTREAM_AUTH_FAILED'],
 ['forbidden',{error:{message:'forbidden'}},403,'UPSTREAM_AUTH_FAILED'],
 ['quota',{error:{code:'insufficient_quota'}},400,'UPSTREAM_QUOTA'],
 ['model',{error:{code:'model_not_found'}},404,'MODEL_NOT_FOUND'],
 ['Gemini resource missing',{error:{code:404,status:'NOT_FOUND',message:'Requested entity was not found.'}},404,'UPSTREAM_NOT_FOUND'],
 ['Gemini model missing',{error:{code:404,status:'NOT_FOUND',message:'Model not found'}},404,'MODEL_NOT_FOUND'],
 ['rate',{error:{message:'limited'}},429,'UPSTREAM_RATE_LIMITED'],
 ['invalid schema',{error:{message:'Invalid schema: required is missing'}},400,'UPSTREAM_REJECTED'],
 ['refusal',{output:[{type:'message',content:[{type:'refusal',refusal:'no'}]}]},200,'OUTPUT_INCOMPLETE'],
 ['truncated',{status:'incomplete',output_text:'{"ok":true}'},200,'OUTPUT_INCOMPLETE'],
 ['wrong field',good('responses','{"bad":true}'),200,'OUTPUT_INVALID'],
 ['extra field',good('responses','{"ok":true,"extra":1}'),200,'OUTPUT_INVALID'],
 ['wrong type',good('responses','{"ok":"true"}'),200,'OUTPUT_INVALID'],
 ['malformed output',good('responses','{oops'),200,'OUTPUT_INVALID'],
])test(`${name} terminates without hidden protocol/fallback retry`,async()=>{
 const m=await setup('auto'),backup={...m.runtime,provider:{...m.runtime.provider,id:'backup'}};
 const {result,calls}=await mocked(()=>json(payload,status),()=>m.engine.executeTargets(m.runtime,backup,m.input));assert.equal(result.code,expected);assert.equal(calls.length,1);assert.ok(!JSON.stringify(result).includes(m.runtime.key));
});
test('Retry-After stops even service failure from triggering explicit backup',async()=>{const m=await setup();const {result,calls}=await mocked(()=>json({error:{}},503,{'retry-after':'120'}),()=>m.engine.executeTargets(m.runtime,m.runtime,m.input));assert.equal(result.retryAfter,'120');assert.equal(calls.length,1);});
test('unsupported optional parameter + protocol + explicit backup share exactly three attempts',async()=>{
 const m=await setup('auto');m.runtime.provider.reasoningEffort='high';const backup={...m.runtime,provider:{...m.runtime.provider,id:'backup'}};
 const {result,calls}=await mocked((_,n)=>n===1?json({error:{message:'Unsupported parameter reasoning',param:'reasoning'}},400):n===2?json({error:{message:'Endpoint unsupported'}},404):json({error:{}},503),()=>m.engine.executeTargets(m.runtime,backup,m.input));
 assert.equal(calls.length,3);assert.equal(result.attempts,3);assert.equal(result.fallbackUsed,false);assert.ok(calls[0].body.reasoning);assert.ok(!calls[1].body.reasoning);assert.ok(calls[2].url.endsWith('/chat/completions'));
});
test('explicit backup only on eligible failure, then no request after valid output',async()=>{const m=await setup();const backup={...m.runtime,provider:{...m.runtime.provider,id:'backup',baseUrl:'https://fixture.invalid/backup'}};const {result,calls}=await mocked((_,n)=>n===1?json({error:{}},503):json(good()),()=>m.engine.executeTargets(m.runtime,backup,m.input));assert.equal(result.code,'OK');assert.equal(result.fallbackUsed,true);assert.equal(calls.length,2);assert.ok(calls[1].url.includes('/backup/'));});
test('HTML, SSE and credential echo never become successful or leaked output',async()=>{
 for(const response of [new Response('<html>oops</html>'),new Response('data: {"ok":true}\n\n',{headers:{'content-type':'text/event-stream'}}),json(good('responses','{"ok":true,"echo":"synthetic-unit-credential"}'))]){
 const m=await setup();const {result,calls}=await mocked(()=>response,()=>m.engine.executeTargets(m.runtime,null,m.input));assert.equal(result.code,'UPSTREAM_INVALID_RESPONSE');assert.equal(calls.length,1);assert.ok(!JSON.stringify(result).includes(m.runtime.key));}
});
test('empty 200 is a failure, not catalog-like green status',async()=>{const m=await setup();const {result,calls}=await mocked(()=>json({output:[]}),()=>m.engine.executeTargets(m.runtime,null,m.input));assert.equal(result.code,'OUTPUT_EMPTY');assert.equal(calls.length,1);});
test('redirect and uncertain transport never retry or leak raw errors',async()=>{for(const outcome of ['redirect','throw']){const m=await setup('auto');const {result,calls}=await mocked(()=>{if(outcome==='throw')throw Error(m.runtime.key);return new Response('',{status:302,headers:{Location:'https://other.invalid'}});},()=>m.engine.executeTargets(m.runtime,m.runtime,m.input));assert.equal(result.code,'UPSTREAM_TRANSPORT');assert.equal(calls.length,1);assert.ok(!JSON.stringify(result).includes(m.runtime.key));}});
test('cancel before start and during first request never start a later request',async()=>{
 const m=await setup('auto'),controller=new AbortController();controller.abort();const {calls}=await mocked(()=>json(good()),()=>assert.rejects(()=>m.engine.executeTargets(m.runtime,m.runtime,{...m.input,signal:controller.signal}),e=>e.name==='AbortError'));assert.equal(calls.length,0);
 const c=new AbortController();const next=await mocked(()=>{c.abort();return json({error:{}},503);},()=>assert.rejects(()=>m.engine.executeTargets(m.runtime,m.runtime,{...m.input,signal:c.signal}),e=>e.name==='AbortError'));assert.equal(next.calls.length,1);
});
test('deadline is bounded across request body reading and no uncertain backup',async()=>{const m=await setup();m.runtime.provider.timeoutMs=1000;const {result,calls}=await mocked(call=>new Promise((_,reject)=>call.signal.addEventListener('abort',()=>reject(call.signal.reason))),()=>m.engine.executeTargets(m.runtime,m.runtime,m.input));assert.equal(result.code,'UPSTREAM_TIMEOUT');assert.equal(calls.length,1);});
test('four roles and default modality are independent; broken explicit routes fail before fetch',async()=>{
 const m=await setup();const routing=await loadSource('lib/server/ai/routing.ts',m.bindings);const state=await m.repo.readCenter(),t={providerId:m.runtime.provider.id,modelId:m.runtime.model.id};
 state.routing.defaultTextTarget=t;state.routing.defaultVisionTarget=null;state.routing.allowEnvironmentFallback=false;
 assert.equal((await routing.resolveRoute(state,'text',false)).primary.model.id,t.modelId);assert.equal((await routing.resolveRoute(state,'text',true)).primary,null);
 state.routing.routes.find(r=>r.role==='diagram').primary=t;assert.equal((await routing.resolveRoute(state,'diagram',true)).primary.model.id,t.modelId);
 state.providers[0].enabled=false;await assert.rejects(()=>routing.resolveRoute(state,'diagram',true),e=>e.code==='ROUTE_UNAVAILABLE');
 state.providers[0].enabled=true;state.providers[0].models[0].capabilities.vision.state='unsupported';assert.equal((await routing.resolveRoute(state,'diagram',true)).primary.model.id,t.modelId);
});
test('probe budget is one; queue retry policy separates outer delivery attempts',async()=>{
 const m=await setup('auto');const {calls}=await mocked(()=>json({error:{message:'Endpoint unsupported'}},404),()=>m.engine.executeTargets(m.runtime,null,m.input,{maxAttempts:1}));assert.equal(calls.length,1);
 const {AiQueueFailure,queueRetryDelay}=await loadSource('lib/server/ai/queue-policy.ts');assert.equal(queueRetryDelay(new AiQueueFailure({code:'OUTPUT_INVALID',status:422}),1,4,30),null);assert.equal(queueRetryDelay(new AiQueueFailure({code:'UPSTREAM_TIMEOUT',status:504}),1,4,30),null);assert.equal(queueRetryDelay(new AiQueueFailure({code:'UPSTREAM_RATE_LIMITED',status:429,retryAfter:'120'}),1,4,30),120);assert.equal(queueRetryDelay(new AiQueueFailure({code:'UPSTREAM_FAILED',status:503}),4,4,30),null);
});

// Server-only probe postconditions must reject a guessed but schema-valid answer.
test('server postcondition failure never marks a probe successful or triggers a backup',async()=>{const m=await setup();const {result,calls}=await mocked(()=>json(good()),()=>m.engine.executeTargets(m.runtime,m.runtime,{...m.input,validateOutput:()=>false}));assert.equal(result.code,'OUTPUT_INVALID');assert.equal(calls.length,1);});

test('legacy compatible Chat token limit negotiation preserves the cap and shared budget',async()=>{const m=await setup('chat_completions');const {result,calls}=await mocked((_,n)=>n===1?json({error:{message:'Unsupported parameter max_completion_tokens'}},400):json(good('chat_completions')),()=>m.engine.executeTargets(m.runtime,null,m.input));assert.equal(result.code,'OK');assert.equal(calls.length,2);assert.equal(calls[0].body.max_completion_tokens,32768);assert.equal(calls[1].body.max_tokens,32768);assert.equal('max_completion_tokens' in calls[1].body,false);});
test('non-JSON 429 retains rate classification and never rotates providers',async()=>{const m=await setup();const {result,calls}=await mocked(()=>new Response('<html>limited</html>',{status:429,headers:{'retry-after':'120'}}),()=>m.engine.executeTargets(m.runtime,m.runtime,m.input));assert.equal(result.code,'UPSTREAM_RATE_LIMITED');assert.equal(result.retryAfter,'120');assert.equal(calls.length,1);});

test('Sub2API JSON resource errors with SSE headers preserve classification without retries',async()=>{
 const m=await setup('auto');
 const {result,calls}=await mocked(()=>json({error:{code:404,status:'NOT_FOUND',message:'Requested entity was not found.'}},404,{'content-type':'text/event-stream'}),()=>m.engine.executeTargets(m.runtime,m.runtime,m.input));
 assert.equal(result.code,'UPSTREAM_NOT_FOUND');assert.equal(result.status,404);assert.equal(calls.length,1);
});


test('Gemini auto with missing metadata sends the full Studio schema; explicit preferences remain authoritative',async()=>{
 const {studioRecognitionSchema}=await loadSource('lib/answer-studio-contract.ts');
 for(const [strategy,advertised,wantsSchema] of [['auto',undefined,true],['auto',false,false],['json',undefined,false],['prompt',undefined,false]]){
  const m=await setup('gemini_generate_content');m.runtime.provider.outputStrategy=strategy;m.runtime.model.metadata.apiCapabilities={};
  if(advertised!==undefined)m.runtime.model.metadata.apiCapabilities.structured_outputs=advertised;
  const {calls,result}=await mocked(()=>json(good('gemini_generate_content','{"records":[]}')),()=>m.engine.executeTargets(m.runtime,null,{...m.input,schema:studioRecognitionSchema}));
  assert.equal(result.code,'OK');assert.equal(calls.length,1);
  const config=calls[0].body.generationConfig;assert.equal(Boolean(config.responseSchema),wantsSchema);
  if(wantsSchema){assert.deepEqual(config.responseSchema.properties.records.items.required,studioRecognitionSchema.properties.records.items.required);assert.equal(config.responseMimeType,'application/json');}
 }
});
test('Gemini negotiates schema only after explicit unsupported rejection, keeping local validation',async()=>{
 const m=await setup('gemini_generate_content');m.runtime.model.metadata.apiCapabilities={};
 const {calls,result}=await mocked((_,n)=>n===1?json({error:{message:'Unsupported parameter responseSchema'}},400):json(good('gemini_generate_content','{"ok":"true"}')),()=>m.engine.executeTargets(m.runtime,m.runtime,m.input));
 assert.equal(calls.length,2);assert.ok(calls[0].body.generationConfig.responseSchema);assert.equal(calls[1].body.generationConfig.responseSchema,undefined);assert.equal(calls[1].body.generationConfig.responseMimeType,'application/json');assert.equal(result.code,'OUTPUT_INVALID');assert.match(result.error,/\$\.ok/);
});
test('output diagnostics distinguish syntax from nested schema failures without exposing model data',async()=>{
 const {studioRecognitionSchema}=await loadSource('lib/answer-studio-contract.ts');
 for(const [text,expected] of [['{private-material',/有效 JSON/],['{"records":[{}]}',/\$\.records\[0\]\.lesson.*缺少必填字段/],['{"records":"private-material"}',/\$\.records.*array/],['{"records":[],"private-material":true}',/未定义字段/]]){
  const m=await setup();const {calls,result}=await mocked(()=>json(good('responses',text)),()=>m.engine.executeTargets(m.runtime,m.runtime,{...m.input,schema:studioRecognitionSchema}));
  assert.equal(result.code,'OUTPUT_INVALID');assert.match(result.error,expected);assert.ok(!result.error.includes('private-material'));assert.equal(calls.length,1);
 }
});

test('throwing output postconditions remain terminal validation failures without leaking the exception',async()=>{
 const m=await setup();const {result,calls}=await mocked(()=>json(good()),()=>m.engine.executeTargets(m.runtime,m.runtime,{...m.input,validateOutput:()=>{throw Error('private-material');}}));
 assert.equal(result.code,'OUTPUT_INVALID');assert.match(result.error,/业务校验/);assert.ok(!result.error.includes('private-material'));assert.equal(calls.length,1);
});
