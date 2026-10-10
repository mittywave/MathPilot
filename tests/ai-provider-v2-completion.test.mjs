import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadSource } from './load-source.mjs';
import { sqliteD1 } from './helpers/ai-v2-sqlite.mjs';
import { localD1Rows } from './helpers/local-d1-observer.mjs';

for (const [mode, protocol, suffix] of [
  ['openai', 'auto', '/v1'],
  ['antigravity_gemini', 'gemini_generate_content', '/antigravity/v1beta'],
  ['antigravity_claude', 'anthropic_messages', '/antigravity/v1'],
]) test(`Sub2API ${mode}: explicit presets preserve tenant URL and protect entered credentials`, async () => {
  const p = await loadSource('lib/ai-provider-presets.ts');
  const draft = {...p.newProvider('sub2api'), baseUrl:'https://gateway.invalid/tenant/custom', credential:{action:'replace',value:'synthetic-draft-key'}};
  const updated = p.withSub2ApiMode(draft, mode);
  assert.equal(updated.baseUrl, draft.baseUrl);
  assert.equal(updated.wireApi, protocol);
  assert.equal(p.suggestedSub2ApiBase('https://gateway.invalid/tenant/v1/', mode), 'https://gateway.invalid/tenant'+suffix);
  assert.equal(p.suggestedSub2ApiBase('https://gateway.invalid/tenant/antigravity/v1beta', mode), 'https://gateway.invalid/tenant'+suffix);
  if (mode === 'antigravity_claude') { assert.equal(updated.endpoints.models, null); assert.equal(updated.credential.value, ''); }
  assert.equal(draft.credential.value, 'synthetic-draft-key');
  const custom = p.withSub2ApiMode({...draft,endpoints:{...draft.endpoints,models:'tenant-catalog'}},mode);
  assert.equal(custom.endpoints.models, 'tenant-catalog');
});

test('custom public HTTPS providers work immediately without a server allowlist', async () => {
  const {assertTrustedDestination} = await loadSource('lib/server/ai/endpoint-policy.ts', {LOCAL_ADMIN_MODE:'false'});
  assert.equal(assertTrustedDestination('https://gateway.example.com/tenant/v1'), 'https://gateway.example.com/tenant/v1');
  assert.equal(assertTrustedDestination('https://another-provider.example/api'), 'https://another-provider.example/api');
  assert.throws(() => assertTrustedDestination('http://gateway.example.com/v1'), error => error.code === 'DESTINATION_NOT_ALLOWED');
  assert.throws(() => assertTrustedDestination('https://127.0.0.1/v1'), error => error.code === 'DESTINATION_NOT_ALLOWED');
  assert.throws(() => assertTrustedDestination('https://10.20.30.40/v1'), error => error.code === 'DESTINATION_NOT_ALLOWED');
  assert.throws(() => assertTrustedDestination('https://metadata.google.internal/v1'), error => error.code === 'DESTINATION_NOT_ALLOWED');
});

test('DeepSeek Responses has an explicit field allowlist, not inherited OpenAI options', async () => {
  const {deepSeekBody} = await loadSource('lib/server/ai/adapters/deepseek.ts');
  const ctx = { provider:{reasoningEffort:'max'}, model:{id:'Dynamic-ID'}, input:{prompt:'p',schema:{type:'object'},schemaName:'s',images:['data:image/png;base64,AA=='],maxTokens:123}, options:{format:'schema',reasoning:true,effort:'high'}};
  const body = deepSeekBody('responses',ctx);
  assert.deepEqual(Object.keys(body).sort(), ['model','stream','input','max_output_tokens','text','reasoning'].sort());
  assert.deepEqual(body.reasoning,{effort:'high'});
  assert.deepEqual(body.text,{format:{type:'json_schema',name:'s',schema:{type:'object'}}});
  assert.deepEqual(body.input[0].content[1],{type:'input_image',image_url:ctx.input.images[0]});
  assert.equal(body.max_output_tokens,123);
  const chat = deepSeekBody('chat_completions',{...ctx,options:{...ctx.options,effort:'none'}});
  assert.deepEqual(chat.thinking,{type:'disabled'});assert.equal('reasoning_effort' in chat,false);
  assert.deepEqual(chat.response_format,{type:'json_object'});assert.equal(chat.max_tokens,123);
  assert.equal('store' in body,false);assert.equal('strict' in body.text.format,false);
});

test('effort is resolved for the actual model and wire, including official aliases', async () => {
  const {modelReasoningEffort:r} = await loadSource('lib/server/ai/model-options.ts');
  const p={kind:'deepseek',reasoningEffort:'high'};
  const a={id:'A',metadata:{effortLevels:['low','high']}};
  const b={id:'B',metadata:{effortLevels:['low']}};
  assert.equal(r(p,a,'responses'),'high');assert.equal(r(p,b,'responses'),'');
  assert.equal(r(p,{id:'Unknown',metadata:{}},'responses'),'');
  assert.equal(r(p,a,'gemini_generate_content'),'');assert.equal(r(p,a,'anthropic_messages'),'');
  assert.equal(r(p,{...a,metadata:{...a.metadata,reasoningEffort:''}},'responses'),'');
  assert.equal(r(p,{...a,metadata:{...a.metadata,reasoningEffort:'medium'}},'responses'),'high');
  assert.throws(()=>r(p,{...b,metadata:{...b.metadata,reasoningEffort:'max'}},'responses'),e=>e.code==='CAPABILITY_MISMATCH');
  assert.equal(r(p,{...b,metadata:{...b.metadata,reasoningEffort:'none'}},'chat_completions'),'none');
});

async function repository() {
  const db=sqliteD1();
  const env={DB:db,LOCAL_ADMIN_MODE:'true',AI_PROVIDER_ENCRYPTION_KEY:'synthetic-completion-key'};
  const repo=await loadSource('lib/server/ai/provider-repository.ts',env);
  const presets=await loadSource('lib/ai-provider-presets.ts');
  const capabilities=await loadSource('lib/server/ai/capabilities.ts');
  const options=await loadSource('lib/server/ai/model-options.ts');
  const p=await repo.saveProvider(null,{...presets.newProvider('deepseek'),enabled:true,baseUrl:'https://fixture.invalid',credential:{action:'replace',value:'synthetic-completion-provider'}});
  const catalog=capabilities.parseCatalog({data:[{id:'A',input_modalities:['text','image'],api_capabilities:{structured_outputs:true},effort:{supported_levels:['low','high']}}]},p.fingerprint);
  await repo.saveCatalog(p.id,p.fingerprint,catalog);
  return {repo,p,catalog,options};
}

test('model effort persists independently, survives refresh, invalidates probes, and can reset to inheritance',async()=>{
  const {repo,p,catalog,options}=await repository();
  const before=(await repo.readCenter()).providers[0].models[0];
  await repo.recordDiagnostic({providerId:p.id,modelId:'A',protocol:'chat_completions',fingerprint:options.modelConfigurationFingerprint(p,before),providerRevision:p.revision,credentialRevision:p.credentialRevision,kind:'structured',endpoint:'https://fixture.invalid/chat/completions',status:200,code:'OK',latencyMs:1,attempts:1,fallbackUsed:false});
  assert.equal((await repo.diagnostics(p.id))[0].stale,false);
  await repo.saveManualModel(p.id,{id:'A',update:true,expectedRevision:p.revision,expectedConfigurationRevision:(await repo.readCenter()).routing.revision,reasoningEffort:'high'});
  assert.equal((await repo.diagnostics(p.id))[0].stale,true);
  await repo.saveCatalog(p.id,p.fingerprint,catalog);
  assert.equal((await repo.readCenter()).providers[0].models[0].metadata.reasoningEffort,'high');
  assert.equal((await repo.readCenter()).providers[0].reasoningEffort,'');
  await repo.saveManualModel(p.id,{id:'A',update:true,expectedRevision:p.revision,expectedConfigurationRevision:(await repo.readCenter()).routing.revision,reasoningEffort:null});
  assert.equal((await repo.readCenter()).providers[0].models[0].metadata.reasoningEffort,undefined);
  await assert.rejects(async()=>repo.saveManualModel(p.id,{id:'A',update:true,expectedRevision:p.revision,expectedConfigurationRevision:(await repo.readCenter()).routing.revision,reasoningEffort:'max'}));
});

test('vision probe expected answers remain server-only, not given away by prompt/schema',async()=>{
  const {visionChallenge}=await loadSource('lib/server/ai/vision-probe.ts');
  const challenge=visionChallenge(new Uint32Array([0,1,2,3]));
  assert.equal(challenge.images.length,4);
  assert.equal(JSON.stringify(challenge.schema).includes('const'),false);
  assert.equal(challenge.prompt.includes('red'),false);
  assert.equal(challenge.validateOutput({colors:['red','green','blue','yellow']}),true);
  assert.equal(challenge.validateOutput({colors:['red','red','red','red']}),false);
  assert.equal(challenge.validateOutput({colors:['yellow','blue','green','red']}),false);
});

test('management errors expose opaque trace IDs but never raw unknown exceptions',async t=>{
  const {errorResponse,ProviderError}=await loadSource('lib/server/ai/errors.ts');
  const logs=[];t.mock.method(console,'warn',v=>logs.push(v));
  const response=errorResponse(new Error('private-synthetic-secret'));
  const data=await response.json();assert.equal(response.status,500);
  assert.match(data.error.diagnosticId,/^[a-f0-9-]{36}$/);
  assert.ok(logs[0].includes(data.error.diagnosticId));assert.ok(!logs.join('').includes('private-synthetic-secret'));
  assert.ok(!JSON.stringify(data).includes('private-synthetic-secret'));
  const rate=errorResponse(new ProviderError('UPSTREAM_RATE_LIMITED','Limited',429,undefined,'120'));
  assert.equal(rate.headers.get('retry-after'),'120');assert.equal((await rate.json()).error.retryable,true);
});

test('local D1 observer reads real SQLite without changing data or running another worker',()=>{
  const dir=mkdtempSync(join(tmpdir(),'zhiti-readonly-observer-'));
  try {
    const root=join(dir,'v3','d1','miniflare-D1DatabaseObject');mkdirSync(root,{recursive:true});
    const db=new DatabaseSync(join(root,'test.sqlite'));db.exec('CREATE TABLE homework_assignments(id TEXT); INSERT INTO homework_assignments VALUES (\'kept\')');db.close();
    assert.equal(localD1Rows(dir,'SELECT id FROM homework_assignments')[0].id,'kept');
    assert.throws(()=>localD1Rows(dir,'DELETE FROM homework_assignments'),/readonly|read-only/i);
    assert.equal(localD1Rows(dir,'SELECT count(*) AS n FROM homework_assignments')[0].n,1);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
