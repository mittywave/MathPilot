"""Full application acceptance: compiled layout/CSS + real local Worker/D1.
Only the external AI HTTP service is synthetic. No production commands or real
credentials are read. Run `npm run build` first. CI runs Chromium and WebKit.
"""
import argparse, base64, hashlib, json, os, re, signal, socket, sqlite3, subprocess, tempfile, threading, time, urllib.error, urllib.request, zipfile, struct, zlib
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright, expect
ROOT = Path(__file__).resolve().parents[1]
WRANGLER = str(ROOT/'node_modules/.bin/wrangler')
IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVQIHWP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
ADMIN = 'ai-admin@example.invalid'
INVITE = 'synthetic-v2-invite'
SECRET = 'synthetic-browser-encryption-not-a-real-key'

def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1',0)); return s.getsockname()[1]

def schema_value(s):
    if 'const' in s: return s['const']
    if 'enum' in s: return s['enum'][0]
    if 'anyOf' in s: return schema_value(next((x for x in s['anyOf'] if x.get('type')=='null'),s['anyOf'][0]))
    t=s.get('type'); t=t[0] if isinstance(t,list) else t
    if t=='object': return {k:schema_value(v) for k,v in s.get('properties',{}).items()}
    if t=='array': return [schema_value(s['items']) for _ in range(s.get('minItems',0))]
    if t=='boolean': return True
    if t=='null': return None
    if t in ('integer','number'): return max(1,s.get('minimum',0))
    return 'synthetic'

class Upstream(BaseHTTPRequestHandler):
    calls=[]; slow=False; fail=False
    def log_message(self,*args): pass
    def send(self,data,status=200):
        raw=json.dumps(data,ensure_ascii=False).encode(); self.send_response(status); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(raw))); self.end_headers()
        try:self.wfile.write(raw)
        except (BrokenPipeError,ConnectionResetError):pass
    def do_GET(self):
        if self.headers.get('Authorization')!='Bearer synthetic-browser-provider-key':return self.send({'error':{'message':'synthetic auth failed'}},401)
        type(self).calls.append({'path':self.path,'kind':'catalog'})
        if '/claude/' in self.path:return self.send({'error':{'message':'no catalog'}},404)
        return self.send({'data':[{'id':'Model-A','name':'Synthetic multimodal','input_modalities':['text','image'],'output_modalities':['text'],'api_capabilities':{'structured_outputs':True},'effort':{'supported_levels':['low','high'],'default_level':'low'}},{'id':'model-a','input_modalities':['text'],'api_capabilities':{'structured_outputs':True}},{'id':'Unknown-Alias'}]})
    def do_POST(self):
        if self.headers.get('Authorization')!='Bearer synthetic-browser-provider-key':return self.send({'error':{'message':'synthetic auth failed'}},401)
        b=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))) or '{}')
        prompt=''; model=b.get('model')
        if b.get('input'):prompt=b['input'][0]['content'][0]['text']
        elif b.get('contents'):prompt=b['contents'][0]['parts'][0]['text'];model=self.path.split('/models/')[-1].split(':')[0]
        elif b.get('messages'):prompt=b['messages'][0]['content'][0]['text']
        type(self).calls.append({'path':self.path,'kind':'inference','model':model})
        if type(self).slow:time.sleep(4)
        if type(self).fail:return self.send({'error':{'message':'synthetic unavailable'}},503)
        s=json.loads(prompt.rsplit('\n',1)[-1]); value=schema_value(s)
        if 'colors' in value:
            blocks=b.get('input',[{}])[0].get('content',[]) if b.get('input') else b.get('messages',[{}])[0].get('content',[]) if b.get('messages') else b.get('contents',[{}])[0].get('parts',[])
            images=[]
            for part in blocks:
                v=part.get('image_url')
                if isinstance(v,dict):v=v.get('url')
                if v:images.append(v.split(',',1)[-1])
                elif part.get('inlineData'):images.append(part['inlineData']['data'])
                elif part.get('type')=='image':images.append(part['source']['data'])
            palette={(220,25,25):'red',(20,175,50):'green',(20,70,230):'blue',(245,220,30):'yellow',(145,35,190):'purple',(250,125,20):'orange'}
            value['colors']=[]
            for image in images:
                raw=base64.b64decode(image);pos=8;data=b''
                while pos<len(raw):
                    length=struct.unpack('>I',raw[pos:pos+4])[0];tag=raw[pos+4:pos+8]
                    if tag==b'IDAT':data+=raw[pos+8:pos+8+length]
                    pos+=length+12
                # The first PNG scanline pixel has no left/up neighbours.
                value['colors'].append(palette[tuple(zlib.decompress(data)[1:4])])

        if 'stem' in value:value.update(stem='计算 $x=\\frac{1}{2}$',answer='1/2',analysis='约分得到 $x=\\frac{1}{2}$。',source='合成验收样本')
        if 'should_reconstruct' in value:
            value.update(should_reconstruct=True,confidence=.99,strokes=[{'id':'segment','points':[{'x':100,'y':300},{'x':850,'y':300}], 'closed':False,'width':5,'color':'#000000','dash':[]}],expected_labels=[],labels=[],constraints=[],warnings=[],excluded_annotations=[])
        if 'records' in value:
            # Teacher-transcription contract is generated by its schema, with a real nonempty record.
            rec=schema_value(s['properties']['records']['items']); rec.update(number='1',stem='计算 $x=\\frac{1}{2}$',analysis='约分得到 $x=\\frac{1}{2}$。',continuation=False,section='合成验收',lesson='V2 回归')
            if 'box' in rec:rec['box']={'x':0,'y':0,'width':1000,'height':1000}
            value['records']=[rec]
        text=json.dumps(value,ensure_ascii=False)
        if self.path.endswith('/responses'):return self.send({'status':'completed','output':[{'type':'reasoning','summary':[]},{'type':'message','status':'completed','content':[{'type':'output_text','text':text}]}]})
        if self.path.endswith(':generateContent'):return self.send({'candidates':[{'finishReason':'STOP','content':{'parts':[{'text':text}]}}]})
        if self.path.endswith('/messages'):return self.send({'stop_reason':'end_turn','content':[{'type':'text','text':text}]})
        return self.send({'choices':[{'finish_reason':'stop','message':{'content':text,'reasoning_content':'synthetic omitted reasoning'}}]})

class App:
    def __init__(self,out,upstream):
        self.out=out; self.tmp=tempfile.TemporaryDirectory(prefix='ai-v2-browser-'); self.state=self.tmp.name; self.base=f'http://127.0.0.1:{free_port()}'; self.cookie='';self.upstream=upstream
    def sql(self,sql):
        # Once the tested Worker owns D1, do not start a second workerd CLI to
        # inspect or seed it. Use only this isolated fixture's actual SQLite.
        # Real application migration still happens through the authenticated API.
        if hasattr(self,'child'):
            seed=bool(re.match(r'\s*INSERT\s+INTO\s+ai_provider_config\b',sql,re.I))
            if not seed and not re.match(r'\s*SELECT\b',sql,re.I):
                raise ValueError('Only legacy seeding and read-only observations are allowed.')
            paths=[]
            for path in (Path(self.state)/'v3/d1').rglob('*.sqlite'):
                with sqlite3.connect(path.resolve().as_uri()+'?mode=ro',uri=True,timeout=3) as db:
                    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_provider_config'").fetchone():paths.append(path)
            if len(paths)!=1:raise RuntimeError('Expected exactly one real local AI fixture database.')
            db=sqlite3.connect(paths[0].resolve().as_uri()+('?mode=rw' if seed else '?mode=ro'),uri=True,timeout=3)
            try:
                db.row_factory=sqlite3.Row
                if not seed:db.execute('PRAGMA query_only=ON')
                cursor=db.execute(sql)
                rows=[dict(row) for row in cursor.fetchall()] if cursor.description else []
                db.commit()
                return rows
            finally:db.close()
        f=Path(self.state)/'fixture.sql';f.write_text(sql)
        run=subprocess.run([WRANGLER,'d1','execute','DB','--local','--config',str(ROOT/'wrangler.jsonc'),'--persist-to',self.state,'--file',str(f),'--json'],cwd=ROOT,env=self.env,capture_output=True,text=True,timeout=45)
        assert run.returncode==0,run.stderr[-1000:]
        return json.loads(run.stdout)[-1].get('results',[])
    def start(self):
        # Do not inherit user AI credentials or Cloudflare authentication in the test worker.
        self.env={k:v for k,v in os.environ.items() if not (k.startswith(('OPENAI_','AI_PROVIDER_','CLOUDFLARE_','DEEPSEEK_')))}
        self.env.update(NO_COLOR='1',WRANGLER_SEND_METRICS='false')
        self.sql('\n'.join(p.read_text() for p in sorted((ROOT/'migrations').glob('*.sql'))))
        vars={'LOCAL_ADMIN_MODE':'false','AI_PROVIDER_LOCAL_HTTP':'true','AI_PROVIDER_ENCRYPTION_KEY':SECRET,'ADMIN_EMAIL':ADMIN,'REGISTRATION_INVITE_CODE':INVITE,'OPENAI_API_KEY':'','HOMEWORK_AUTO_PUBLISH_ENABLED':'false'}
        args=[WRANGLER,'dev','--config',str(ROOT/'dist/server/wrangler.json'),'--port',self.base.rsplit(':',1)[-1],'--ip','127.0.0.1','--persist-to',self.state]
        for k,v in vars.items():args+=['--var',f'{k}:{v}']
        self.log=open(self.out/'worker.log','w');self.child=subprocess.Popen(args,cwd=ROOT,env=self.env,stdout=self.log,stderr=subprocess.STDOUT,start_new_session=True)
        for _ in range(200):
            if self.child.poll() is not None:raise RuntimeError('Local Worker exited; inspect sanitized worker.log')
            try:
                if self.request('/api/auth/me')[0]==200:break
            except (OSError,urllib.error.URLError):pass
            time.sleep(.15)
        else:raise RuntimeError('Local Worker startup timeout')
        status,payload,headers=self.request('/api/auth/register','POST',{'email':ADMIN,'password':'Synthetic-only-Password1','inviteCode':INVITE});assert status==201,payload
        self.cookie=headers['Set-Cookie'].split(';')[0]
        assert payload['user']['role']=='member'
        user_id=payload['user']['id']
        assert re.fullmatch(r'[0-9a-f-]{36}',user_id)
        subprocess.run([WRANGLER,'d1','execute','DB','--local','--persist-to',self.state,'--config',str(ROOT/'wrangler.jsonc'),'--command',f"UPDATE users SET role='admin' WHERE id='{user_id}' AND NOT EXISTS (SELECT 1 FROM users WHERE role='admin')"],cwd=ROOT,env=self.env,check=True,stdout=subprocess.DEVNULL)
    def request(self,path,method='GET',body=None,cookie=None,headers=None):
        h={'Connection':'close',**(headers or {})};c=self.cookie if cookie is None else cookie
        if c:h['Cookie']=c
        if body is not None:h.update({'Content-Type':'application/json','Origin':self.base})
        req=urllib.request.Request(self.base+path,data=json.dumps(body).encode() if body is not None else None,method=method,headers=h)
        try:r=urllib.request.urlopen(req,timeout=20)
        except urllib.error.HTTPError as e:r=e
        raw=r.read()
        try:data=json.loads(raw)
        except ValueError:data={'nonJson':len(raw)}
        return r.status,data,r.headers
    def ok(self,path,method='GET',body=None):
        status,data,_=self.request(path,method,body);assert 200<=status<300,(path,status,data);return data
    def close(self):
        if hasattr(self,'child'):
            os.killpg(self.child.pid,signal.SIGTERM)
            try:self.child.wait(timeout=5)
            except subprocess.TimeoutExpired:os.killpg(self.child.pid,signal.SIGKILL)
            self.log.close()
            p=self.out/'worker.log';s=p.read_text();p.write_text(s.replace(SECRET,'[synthetic-secret-redacted]').replace(self.cookie,'[session-redacted]'))
        self.tmp.cleanup()

API='/api/admin/ai-providers'
def main():
    ap=argparse.ArgumentParser();ap.add_argument('--out',default='ai-settings-browser-results');ap.add_argument('--chromium');ap.add_argument('--browsers',default='chromium,webkit');args=ap.parse_args()
    out=Path(args.out).resolve();out.mkdir(parents=True,exist_ok=True)
    server=ThreadingHTTPServer(('127.0.0.1',0),Upstream);threading.Thread(target=server.serve_forever,daemon=True).start();upstream=f'http://127.0.0.1:{server.server_port}'
    results={};
    with sync_playwright() as pw:
        for name in args.browsers.split(','):
            target=out/name;target.mkdir(exist_ok=True);app=App(target,upstream);browser=None;page=None
            try:
                app.start();launcher=getattr(pw,name);options={'headless':True}
                if name=='chromium':options.update(args=['--no-sandbox'],**({'executable_path':args.chromium} if args.chromium else {}))
                browser=launcher.launch(**options);ctx=browser.new_context(viewport={'width':1440,'height':1000},reduced_motion='reduce');key,val=app.cookie.split('=',1);ctx.add_cookies([{'name':key,'value':val,'url':app.base,'httpOnly':True,'sameSite':'Lax'}]);page=ctx.new_page();page.set_default_timeout(12000);errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
                r=exercise(page,app,target,upstream);r['pageErrors']=errors;assert not errors,errors;results[name]=r
            except Exception as e:
                if page:
                    try:page.screenshot(path=str(target/'failure.png'),full_page=True)
                    except Exception:pass
                results[name]={'failed':str(e)};raise
            finally:
                (out/'browser-results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2))
                if browser:browser.close()
                app.close()
    server.shutdown();print(json.dumps(results,ensure_ascii=False,indent=2))

def exercise(page,app,out,upstream):
    r={};migration_check(page,app,out);page.goto(app.base+'/settings/ai');expect(page.get_by_role('navigation',name='面包屑',exact=True)).to_contain_text('AI 配置');expect(page).to_have_title('AI 配置 · 工具箱 · MathPilot');expect(page.get_by_role('button',name='添加第一个提供方',exact=True)).to_be_visible();page.screenshot(path=str(out/'empty-light.png'),full_page=True)
    assert app.request(API,cookie='')[0]==401
    status,_,hdr=app.request('/api/auth/register','POST',{'email':'member@example.invalid','password':'Synthetic-Member1','inviteCode':INVITE},cookie='');assert status==201
    assert app.request(API,cookie=hdr['Set-Cookie'].split(';')[0])[0]==403
    def button(text):return page.get_by_role('button',name=text,exact=True)
    def tab(text):button(text).click()
    def settle():expect(button('保存配置')).to_be_disabled();expect(page.get_by_role('status')).to_contain_text('保存')
    def new(name,kind,protocol,suffix):
        button('添加第一个提供方' if not app.ok(API)['providers'] else '添加提供方').click()
        page.get_by_label('服务商预设',exact=True).select_option(kind)
        page.get_by_label('名称',exact=True).fill(name);page.get_by_label('API 地址',exact=True).fill(upstream+suffix)
        page.locator('summary').filter(has_text='高级设置').click()
        if kind!='sub2api':page.get_by_label('API 协议',exact=True).select_option(protocol)
        if kind=='sub2api':
            mode='antigravity_gemini' if protocol=='gemini_generate_content' else 'antigravity_claude' if protocol=='anthropic_messages' else 'openai'
            page.get_by_label('Sub2API 接口格式',exact=True).select_option(mode)
            expect(page.get_by_label('API 地址',exact=True)).to_have_value(upstream+suffix)
            expect(page.get_by_label('API 协议',exact=True)).to_have_value(protocol if mode!='openai' else 'auto')
            if mode=='antigravity_claude':page.locator('[name=models]').fill('models')
        page.locator('[name=apiKey]').fill('synthetic-browser-provider-key');page.get_by_label('启用此连接',exact=True).check();button('保存并获取模型').click()
        if '/claude/' in suffix:expect(page.get_by_role('alert')).to_contain_text('目录接口不可用')
        else:expect(page.get_by_role('status')).to_contain_text('模型已获取')
        tab('连接配置');expect(button('保存配置')).to_be_disabled();expect(page.locator('[name=apiKey]')).to_have_value('')
        return next(p for p in app.ok(API)['providers'] if p['name']==name)
    ds=new('DeepSeek · 合成验收','deepseek','chat_completions','/deepseek')
    # Guard dirty state and keyboard cancel. The saved key is not retrieved.
    page.get_by_label('名称',exact=True).fill('尚未保存');tab('任务分配');expect(page.get_by_role('dialog')).to_be_visible();page.keyboard.press('Escape');expect(page.get_by_label('名称',exact=True)).to_have_value('尚未保存');button('放弃修改').click();page.get_by_role('dialog').get_by_role('button',name='放弃修改',exact=True).click();expect(page.get_by_label('名称',exact=True)).to_have_value(ds['name'])
    page.get_by_label('API 地址',exact=True).fill(upstream+'/different-tenant');button('保存配置').click();expect(page.get_by_role('alert')).to_contain_text('范围已变化');assert app.ok(API)['providers'][0]['baseUrl']==upstream+'/deepseek';button('放弃修改').click();page.get_by_role('dialog').get_by_role('button',name='放弃修改',exact=True).click()
    tab('模型目录');button('获取模型').click();expect(page.get_by_role('status')).to_contain_text('目录');expect(page.get_by_text('Model-A',exact=True).first).to_be_visible()
    for theme in ['light','dark']:
        for width in [1024,1280,1440]:
            page.set_viewport_size({'width':width,'height':1000})
            if page.locator('html').get_attribute('data-theme')!=theme:button('外观').click()
            assert page.locator('html').get_attribute('data-theme')==theme
            sizes=page.evaluate('({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth})');assert sizes['scroll']<=sizes['width'],sizes
            for label in ['获取模型','添加模型']:
                b=button(label);expect(b).to_be_visible();metric=b.evaluate('e=>({height:e.getBoundingClientRect().height,fg:getComputedStyle(e).color,bg:getComputedStyle(e).backgroundColor})');assert metric['height']>=36;assert contrast(metric['fg'],metric['bg'])>=4.5,metric
            page.screenshot(path=str(out/f'models-{theme}-{width}.png'),full_page=True)
    page.set_viewport_size({'width':1440,'height':1000});r['desktopThemes']=6
    # Model-specific effort survives catalog refresh, without altering other models.
    model_card=page.locator('article').filter(has=page.get_by_text('Model-A',exact=True))
    model_card.get_by_role('button',name='编辑',exact=True).click();page.get_by_label('此模型思考档位',exact=True).select_option('high');button('保存模型').click();expect(page.get_by_role('status')).to_contain_text('模型已保存')
    button('获取模型').click();expect(page.get_by_role('status')).to_contain_text('目录')
    assert next(m for m in next(p for p in app.ok(API)['providers'] if p['id']==ds['id'])['models'] if m['id']=='Model-A')['metadata']['reasoningEffort']=='high'
    tab('连接测试');page.get_by_label('测试模型',exact=True).select_option('Model-A');page.get_by_label('测试项目',exact=True).select_option('vision');page.get_by_label('我同意发送合成样本',exact=False).check();button('测试模型').click();expect(page.get_by_role('status')).to_contain_text('测试样本通过');tab('模型目录')
    r['perModelEffort']=True;r['imageChallenge']=True
    # Manual case-sensitive model, duplicate rejected; blank form cannot submit.
    button('添加模型').click();button('保存模型').click();expect(page.locator('[name=modelId]')).to_be_focused();page.locator('[name=modelId]').fill('Manual-Case');page.get_by_label('文本能力',exact=True).select_option('supported');page.get_by_label('图片能力',exact=True).select_option('unsupported');page.get_by_label('结构化能力',exact=True).select_option('supported');button('保存模型').click();expect(page.get_by_text('Manual-Case',exact=True)).to_be_visible()
    button('添加模型').click();page.locator('[name=modelId]').fill('Manual-Case');button('保存模型').click();expect(page.get_by_role('alert')).to_contain_text('已存在');button('关闭编辑').click();page.get_by_role('dialog').get_by_role('button',name='放弃修改',exact=True).click();button('获取模型').click();expect(page.get_by_role('status')).to_contain_text('目录');assert any(m['id']=='Manual-Case' for m in app.ok(API)['providers'][0]['models'])
    gm=new('Sub2API · Gemini','sub2api','gemini_generate_content','/tenant/antigravity/v1beta');tab('模型目录');button('获取模型').click();expect(page.get_by_role('status')).to_contain_text('目录')
    cl=new('Sub2API · Claude','sub2api','anthropic_messages','/claude/antigravity/v1');tab('模型目录');button('获取模型').click();expect(page.get_by_role('alert')).to_contain_text('目录接口不可用');button('添加模型').click();page.locator('[name=modelId]').fill('Claude-Alias');
    for cap in ['文本能力','图片能力','结构化能力']:page.get_by_label(cap,exact=True).select_option('supported')
    button('保存模型').click();expect(page.get_by_text('Claude-Alias',exact=True)).to_be_visible();tab('连接测试');expect(button('测试模型')).to_be_disabled();page.get_by_label('我同意发送合成样本',exact=False).check();button('测试模型').click();expect(page.get_by_role('status')).to_contain_text('测试样本通过');page.screenshot(path=str(out/'claude-diagnostics.png'),full_page=True)
    Upstream.slow=True;before=len(Upstream.calls);button('测试模型').click();expect(button('取消测试')).to_be_visible();
    for _ in range(40):
        if len(Upstream.calls)>before:break
        page.wait_for_timeout(50)
    assert len(Upstream.calls)==before+1
    button('取消测试').click();Upstream.slow=False;expect(page.get_by_role('status')).to_contain_text('已取消');time.sleep(.3);assert len(Upstream.calls)-before<=1
    # UI saves routes without requiring capability confirmation; capability labels are advisory only.
    tab('任务分配');state=app.ok(API);routing=state['routing'];target=lambda p,m:json.dumps({'providerId':p['id'],'modelId':m},separators=(',',':'))
    labels=['识题与转录','解析与文字优化','几何图重绘','作业批改']
    for label,p,m in [(labels[0],ds,'Manual-Case'),(labels[1],ds,'Model-A'),(labels[2],cl,'Claude-Alias'),(labels[3],ds,'Model-A')]:
        button(label+'主目标').click();page.get_by_role('combobox',name='搜索'+label+'主目标',exact=True).fill(m)
        if m=='Manual-Case':page.get_by_role('combobox',name='搜索'+label+'主目标',exact=True).press('Enter')
        else:page.get_by_role('option').filter(has_text=p['name']).filter(has_text=m).filter(has=page.get_by_text(m,exact=True)).click()
    expect(button('保存任务分配')).to_be_enabled()
    button('保存任务分配').click();expect(page.get_by_role('status')).to_contain_text('任务分配已保存');page.screenshot(path=str(out/'routing-dark-1440.png'),full_page=True)
    page.set_viewport_size({'width':1024,'height':768});page.screenshot(path=str(out/'routing-dark-1024.png'),full_page=True);assert page.evaluate('document.documentElement.scrollWidth<=document.documentElement.clientWidth');page.set_viewport_size({'width':1440,'height':1000})
    tab('提供方');page.set_viewport_size({'width':1024,'height':768});page.locator('aside').get_by_role('button').filter(has_text=gm['name']).click();expect(page.get_by_label('API 地址',exact=True)).to_have_value(upstream+'/tenant/antigravity/v1beta')
    if page.locator('html').get_attribute('data-theme')!='light':button('外观').click()
    assert page.evaluate('[document.documentElement.dataset.theme,document.documentElement.dataset.style]')==['light','classic'];page.screenshot(path=str(out/'connection-light-1024.png'),full_page=True);page.set_viewport_size({'width':1440,'height':1000})
    page.get_by_role('button',name=re.compile('的连接操作$')).click();button('复制连接（无 Key）').click();expect(page.locator('[name=apiKey]')).to_have_value('');expect(page.get_by_label('启用此连接',exact=True)).not_to_be_checked();button('保存连接').click();settle();copied=next(p for p in app.ok(API)['providers'] if p['name'].endswith(' 副本'));assert copied['hasApiKey'] is False
    page.get_by_role('button',name=re.compile('的连接操作$')).click();button('删除提供方…').click();page.get_by_role('dialog').get_by_role('button',name='删除提供方',exact=True).click();expect(page.get_by_role('status')).to_contain_text('提供方已删除');assert len(app.ok(API)['providers'])==3
    page.get_by_label('启用此连接',exact=True).uncheck();button('保存配置').click();expect(page.get_by_role('dialog')).to_contain_text('处引用');page.screenshot(path=str(out/'referenced-disable-confirmation.png'),full_page=True);page.get_by_role('dialog').get_by_role('button',name='取消',exact=True).click();button('放弃修改').click();page.get_by_role('dialog').get_by_role('button',name='放弃修改',exact=True).click()
    # Actual business endpoints go through the shared gateway, not a mocked application API.
    # Recognition goes to the model routed above (Manual-Case): capability labels never redirect a call.
    for path,body,model,prefix in [('/api/recognize',{'image':IMAGE,'categories':[]},'Manual-Case','/deepseek'),('/api/optimize',{'stem':'合成验收题：计算 x','options':[],'tags':[]},'Model-A','/deepseek'),('/api/reconstruct-diagram',{'image':IMAGE,'stem':'线段 AB','imageAspectRatio':1.5},'Claude-Alias','/claude/antigravity/v1')]:
        before=len(Upstream.calls);data=app.ok(path,'POST',body);calls=Upstream.calls[before:];assert len(calls)==1,(path,data,calls);assert calls[0]['model']==model and calls[0]['path'].startswith(prefix),(path,calls)
    r['businessRoles']=['recognition','text','diagram'];r['threeProviders']=len(app.ok(API)['providers'])==3
    current=app.ok(API);p=next(x for x in current['providers'] if x['id']==ds['id']);assert app.request(API+'/'+p['id'],'DELETE',{'expectedRevision':p['revision']})[0]==409
    # Real persistence and optimistic conflict through HTTP.
    write={k:p[k] for k in ['name','kind','baseUrl','wireApi','endpoints','enabled','timeoutMs','catalogTimeoutMs','outputStrategy','reasoningEffort']};write.update(expectedRevision=p['revision'],credential={'action':'keep'})
    assert app.request(API+'/'+p['id'],'PATCH',write)[0]==200;assert app.request(API+'/'+p['id'],'PATCH',write)[0]==409
    assert 'synthetic-browser-provider-key' not in json.dumps(app.ok(API))
    r.update(permissions=True,dirtyGuard=True,scopeGuard=True,directoryFailureManualModel=True,modelProbe=True,probeCancellation=True,capabilityAdvisory=True,referenceDeleteGuard=True,revisionConflict=True)
    word_export(page,app,out)
    r['wordExport']=True;r['desktopSelectorAndThemeButton']=True;r['copyWithoutKeyAndDelete']=True;r['referencedDisableConfirmation']=True
    page.goto(app.base+'/settings/ai');expect(page.get_by_role('navigation',name='面包屑',exact=True)).to_contain_text('AI 配置');expect(page).to_have_title('AI 配置 · 工具箱 · MathPilot');page.screenshot(path=str(out/'connection-final.png'),full_page=True)
    return r

def migration_check(page,app,out):
    js="const c=require('node:crypto');const iv=c.randomBytes(12);const key=c.createHash('sha256').update(process.argv[1]).digest();const a=c.createCipheriv('aes-256-gcm',key,iv);const bytes=Buffer.concat([a.update('synthetic-browser-provider-key'),a.final(),a.getAuthTag()]);console.log(JSON.stringify({v:1,iv:iv.toString('base64'),data:bytes.toString('base64')}));"
    cipher=subprocess.check_output(['node','-e',js,SECRET],text=True).strip()
    # No AI endpoint has been read yet, so V2 is still explicitly pending.
    app.sql("INSERT INTO ai_provider_config VALUES ('global','旧配置迁移验收','"+app.upstream+"/legacy/v1','"+cipher+"','chat_completions','[]','Model-A','','','',1,123456)")
    state=app.ok(API);p=state['providers'][0];assert p['id']=='legacy-global';assert [x['primary']['modelId'] for x in state['routing']['routes']]==['Model-A']*4
    app.ok(API+'/legacy-global/models/discover','POST',{'fingerprint':p['fingerprint']})
    rows=app.sql("SELECT p.api_key_encrypted=new.api_key_encrypted AS equal, new.cipher_version FROM ai_provider_config p JOIN ai_providers new ON new.id='legacy-global'");assert rows[0]['equal']==1 and rows[0]['cipher_version']==1
    page.goto(app.base+'/settings/ai');page.get_by_role('button',name='提供方',exact=True).click();expect(page.get_by_role('heading',name='旧配置迁移验收',exact=True)).to_be_visible();page.screenshot(path=str(out/'legacy-migrated.png'),full_page=True)
    state=app.ok(API);routing=state['routing'];routing['allowEnvironmentFallback']=False
    for route in routing['routes']:route['primary']=None
    app.ok('/api/admin/ai-routing','PUT',routing);app.ok(API+'/legacy-global','DELETE',{'expectedRevision':1});assert app.ok(API)['providers']==[];assert app.ok(API)['migrationState']=='complete'
    (out/'migration.json').write_text(json.dumps({'ciphertextByteEqual':True,'legacyCipherVersion':1,'decryptionProvedByAuthenticatedCatalog':True,'effectiveRoleModels':['Model-A']*4,'deleteDoesNotResurrect':True},indent=2))

def contrast(a,b):
    def lum(c):
        x=[float(v)/255 for v in re.findall(r'[\d.]+',c)[:3]];x=[v/12.92 if v<=.04045 else ((v+.055)/1.055)**2.4 for v in x];return sum(v*w for v,w in zip(x,[.2126,.7152,.0722]))
    x,y=sorted([lum(a),lum(b)]);return (y+.05)/(x+.05)

def word_image():
    # Visible, deterministic geometric fixture; no image library or external asset.
    w,h=160,100; raw=bytearray()
    for y in range(h):
        raw.append(0)
        for x in range(w):
            edge=(18<=x<=22 and 20<=y<=82) or (78<=y<=82 and 20<=x<=142) or (20<=x<=140 and abs(y-(x/2+10))<1.5)
            raw.extend((25,35,45) if edge else (255,255,255))
    def chunk(name,data):return struct.pack('>I',len(data))+name+data+struct.pack('>I',zlib.crc32(name+data)&0xffffffff)
    png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',w,h,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(raw))+chunk(b'IEND',b'')
    return 'data:image/png;base64,'+base64.b64encode(png).decode()

def word_export(page,app,out):
    mod=app.ok('/api/modules','POST',{'module':{'name':'V2 验收题库'}})['module']
    # Real application data, safe synthetic material. Fraction + picture exercise native Word structures.
    q={'moduleId':mod['id'],'categoryId':mod['id'],'type':'单选题','difficulty':'基础','stem':'合成验收：计算 $x=\\frac{1}{2}$。','options':['$\\frac{1}{2}$','1','2','4'],'answer':'A','analysis':'分数保持为可编辑公式：$\\frac{1}{2}$。','source':'V2 本地验收','tags':[],'contentImages':[word_image()],'imageLayout':'right','createdAt':1,'updatedAt':1}
    app.ok('/api/questions','POST',{'question':q});page.goto(app.base+'/library');expect(page.locator('.user-chip')).to_contain_text(ADMIN);page.locator('.tree-row.module-root',has_text='V2 验收题库').click();expect(page.locator('.question-card')).to_have_count(1);page.locator('.question-card button.check').click();page.locator('.export-button').click();expect(page.get_by_role('button',name='生成 Word',exact=True)).to_be_visible()
    with page.expect_download() as dl:page.get_by_role('button',name='生成 Word',exact=True).click()
    path=out/'actual-page-export.docx';dl.value.save_as(str(path));page.screenshot(path=str(out/'question-bank-after-word-export.png'),full_page=True)
    with zipfile.ZipFile(path) as z:
        xml=z.read('word/document.xml').decode();assert 'oMath' in xml;assert 'Times New Roman' in xml;assert 'Songti SC' in xml;assert '<w:drawing>' in xml;assert any(n.startswith('word/media/') for n in z.namelist())
        report={'nativeMath':xml.count('<m:oMath>'),'tables':xml.count('<w:tbl>'),'imageParts':len([n for n in z.namelist() if n.startswith('word/media/')]),'fontContracts':['Times New Roman','Songti SC']};assert report['tables']>0
        (out/'word-structure.json').write_text(json.dumps(report,indent=2))

if __name__=='__main__':main()
