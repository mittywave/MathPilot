"""Optional browser regression: pip install playwright; install Chromium.
Run after: node scripts/build-studio-browser.mjs /path/to/harness
Mocks ONLY auth and the transcription-job HTTP API. Starting a job runs the real
transcription pipeline in the page with mocked model records, standing in for the
server queue. Uses the real React component, canvas/image encoding, the job list,
a fresh page on every visit, and browser DOCX download.
"""
import argparse, json, functools, threading, tempfile, base64
from pathlib import Path
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from playwright.sync_api import sync_playwright, expect

def main():
    ap=argparse.ArgumentParser();ap.add_argument('harness');ap.add_argument('--out',default='studio-browser-results');ap.add_argument('--chromium');args=ap.parse_args()
    out=Path(args.out).resolve();out.mkdir(parents=True,exist_ok=True)
    server=ThreadingHTTPServer(('127.0.0.1',0),functools.partial(SimpleHTTPRequestHandler,directory=args.harness));threading.Thread(target=server.serve_forever,daemon=True).start()
    origin=f'http://127.0.0.1:{server.server_port}'
    results={};calls=[];invalid=False
    with sync_playwright() as pw:
      browser=pw.chromium.launch(headless=True,executable_path=args.chromium)
      context=browser.new_context(viewport={'width':1440,'height':1050},accept_downloads=True,reduced_motion='reduce')
      page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
      page.route('**/api/auth/me',lambda route:route.fulfill(json={'user':{'id':'browser-test','local':True}}))
      # The server runs this pipeline from the queue; here it runs in the page with mocked model records.
      transcribe=r"""async ({title,pages,invalid})=>{
        const fixture=studioTest.mathContractDraft(),fail=async()=>{throw new Error('No figures in text transcription');};
        const records=page=>fixture.questions.map((q,i)=>({lesson:q.lesson,section:q.section,number:q.number,stem:q.stem,analysis:invalid&&!i?'$\\unknown{x}$':q.analysis,warnings:q.warnings,tables:q.tables,id:page.id+':'+i,source:{pageId:page.id,box:{x:0,y:0,width:1000,height:1000}},diagramBoxes:[],continuation:false}));
        const draft={version:1,title,inputMode:studioTest.studioInputMode(pages.map(p=>p.role)),pages:pages.map(p=>({...p,image:'',selected:true})),questions:[],answers:[],updatedAt:0};
        return studioTest.transcribeStudio(draft,{recognize:async page=>records(page),checkpoint:async()=>{},progress:()=>{},crop:fail,drawings:fail},{drawings:false});
      }"""
      jobs={}
      def job_api(route):
        request=route.request;parts=[p for p in request.url.split('/api/answer-studio/jobs',1)[1].split('?')[0].split('/') if p]
        if not parts:
          if request.method=='GET':return route.fulfill(json={'jobs':[entry['job'] for entry in reversed(list(jobs.values()))]})
          body=request.post_data_json;job_id=f'job-{len(jobs)+1}'
          jobs[job_id]={'job':{'id':job_id,'title':body['title'],'status':'uploading','stalled':False,'pageCount':0,'processedCount':0,'questionCount':0,'progress':'','error':'','createdAt':0,'updatedAt':0},'pages':[],'images':{},'draft':None}
          return route.fulfill(json={'job':jobs[job_id]['job']})
        entry=jobs[parts[0]]
        if parts[1:]==['pages']:
          body=request.post_data_json;entry['pages'].append(body['page']);entry['images'][body['page']['id']]=body['image'];entry['job']['pageCount']=len(entry['pages'])
          return route.fulfill(json={'job':entry['job']})
        if len(parts)==3:return route.fulfill(body=base64.b64decode(entry['images'][parts[2]].split(',',1)[1]),content_type='image/jpeg')
        if request.method=='POST':
          # Opening a completed job validates and reuses its cached result; it
          # does not repeat model recognition when the checkpoint is valid.
          if entry['job']['status']=='done':return route.fulfill(json={'job':entry['job']})
          calls.extend(item['id'] for item in entry['pages'])
          entry['draft']=page.evaluate(transcribe,{'title':entry['job']['title'],'pages':entry['pages'],'invalid':invalid})
          entry['job'].update(status='done',processedCount=len(entry['pages']),questionCount=len(entry['draft']['questions']))
          return route.fulfill(json={'job':entry['job']})
        return route.fulfill(json={'job':entry['job'],'draft':entry['draft']})
      page.route('**/api/answer-studio/jobs**',job_api)
      try:
        page.goto(origin);expect(page.get_by_role('navigation',name='面包屑',exact=True)).to_contain_text('文件转录');expect(page).to_have_title('文件转录 · 工具箱 · MathPilot')
        # Real PNG upload; the model is mocked because no real credentials/sample were supplied.
        png=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=')
        def upload(name):
          created=len(jobs)
          # Answers only: the server would read this mode from the uploaded roles.
          page.locator('#studio-answer-files').set_input_files({'name':name,'mimeType':'image/png','buffer':png})
          page.get_by_placeholder('\u4f8b\u5982\uff1a\u7b2c\u4e00\u8bb2 \u4e09\u89d2\u5f62\u7684\u5916\u5fc3').fill('Math contract regression')
          page.get_by_role('button',name='\u5f00\u59cb\u8f6c\u5f55',exact=True).click()
          # The newest job is listed first; open its finished result.
          expect(page.locator('.studio-jobs tr')).to_have_count(created+1,timeout=30000)
          row=page.locator('.studio-jobs tr').first;expect(row).to_contain_text('\u5df2\u5b8c\u6210',timeout=30000)
          row.get_by_role('button',name='\u6253\u5f00',exact=True).click()
          expect(page.get_by_role('heading',name='\u8f6c\u5f55\u7ed3\u679c',exact=True)).to_be_visible(timeout=30000)
        upload('fixture.png');count=len(calls);assert count==1
        # Every visit starts with an empty page: results stay on the server until a job is opened again.
        page.on('dialog',lambda dialog:dialog.accept())
        page.reload();expect(page.get_by_role('button',name='\u5f00\u59cb\u8f6c\u5f55',exact=True)).to_be_visible()
        expect(page.get_by_role('heading',name='\u8f6c\u5f55\u7ed3\u679c',exact=True)).to_have_count(0)
        assert page.evaluate("studioTest.studioStorage('browser-test','read')") is None
        upload('fixture.png');count=len(calls);assert count==2
        page.locator('#studio-output-text').check();page.get_by_role('button',name='\u751f\u6210 Word',exact=True).click()
        link=page.locator('a.studio-download');expect(link).to_be_visible(timeout=30000)
        with page.expect_download() as download:link.click()
        download.value.save_as(out/'browser-formal.docx');assert len(calls)==count
        results['freshStartOnReload']=True
        for name,width,height in [('desktop-1440',1440,1050),('desktop-1280',1280,900),('desktop-1024',1024,768)]:
          page.set_viewport_size({'width':width,'height':height});page.screenshot(path=str(out/f'{name}.png'),full_page=True)
          sizes=page.evaluate('({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth})');assert sizes['scroll']<=sizes['width'];results[name]=sizes
        page.set_viewport_size({'width':1440,'height':1050});invalid=True;upload('invalid.png')
        page.locator('#studio-output-text').check();page.get_by_role('button',name='\u751f\u6210 Word',exact=True).click()
        expect(page.locator('.studio-error')).to_contain_text('unknown',timeout=30000);assert page.locator('a.studio-download').count()==0
        # The page has no review-copy export any more; an unsupported formula simply blocks the formal Word.
        results['strictBlocksInvalidMath']=True
        # Real IndexedDB, with put-count instrumentation and a failed transaction.
        results['storage']=page.evaluate('''async()=>{
          const store=studioTest.studioStorage,d=studioTest.mathContractDraft();d.pages=[{id:'p',hash:'h',page:1,image:'pixels',role:'answer',selected:true,name:'test'}];
          let puts=0;const old=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){if(this.name==='pageImages')puts++;return old.apply(this,args);};
          try{
            await store('storage-a','write',d);const first=puts;
            for(let i=0;i<20;i++){d.updatedAt=i;await store('storage-a','write',d);}
            if(puts!==first)throw Error('unchanged source rewritten');
            await store('storage-b','write',d);
            const invalid=structuredClone(d);invalid.pages.push({...d.pages[0],id:'missing',image:''});
            let failed=false;try{await store('storage-a','write',invalid);}catch{failed=true;}if(!failed)throw Error('missing source was accepted');
            if((await store('storage-a','read')).pages.length!==1)throw Error('atomic rollback lost old draft');
            await store('storage-a','delete');if(!(await store('storage-b','read')))throw Error('cross-owner deletion');
            return {initialImageWrites:first,unchangedCheckpoints:20,additionalImageWrites:puts-first-1,rollback:true,ownerIsolation:true};
          }finally{IDBObjectStore.prototype.put=old;}
        }''')
        assert not errors,errors
        results['pageErrors']=errors;results['recognitionCalls']=len(calls)
      finally:context.close();browser.close();server.shutdown()
    (out/'browser-results.json').write_text(json.dumps(results,indent=2));print(json.dumps(results,indent=2))
if __name__=='__main__':main()
