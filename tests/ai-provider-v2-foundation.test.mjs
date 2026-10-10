import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSource} from './load-source.mjs';
import {sqliteD1,legacyCipher,insertLegacy} from './helpers/ai-v2-sqlite.mjs';
const secret='synthetic-only-encryption-secret';
async function modules(db=sqliteD1()) {
  const bindings={DB:db,LOCAL_ADMIN_MODE:'true',AI_PROVIDER_ENCRYPTION_KEY:secret};
  return {db,bindings,repo:await loadSource('lib/server/ai/provider-repository.ts',bindings),crypto:await loadSource('lib/server/ai/credentials.ts',bindings),presets:await loadSource('lib/ai-provider-presets.ts')};
}
function input(presets,patch={}) {return {...presets.newProvider(),baseUrl:'https://fixture.invalid/tenant/v1',credential:{action:'replace',value:'synthetic-provider-key'},enabled:true,...patch};}
test('V2 endpoint normalization preserves roots, versions and native gateway prefixes',async()=>{
  const {normalizeProviderBase:n,providerEndpoint:e}=await loadSource('lib/ai-provider-presets.ts');
  for(const base of ['https://api.deepseek.com','https://fixture.invalid/v1','https://fixture.invalid/prefix/antigravity/v1beta','https://fixture.invalid/prefix/antigravity/v1']) {
    assert.equal(n(base+'/'),base);assert.equal(e(base,'models'),base+'/models');
  }
  assert.equal(e('https://fixture.invalid/prefix/antigravity/v1beta','models/{model}:generateContent','Group/Alias'),'https://fixture.invalid/prefix/antigravity/v1beta/models/Group%2FAlias:generateContent');
  for(const base of ['https://u:p@host','file:///tmp','https://host/?key=x','https://host/#key','https://host/a/../b','https://host/a/%2e%2e/b'])assert.throws(()=>n(base));
  for(const path of ['//evil/path','https://evil','/absolute','../escape','models?key=x','%2e%2e/x','a\\b','a//b'])assert.throws(()=>e('https://fixture.invalid/tenant',path));
});
test('model catalog refresh replaces stale upstream entries while preserving explicit exceptions',async()=>{
  const {parseCatalog,mergeCatalog}=await loadSource('lib/server/ai/capabilities.ts');
  const models=parseCatalog({data:[{id:'M',name:'Named',input_modalities:['text','image'],output_modalities:['text'],effort:{supported_levels:['low','max']},api_capabilities:{structured_outputs:true}},{id:'m'},{id:'M'},{id:'VisionSuperBrand'}]},'fp');
  assert.deepEqual(models.map(m=>m.id),['M','m','VisionSuperBrand']);assert.equal(models[0].capabilities.vision.state,'supported');assert.deepEqual(models[0].metadata.effortLevels,['low','max']);assert.equal(models[2].capabilities.vision.state,'unknown');
  const fresh=parseCatalog({data:[{id:'m',input_modalities:['text']}]},'fp');
  const replaced=mergeCatalog(models,fresh,'fp');assert.deepEqual(replaced.map(m=>m.id),['m']);assert.equal(replaced[0].capabilities.vision.state,'unsupported');
  const retained=mergeCatalog(models,fresh,'fp',new Set(['M']));assert.deepEqual(retained.map(m=>m.id).sort(),['M','m']);assert.equal(retained.find(m=>m.id==='M').catalogPresent,false);
  models[2].manual=true;const manual=mergeCatalog(models,fresh,'fp');assert.deepEqual(manual.map(m=>m.id).sort(),['VisionSuperBrand','m']);assert.equal(manual.find(m=>m.id==='VisionSuperBrand').catalogPresent,false);
});
test('v1 ciphertext and effective role fallbacks migrate byte-for-byte and stay decryptable',async()=>{
  const m=await modules(),cipher=await legacyCipher(secret,'synthetic-old-key');insertLegacy(m.db,cipher,{text:'Text-B',catalog:[{id:'User-Alias'}]});
  const state=await m.repo.readCenter();assert.equal(state.providers.length,1);assert.equal(state.providers[0].baseUrl,'https://fixture.invalid/prefix/v1');
  assert.deepEqual(state.routing.routes.map(r=>r.primary.modelId),['Vision-A','Text-B','Vision-A','Vision-A']);
  assert.equal(state.secrets.get('legacy-global'),cipher);assert.equal(await m.repo.providerKey(state,state.providers[0]),'synthetic-old-key');
  assert.equal(JSON.stringify(m.repo.publicCenter(state)).includes('synthetic-old-key'),false);assert.equal(JSON.stringify(m.repo.publicCenter(state)).includes(cipher),false);
  assert.deepEqual((await m.repo.readCenter()).routing,state.routing);assert.equal(m.db.sqlite.prepare('SELECT api_key_encrypted FROM ai_provider_config').get().api_key_encrypted,cipher);
});
test('disabled, empty and environment-only migrations retain behavior, then deletion never resurrects legacy rows',async()=>{
  for(const mode of ['empty','disabled']) {
    const m=await modules();if(mode==='disabled')insertLegacy(m.db,await legacyCipher(secret,'test'),{enabled:0});
    const s=await m.repo.readCenter();assert.equal(s.routing.allowEnvironmentFallback,true);assert.ok(s.routing.routes.every(r=>r.primary===null));
    if(s.providers.length)await m.repo.deleteProvider('legacy-global',1);
    assert.equal((await m.repo.readCenter()).providers.length,0);assert.equal((await m.repo.readCenter()).migrationState,'complete');
  }
});
test('Antigravity migration preserves the old effective Gemini endpoint, not a guessed Claude path',async()=>{
  const m=await modules();insertLegacy(m.db,await legacyCipher(secret,'test'),{wire:'antigravity_gemini',base:'https://fixture.invalid/prefix/v1'});
  const p=(await m.repo.readCenter()).providers[0];assert.equal(p.wireApi,'gemini_generate_content');assert.equal(p.baseUrl,'https://fixture.invalid/prefix/antigravity/v1beta');
});
test('migration failure rolls back providers, models, routes and completion marker',async()=>{
  const m=await modules();insertLegacy(m.db,await legacyCipher(secret,'test'));m.db.failNextBatch=true;
  await assert.rejects(()=>m.repo.readCenter(),/rollback/);assert.equal(m.db.sqlite.prepare('SELECT count(*) AS n FROM ai_providers').get().n,0);
  assert.equal(m.db.sqlite.prepare('SELECT migration_state FROM ai_routing_settings').get().migration_state,'pending');
  assert.equal((await m.repo.readCenter()).providers.length,1);
});
test('new provider credentials use provider-bound encryption; copying ciphertext fails closed',async()=>{
  const m=await modules(),p=await m.repo.saveProvider(null,input(m.presets)),s=await m.repo.readCenter();
  assert.equal(JSON.parse(s.secrets.get(p.id)).v,2);assert.equal(await m.repo.providerKey(s,p),'synthetic-provider-key');
  await assert.rejects(()=>m.crypto.openCredential(s.secrets.get(p.id),'another-provider'),e=>e.code==='CREDENTIAL_DECRYPT_FAILED');
  const copy=await m.repo.saveProvider(null,input(m.presets,{enabled:false,credential:{action:'keep'}}));assert.equal(copy.hasApiKey,false);
});
test('changing tenant prefix or auth/endpoint scope cannot reuse a saved key',async()=>{
  const m=await modules(),p=await m.repo.saveProvider(null,input(m.presets));
  for(const patch of [{baseUrl:'https://fixture.invalid/other/v1'},{endpoints:{...p.endpoints,auth:'x-api-key'}},{endpoints:{...p.endpoints,models:'catalog'}}]) {
    await assert.rejects(()=>m.repo.saveProvider(p.id,input(m.presets,{...p,...patch,expectedRevision:p.revision,credential:{action:'keep'}})),e=>e.code==='PROVIDER_CREDENTIAL_SCOPE_CHANGED');
  }
});
test('simultaneous provider writes have one winner and one 409, not lost updates',async()=>{
  const m=await modules(),p=await m.repo.saveProvider(null,input(m.presets));
  const changes=['first','second'].map(name=>m.repo.saveProvider(p.id,input(m.presets,{...p,name,expectedRevision:1,credential:{action:'keep'}})));
  const results=await Promise.allSettled(changes);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'REVISION_CONFLICT');
  assert.equal((await m.repo.readCenter()).providers[0].revision,2);assert.equal(m.db.sqlite.prepare('SELECT count(*) AS n FROM ai_v2_write_guard').get().n,0);
});
test('task routes ignore capability labels, block referenced deletion, and preserve whole-snapshot versions',async()=>{
  const m=await modules(),p=await m.repo.saveProvider(null,input(m.presets));let state=await m.repo.readCenter();
  await m.repo.saveManualModel(p.id,{id:'M',expectedRevision:p.revision,expectedConfigurationRevision:state.routing.revision,capabilities:{text:'unknown',vision:'unsupported',structured:'unknown'}});
  state=await m.repo.readCenter();const next=structuredClone(state.routing);next.routes.find(r=>r.role==='recognition').primary={providerId:p.id,modelId:'M'};
  const saved=await m.repo.saveRouting(next);assert.equal(saved.revision,next.revision+1);
  await assert.rejects(()=>m.repo.saveRouting(next),e=>e.code==='REVISION_CONFLICT');await assert.rejects(()=>m.repo.deleteProvider(p.id,p.revision),e=>e.code==='PROVIDER_IN_USE');
  await assert.rejects(()=>m.repo.saveProvider(p.id,input(m.presets,{...p,enabled:false,expectedRevision:p.revision,credential:{action:'keep'}})),e=>e.code==='PROVIDER_IN_USE');
});
test('refresh prunes stale catalog rows, preserves manual and routed IDs, and rejects stale discovery',async()=>{
  const m=await modules(),p=await m.repo.saveProvider(null,input(m.presets));let s=await m.repo.readCenter();
  const caps=await loadSource('lib/server/ai/capabilities.ts');
  await m.repo.saveCatalog(p.id,p.fingerprint,caps.parseCatalog({data:[{id:'Routed'},{id:'Old'}]},p.fingerprint));
  s=await m.repo.readCenter();await m.repo.saveManualModel(p.id,{id:'Manual',expectedRevision:p.revision,expectedConfigurationRevision:s.routing.revision,capabilities:{text:'supported'}});
  s=await m.repo.readCenter();const routing=structuredClone(s.routing);routing.routes.find(r=>r.role==='text').primary={providerId:p.id,modelId:'Routed'};await m.repo.saveRouting(routing);
  s=await m.repo.readCenter();await m.repo.saveCatalog(p.id,p.fingerprint,caps.parseCatalog({data:[{id:'Fresh'}]},p.fingerprint));
  const ids=(await m.repo.readCenter()).providers[0].models.map(x=>x.id);assert.deepEqual(ids.sort(),['Fresh','Manual','Routed']);assert.equal(ids.includes('Old'),false);
  const kept=(await m.repo.readCenter()).providers[0].models.find(x=>x.id==='Routed');assert.equal(kept.catalogPresent,false);
  await m.repo.saveProvider(p.id,input(m.presets,{...p,name:'Renamed',expectedRevision:1,credential:{action:'keep'}}));
  await assert.rejects(()=>m.repo.saveCatalog(p.id,p.fingerprint,[]),e=>e.code==='REVISION_CONFLICT');
});
