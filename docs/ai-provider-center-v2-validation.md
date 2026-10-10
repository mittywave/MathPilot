# AI Provider Center V2 — 验证与升级说明

## 范围与版本

目标仓库：`mittywave/zhiti-local-question-bank`。开发分支：`feature/ai-provider-center-v2`，PR #3。主分支核对基线为 `8ab8dba8e48524a206d245968772b42728b42b96`；本轮接续实现基线为 `e6fc4b381ead6d8fa6a10584030c4f4dd8578b85`。完整需求见同目录 `ai-provider-center-v2-taskbook.md`。

最终功能代码：`eb5179423141689fbcac6bcb52528c61c9748c05`；源码树：`e00f59ede7fa09cf0df7178b29b6ada301a1f317`。本说明的后续提交仅整理证据，不改变该功能代码。

状态：已提交开发侧验证，等待仓库所有者最终验收。两套 PR CI 在上述功能提交通过。没有合并 main、部署生产或执行远程数据库迁移。以下区分代码覆盖、实测结果和未验证边界，不以 fixture 成功代替真实服务验收。

## 本轮补齐

- DeepSeek Chat 与 Responses 分别构造请求；不再复制 OpenAI body 后删字段。Chat 使用 JSON mode 与独立 thinking 参数，Responses 使用 text.format/reasoning。只解析最终正文。
- 模型目录新增模型级思考档位；保存于既有模型 metadata JSON，无须新建或改写已执行迁移。只使用当前模型的目录能力，支持恢复上游默认或兼容默认；刷新目录保留模型覆盖项，修改覆盖项使旧探测记录失效。
- Sub2API 明确区分 OpenAI、Antigravity Gemini、Antigravity Claude。切换模式不改写用户 Base URL；建议地址独立确认应用，保留部署/租户前缀。Claude 不默认断言目录存在，手动模型仍可使用。改变凭据范围需要重新输入 Key。
- 管理错误附带不可回放的 diagnosticId；服务端仅记录编号、稳定错误码、状态，不记录原始异常、正文、Header 或 Key。429 保留 Retry-After。
- 图片探测改为四张独立合成色块。正确顺序只留在服务端验证函数，不放入提示或 schema。未通过后置校验不会记为成功，也不会触发备用。它仍不是题库视觉质量认证。
- OpenAI 兼容 Chat 仅在明确不支持 max_completion_tokens 时尝试有界 max_tokens 兼容，保留同样输出上限和总预算。非 JSON 的 429 保持限流分类，不轮换提供方。
- 模型编辑中不能再次点击新增/编辑覆盖未保存表单。保留取消、dirty、焦点和键盘确认操作；保存栏回归文档流，修复手机任务分配中浮动栏遮挡字段的问题。
- 作业 E2E 的数据库观察改为实际本地 D1 SQLite 的只读查询，避免每次断言/清理轮询额外启动 Wrangler/workerd。该修正单独使用不足以消除热重载代理超时；最终由 `scripts/start-local-test-worker.mjs` 直接运行相同的 Vinext 编译产物和锁文件中的 Miniflare/workerd，使用真实本地 D1、R2、队列，去除长流程中非业务的 Wrangler 热重载反向代理。全部作业、队列、权限、清理和 404 断言及 HTTP 超时保持原样；公共/个人题库 E2E 同样使用该运行器。浏览器套件仍独立验证实际 `wrangler dev`，未将应用 API 或数据库换成 mock。
- Word 从真实网页下载后，使用独立 LibreOffice profile 转 PDF，再渲染每页 PNG。逐页检查发现原生成段落的行高会裁切分数和内联图片，已在 `lib/export-word.ts` 明确使用 AUTO 行高，并为图片保留可伸展单行。新增实际 DOCX 构造器回归测试；原生 OMML、表格、图片及原始导入 Word 段落保持。最终两浏览器重新下载的四页均已逐页查看。

## 验证结果与证据

本地执行记录（2026-09-27 UTC）：

| 项目 | 结果 | 边界 |
|---|---|---|
| 依赖 | GitHub 隔离 workspace 的 npm ci 成功，锁文件未改 | 本地使用该锁文件对应依赖归档；未伪称本机在线 npm ci |
| npm run lint | 通过，0 errors / 17 warnings | 既有 warning 未隐藏 |
| npm run test:studio | 140/140 通过 | 不替代实际应用浏览器 |
| V2 + Word 新增相关专项 | 55/55 通过（V2 54 + Word 1） | SQLite + 合成上游；Word 用实际构造器，非真实 AI |
| npm run benchmark:studio | 通过 | 请求数与并发断言保留 |
| npm test（本轮首轮） | 最终通过 | 337 项普通回归通过；作业 E2E 首次通过；scoped-library E2E 首次 GET /api/students 超时，既有单次重试通过，不能称首次全绿 |
| tsc --noEmit | 未通过，exit 2 | 接手基线 e6fc4b3 和最终代码均 237 个诊断；4 处同样缺失 D1Database 的提示由 TS2304 改成附 IDBDatabase 建议的 TS2552，其余去掉行号后相同。不是全量类型检查通过，也不能据此声称 V2 相对原 main 没有类型问题 |
| 本机 Chromium | 未通过环境导航 | ERR_BLOCKED_BY_ADMINISTRATOR；未关闭浏览器安全策略，改用仓库 Actions 的实际浏览器验收 |

### 首轮与修正记录

- 隔离核对运行 `36301778290`、`36301947682`：补丁树校验、lint、Studio、benchmark、全量回归通过，但额外连续作业检查仍出现 `/api/homework-assets/<id>` 请求超时；后续浏览器和 Word 步骤被跳过。这两轮不是最终验收通过。
- 调查已安装 Wrangler 的 `ProxyWorker` GET 失败重排队路径后，将长流程套件改为直接 Miniflare/workerd；没有修改生产 Worker、跳过权限/404 检查、扩大超时或添加“失败也通过”。直接运行器仍使用编译后的真实应用，以及同一隔离状态目录中的真实 D1/R2/队列，不使用远程绑定或真实凭据。
- 最终直接运行器在本机的 homework、scoped-library 两个完整流程均首轮通过。最终 CI 和视觉结果见下方，不以这些本地结果推断浏览器成功。

### 最终功能提交的 CI（2026-09-27 UTC）

- [Math and recognition regression — 36303548850](https://github.com/mittywave/zhiti-local-question-bank/actions/runs/36303548850)：regression 与 browser 均 success。
- [AI Provider V2 validation — 36303548849](https://github.com/mittywave/zhiti-local-question-bank/actions/runs/36303548849)：validation success。

| 最终检查 | 实际结果 |
|---|---|
| npm ci / lint / Studio / benchmark | 通过；Studio 140 项，lint 保留既有 warnings |
| npm test | 340 项普通回归 + 1 个完整作业 E2E + 1 个完整公共/个人题库 E2E 通过；该轮日志无 not ok、整轮重试或跳过 |
| 三次独立作业 E2E | 第 1、2、3 次分别 pass 1 / fail 0 / skipped 0，无失败重跑 |
| 真实 Chromium / WebKit | 两者通过；每种浏览器 390、768、1440px × 深浅两主题，共 12 个组合 |
| 四类真实业务路径 | recognition/text/diagram 在浏览器的真实 Worker/D1 路径检查；grading 在实际本地 D1/R2/队列 E2E 中检查；只有外部 AI 是合成服务 |
| Word | 两浏览器各实际下载 1 个 DOCX；每个含 7 个原生数学对象、2 张表格和 1 个图片部件；每份渲染 2 页，全部 4 页已逐页查看 |
| 独立 TypeScript | 仍有上述 237 项诊断，明确未通过 |

证据：Math 运行的 `studio-browser-results` artifact（ID `10926810513`）包含 `ai-settings-browser-results/browser-results.json`、各浏览器截图、原始 DOCX、`word-pages/rendered.pdf`、`page-1.png`、`page-2.png`、`render-report.json`。V2 运行的 `ai-v2-validation-logs` artifact（ID `10926586587`）包含完整回归及三个独立作业日志。Actions 保留 7 天，应及时下载保留。

### 逐页视觉核对与前后证据

实际查看最终 Chromium 与 WebKit 的 Word 两页：题干、选项及解析中的分子/分母完整，三角形图片完整，不再裁成横条；字体、表格和图片位置未出现本次样例可见的裁切。渲染器为 LibreOffice 24.2.7.2；Linux 字体替代不是 Mac Word/WPS 认证。

实际查看最终 `routing-dark-390.png`：保存栏位于任务配置之后，未覆盖标签或输入框；查看 WebKit `models-dark-390.png` 与 Chromium `models-light-1440.png`：获取/添加模型按钮文字可辨认，模型能力来源和 unknown 状态清楚。完整 12 组主题/尺寸截图均保存在 artifact，不能把仅 DOM 断言当视觉验收。

本轮补齐前 e6fc4b3 的截图来源是运行 [36296284989](https://github.com/mittywave/zhiti-local-question-bank/actions/runs/36296284989) 的浏览器 artifact；这是“本轮补齐前”，不是旧 main 的页面。核心实现中间运行 `36302487928` 的旧 Word 渲染出现裁切、手机保存栏存在遮挡；最终功能提交重新导出、渲染并检查后修复。不要拿中间渲染成功冒充最终视觉通过。

中间 CI `36302487928` 的全部应用检查已通过，但最后 Git 对象归档步骤失败；恢复运行 `36303027900` 遇 Actions token 写树权限限制。之后通过仓库连接器提交了相同校验树，并追加 Word/手机布局修复，最终由上述两套标准 CI 重新验证。两份临时 provisioning/recovery workflow 已从最终分支删除，没有自动部署或合并。

常规持续验证：

- `.github/workflows/math-recognition-regression.yml`：lint、Studio、benchmark、全量回归；实际 Worker/D1 + Chromium/WebKit；Word 每页渲染；上传 `studio-browser-results` 和 regression 日志。
- `.github/workflows/ai-provider-v2-validation.yml`：全量入口、原始源码归档、保留失败的首轮日志，另外独立运行作业 E2E 三次，每轮失败即停止，不能用后一轮掩盖前一轮。
- `scripts/verify-ai-settings-browser.py`：真实 layout、全局 CSS、主题初始化、390/768/1440 宽度与深浅主题、按钮对比度、CRUD/迁移/路由/能力/取消/冲突/真实 Word 下载。外部 AI 服务为本机合成 HTTP fixture；本站 API、身份验证、D1 与 Worker 不 mock。
- `scripts/render-word-evidence.py`：实际 DOCX 的每页 PNG、`render-report.json` 与文件哈希。渲染成功不是人工视觉签字，更不代表 Word/WPS 实机兼容认证。

## 接入策略及真实实例边界

| 接入 | 代码/契约验证 | 真实实例 |
|---|---|---|
| OpenAI 兼容 | Responses、Chat；固定或同范围 auto；有界参数协商、输入图片、本地结构校验 | 未验证任意第三方中转站 |
| DeepSeek | 动态 /models 元数据；根地址不强加 /v1；Chat JSON mode、Responses text.format；模型级能力/档位；reasoning 与正文分离 | 未使用真实 Key，未执行计费 smoke |
| Sub2API OpenAI | 部署前缀内 Responses/Chat，模型别名原样保留 | 未验证用户部署版本/分组 |
| Sub2API Gemini | 明确 /antigravity/v1beta 等用户前缀；generateContent、inlineData、schema 转换 | 未验证用户实例 |
| Sub2API Claude | 明确 /antigravity/v1 等用户前缀；Messages 图片块及正文；目录缺失可手动配置 | 未验证用户实例 |

协议文档复核入口（2026-09-27）：DeepSeek `https://api-docs.deepseek.com/api/create-response/`、`https://api-docs.deepseek.com/api/list-models/`、`https://api-docs.deepseek.com/guides/thinking_mode/`。Sub2API 路径仍以用户实例对外文档为准，预设不是连通性保证。

真实 smoke 只在管理员本地私密填写 Key 后，通过设置页明确勾选可能计费并点击测试；不要在聊天、Issue、PR、日志或截图公开 Key。需要记录版本/镜像标签、对外 Base URL、模型 ID、分组和脱敏结果。不需要 Google/Anthropic 的账号密码或 OAuth refresh token。目录通过、简单 JSON 通过、实际题目质量验收是三件事。

## 数据与并发

仍只新增 `0015_ai_provider_center_v2.sql` 相对原任务书基线的表结构；没有改写 0014，没有 DROP 旧表。本轮模型参数复用 metadata JSON，没有额外 SQL 迁移。

首次读取 V2 在 D1 batch 中复制旧 global 到 legacy-global，保留原密文字节及 v1 解密；原四角色经旧选择规则解析后写入。新 Key 是绑定 providerId 的 v2 AES-GCM。完成标记防止重复迁移和删除后复活。只有 V2 可写，旧写接口返回 409。

Provider revision、全局 configuration revision、带 CHECK 的 write guard 和数据库引用限制共同保护并发。目录与探测有配置版本检查；模型级参数有独立配置指纹，旧诊断变更后失效。删除仍被主/备/默认引用的连接返回 409；停用须确认，不自动换到其他提供方。

未知能力的历史模型仅为保持原绑定允许旧契约继续；新路由依实际图片输入校验。人工能力标注只代表管理员声明，不代表测试通过。

## 本地更新与验收

先运行 `git status --short`。存在未提交修改时先自行保存；不要执行 reset --hard 或 force checkout。工作区干净后：

```bash
 git fetch origin
 git switch feature/ai-provider-center-v2
 git pull --ff-only
 npm ci
 npm run dev
```

`npm run dev` 执行本地迁移，不操作远程 D1。建议单独克隆或使用独立工作树/本地数据库备份，避免试验影响日常题库。项目规则以 AGENTS.md 为准。

自建/第三方网关现在采用零额外配置接入：管理员在 `/settings/ai` 填写公开 HTTPS Base URL 与 API Key 后即可直接保存、探测和用于路由，不再要求 `AI_PROVIDER_ALLOWED_BASES` 或修改 `.env.local`。本地开发默认密钥只用于本地；仍需保留原 `AI_PROVIDER_ENCRYPTION_KEY`，不要为了升级生成新 Secret 导致旧 Key 无法解密。生产侧继续拒绝非 HTTPS、明显的本机/私网/云元数据目标，并拒绝上游重定向。

本地回归：

```bash
 npm run lint
 npm run test:studio
 npm test
 npm run benchmark:studio
 python -m pip install playwright==1.57.0
 python -m playwright install chromium webkit
 python scripts/verify-ai-settings-browser.py --out ai-settings-browser-results --browsers chromium,webkit
 python scripts/render-word-evidence.py ai-settings-browser-results/chromium/actual-page-export.docx --out ai-settings-browser-results/chromium/word-pages
 python scripts/render-word-evidence.py ai-settings-browser-results/webkit/actual-page-export.docx --out ai-settings-browser-results/webkit/word-pages
```

渲染需安装 LibreOffice、Poppler 和合适中文字体；Linux CI 安装 Noto CJK。DOCX 中的宋体/Times New Roman 字体契约仍检查，Linux 渲染时的可用字体替代不能声称等同用户 Mac 或 Word/WPS。

用户最终验收：旧连接仍可调用；分别添加三个接口模式/官方连接，刷新或手工模型；按模型设置档位；给四角色分配不同模型；检查缺图能力拒绝、换地址换 Key、未保存切换、取消和主备同意；深浅主题及手机宽度；真实样例识题、优化、重绘、批改；实际 Word 下载并逐页检查公式、表格和图。

## 生产升级与回退（均需另行授权）

先备份远程 D1 和当前发布代码，保留原加密 Secret；在独立本地数据副本演练 0015 与旧数据复制，确认旧密文可解密，再单独授权生产 schema migration 和发布。不要运行本地验证命令的 --remote 变体。本次没有执行这些生产步骤。

代码回退不等于数据恢复。旧 global 表只是升级前快照，不含 V2 后新增的 Provider、路由、模型或换 Key。回到旧代码时只能恢复该旧快照的行为；要完整回到升级前，需按备份恢复数据库与原 Secret。要保留 V2 新增设置，应先在私密受控备份中保留整套 V2 数据，再确定转换方案，不能声称保留旧表即可自动无损回退。

## 剩余边界

真实 DeepSeek/Sub2API 计费调用和 Word/WPS 实机验收未执行。自定义 Provider 不再依赖目的地 allowlist；生产环境只接受 HTTPS，并拒绝明显的本机、私网、云元数据目标以及上游重定向。该字符串/URL 层防护不等于 DNS 解析后地址固定，不能宣称消除了 DNS rebinding 等所有 SSRF 风险；若未来允许不受信任的管理员配置 Provider，应增加受控出站代理或解析后网络策略。流式上游不会冒充非流式成功。模型简单合成能力测试不代表复杂题库质量。上层作业队列保留独立有界恢复，不能宣称全系统 exactly-once。
