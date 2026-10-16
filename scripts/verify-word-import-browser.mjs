import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
// Run after npm run build. The application, D1, media storage, UI import and
// download are real; only two network failures are injected into this fixture.
// No user database or external AI connection is used.
// Usage: node scripts/verify-word-import-browser.mjs fixed /path/to/20-question.docx
// PLAYWRIGHT_PACKAGE may point to a bundled playwright/package.json.
const require = createRequire(process.env.PLAYWRIGHT_PACKAGE || import.meta.url);
const { chromium } = require('playwright');
const expect = locator => ({
  async toContainText(text) { await locator.filter({hasText:text}).waitFor({state:'visible'}); },
  async toHaveCount(count,{timeout=20000}={}) {
    const until=Date.now()+timeout;
    while(Date.now()<until){if(await locator.count()===count)return;await delay(100);}
    throw Error(`Expected ${count} elements; found ${await locator.count()}`);
  },
});
const root = process.cwd();
const mode = process.argv[2] || 'fixed';
const out = resolve(process.env.WORD_IMPORT_EVIDENCE_DIR || join('artifacts/word-import-regression', mode));
await mkdir(out, {recursive:true});
if (!process.argv[3]) throw Error('Supply the source 20-question DOCX as the second argument.');
const state = await mkdtemp(join(tmpdir(), 'zhiti-word-import-'));
const port = await new Promise((accept, reject) => {
  const socket = createServer(); socket.once('error', reject);
  socket.listen(0, '127.0.0.1', () => { const port = socket.address().port; socket.close(error => error ? reject(error) : accept(port)); });
});
const base = `http://127.0.0.1:${port}`;
const file = resolve(process.argv[3]);
const init = spawnSync(join(root,'node_modules/.bin/wrangler'), ['d1','migrations','apply','DB','--local','--persist-to',state,'--config','wrangler.jsonc'], {cwd:root,encoding:'utf8',env:{...process.env,WRANGLER_SEND_METRICS:'false'}});
if(init.status!==0) { await rm(state,{recursive:true,force:true}); throw Error(init.stderr+'\n'+init.stdout); }
const vars = {LOCAL_ADMIN_MODE:'true',HOMEWORK_AUTO_PUBLISH_ENABLED:'false',OPENAI_API_KEY:'',PUBLIC_LIBRARY_REMOTE_URL:''};
const worker = spawn(process.execPath, ['scripts/start-local-test-worker.mjs','dist/server/wrangler.json',String(port),state,JSON.stringify(vars)], {cwd:root,stdio:['ignore','pipe','pipe']});
let workerLog=''; worker.stdout.on('data',v=>workerLog+=v); worker.stderr.on('data',v=>workerLog+=v);
let browser;
let page;
const result = {mode,file,requests:[],pageErrors:[],failedRequests:[]};
try {
  for(let i=0;i<200;i++) {
    if(worker.exitCode!==null)throw Error(workerLog);
    try {if(workerLog.includes('Local compiled Worker ready on '+base)&&(await fetch(base+'/api/auth/me',{signal:AbortSignal.timeout(1000)})).ok) break;}catch{ /* Wait for this isolated worker's listener. */ }
    await delay(100);
  }
  assert.ok(workerLog.includes('Local compiled Worker ready on '+base),'the isolated worker must own this listener');
  browser = await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {})});
  page = await browser.newPage({viewport:{width:1440,height:1000}});
  page.setDefaultTimeout(20000);
  page.on('pageerror',e=>result.pageErrors.push(String(e)));
  page.on('requestfailed',r=>{if(r.url()===base+'/api/questions')result.failedRequests.push({id:r.postDataJSON().question.id,error:r.failure()?.errorText});});
  page.on('response',async r=>{if(r.url()===base+'/api/questions'&&r.request().method()==='POST') {
    const request={id:r.request().postDataJSON().question.id,status:r.status()}; result.requests.push(request);
    if(r.status()>=400)request.error=await r.json().catch(()=>({}));
  }});
  await page.goto(base+'/');
  await expect(page.locator('.user-chip')).toContainText('本机管理员');
  // 新建模块 sits in the sidebar heading's 管理模块 menu.
  await page.getByRole('button',{name:'管理模块',exact:true}).first().click();
  await page.locator('.more-panel').getByRole('button',{name:'新建模块',exact:true}).click();
  await page.getByLabel('模块名称',{exact:true}).fill('Word 导入回归');
  await page.getByRole('button',{name:'创建模块',exact:true}).click();
  await page.getByRole('button',{name:'新建试题',exact:true}).first().click();
  await page.getByRole('button',{name:'文件批量录入'}).click();
  await page.locator('.file-import-modal input[type=file]').setInputFiles(file);
  await expect(page.locator('.file-draft')).toHaveCount(20,{timeout:60000});
  await page.screenshot({path:join(out,'review.png'),fullPage:true});
  result.previewCount=await page.locator('.file-draft').count();
  let first = true; let lostResponse = mode==='fixed';
  await page.route('**/api/questions',async route=>{
    if(route.request().method()!=='POST')return route.continue();
    if(first){first=false;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'合成验收：一次保存失败'})});}
    if(lostResponse){lostResponse=false;await route.fetch();return route.abort('failed');}
    await delay(150);
    await route.continue();
  });
  const saveButton=page.getByRole('button',{name:'保存所选 20 道题',exact:true});
  if(mode==='fixed') {
    await saveButton.evaluate(button=>{button.click();button.click();});
    assert.equal(await page.getByRole('button',{name:'正在保存…',exact:true}).isDisabled(),true);
    assert.equal(await page.getByRole('button',{name:'重新选择文件',exact:true}).isDisabled(),true);
    assert.equal(await page.locator('.file-draft-list').getAttribute('inert'),'');
    await expect(page.locator('.file-draft')).toHaveCount(2,{timeout:60000});
  } else {
    await saveButton.click();
    for(let i=0;i<200&&result.requests.length<20;i++)await delay(100);
  }
  await page.screenshot({path:join(out,'partial-save.png'),fullPage:true});
  result.firstSaveCount = (await (await fetch(base+'/api/library?scope=public')).json()).questions.length;
  result.remainingDrafts = await page.locator('.file-draft').count();
  if(mode==='baseline') {
    await page.getByRole('button',{name:'保存所选 20 道题',exact:true}).click();
    for(let i=0;i<200&&result.requests.length<40;i++)await delay(100);
    await page.screenshot({path:join(out,'retry-unique-error.png'),fullPage:true});
    result.notice=await page.locator('.notice').innerText().catch(()=>page.locator('body').innerText());
    result.finalCount=(await (await fetch(base+'/api/library?scope=public')).json()).questions.length;
  } else {
    assert.equal(result.firstSaveCount,19,'the second question must really persist before its response is lost');
    assert.equal(result.remainingDrafts,2);
    assert.equal(result.requests.length+result.failedRequests.length,20,'double-click must not issue a second batch');
    await page.unroute('**/api/questions');
    await page.getByRole('button',{name:'保存所选 2 道题',exact:true}).click();
    await page.locator('.file-import-modal').waitFor({state:'hidden',timeout:60000});
    const data=await (await fetch(base+'/api/library?scope=public')).json();
    assert.equal(data.questions.length,20); assert.equal(new Set(data.questions.map(q=>q.id)).size,20);
    assert.equal(result.requests.length+result.failedRequests.length,22,'only the two unresolved saves may be retried');
    result.finalCount=data.questions.length; result.doubleClickGuard=true; result.partialRetry=true; result.lostResponseRetry=true;
    const countXml=(key,pattern)=>data.questions.reduce((sum,q)=>sum+(q[key]||[]).reduce((n,xml)=>n+(xml.match(pattern)||[]).length,0),0);
    result.structures={analyses:data.questions.filter(q=>q.analysis).length,stemParagraphs:data.questions.reduce((n,q)=>n+(q.stemParagraphs?.length||0),0),formulas:countXml('stemDocxXml',/<m:oMath\b/g)+countXml('optionsDocxXml',/<m:oMath\b/g)+countXml('analysisDocxXml',/<m:oMath\b/g),tables:countXml('stemDocxXml',/<w:tbl\b/g)+countXml('analysisDocxXml',/<w:tbl\b/g),images:data.questions.reduce((n,q)=>n+(q.contentImages?.length||0),0)};
    await writeFile(join(out,'saved-questions.json'),JSON.stringify(data.questions,null,2));
    await page.reload();
    await page.locator('.tree button.module-root').filter({hasText:'Word 导入回归'}).first().click();
    await expect(page.locator('.question-card')).toHaveCount(20);
    const cards=page.locator('.question-card');
    for(const i of [0,1,16,17,18,19]){
      await cards.nth(i).scrollIntoViewIfNeeded();
      await cards.nth(i).getByRole('button',{name:'查看解析',exact:true}).click();
      await cards.nth(i).screenshot({path:join(out,`desktop-question-${i+1}.png`)});
    }
    result.desktopOverflow=await page.evaluate(()=>({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));
    assert.ok(result.desktopOverflow.scroll<=result.desktopOverflow.client);
    assert.ok(await cards.nth(0).locator('.katex').count()>0,'saved fractions must render as native webpage math');
    assert.ok(await cards.nth(17).locator('table').count()>0,'saved table must remain a table');
    result.imageLoads=await cards.locator('img').evaluateAll(imgs=>imgs.map(img=>({loaded:img.complete&&img.naturalWidth>0,width:img.naturalWidth})));
    assert.ok(result.imageLoads.every(x=>x.loaded));
    await page.getByRole('button',{name:'全选结果',exact:true}).click();
    await page.locator('button.export-button').click();
    await page.getByLabel('练习标题',{exact:true}).fill('Word 导入修复回归');
    await page.locator('#basket-include-answers').check();
    const download=page.waitForEvent('download',{timeout:60000});
    await page.getByRole('button',{name:'生成 Word',exact:true}).click();
    await (await download).saveAs(join(out,'actual-page-export.docx'));
    result.wordExport=true;
    assert.deepEqual(result.pageErrors,[]);
  }
  await writeFile(join(out,'results.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
} catch(error) {
  result.failure=String(error);
  if(page)await page.screenshot({path:join(out,'failure.png'),fullPage:true}).catch(()=>{});
  await writeFile(join(out,'results.json'),JSON.stringify(result,null,2));
  throw error;
} finally {
  if(browser)await browser.close();
  worker.kill('SIGINT');
  await Promise.race([new Promise(r=>worker.once('exit',r)),delay(3000)]);
  if(worker.exitCode===null)worker.kill('SIGKILL');
  await writeFile(join(out,'worker.log'),workerLog);
  await rm(state,{recursive:true,force:true});
}
