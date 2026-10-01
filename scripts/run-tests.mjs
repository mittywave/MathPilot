import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT=process.cwd();
const TEST_DIR=join(ROOT,'tests');
const E2E=new Set(['homework-e2e.test.mjs','scoped-library-e2e.test.mjs','knowledge-graph-e2e.test.mjs']);
const WRANGLER_RETRY=pathToFileURL(join(ROOT,'scripts','local-wrangler-fetch-retry.mjs')).href;

function run(args,{label,retries=0}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,args,{cwd:ROOT,stdio:'inherit',env:{...process.env}});
    child.on('error',reject);
    child.on('exit',async code=>{
      if(code===0)return resolve();
      if(retries>0){
        console.warn(`\n${label||args.join(' ')} failed with exit code ${code}; retrying once in a fresh Node process...\n`);
        await new Promise(r=>setTimeout(r,1000));
        try{await run(args,{label,retries:retries-1});resolve();}catch(error){reject(error);}
        return;
      }
      reject(new Error(`${label||args.join(' ')} failed with exit code ${code}`));
    });
  });
}

const files=(await readdir(TEST_DIR)).filter(name=>name.endsWith('.test.mjs')).sort();
const unit=files.filter(name=>!E2E.has(name)).map(name=>join('tests',name));

// Keep deterministic/unit regressions in one serial process. Wrangler-backed E2E
// tests get fresh Node processes so hundreds of prior tests cannot leave handles,
// sockets or runtime state that destabilize local Workers/D1/R2 on CI runners.
await run(['--test','--test-concurrency=1',...unit],{label:'unit/regression tests'});
for(const name of E2E){
  await run(['--import',WRANGLER_RETRY,'--test','--test-concurrency=1',join('tests',name)],{label:name,retries:1});
}
