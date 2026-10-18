# MathPilot

主开发仓库：<https://github.com/mittywave/MathPilot>。新功能、Issue、PR 和发布统一在 `mittywave` 维护；`mittyhua` 的历史开发成果通过保留父提交的合并纳入，不再作为主开发入口。

一个部署在 Cloudflare Workers 上的双入口题库：公共资源库用于发布只读共享资源；“我的题库”按账户完全隔离，供受邀请会员维护自己的模块、分类和题目。

## 题库与模块

- 公共资源库：访客可浏览题干、答案和解析；登录会员可在公共库内勾题导出 Word，并把题目复制成不受原题后续变化影响的私人副本。
- 我的题库：新账户从空库开始，可新建模块、分类和题目。私人题目及图片只允许所属账户读取。
- 两个入口使用同一网址和账号，但拥有彼此独立的组卷篮，不能把公共题与私人题混在同一份 Word 中。

模块由 D1 数据驱动，可新建、改名、修改副标题、拖动或用按钮排序。删除非空模块时会显示分类/题目计数，并要求输入完整模块名确认。导出标题默认使用“模块名 + 专项练习”。

迁移后公共库以“深圳中考 / 深圳自主招生考试 / 深国交入学考”及原副标题、顺序作为初始状态；它们不是页面中的固定模块，管理员可按普通模块继续编辑。

## 权限

- 访客：浏览公共题目、答案和解析，不能进入私人库、勾题、复制或下载。
- 普通会员：使用邮箱、密码和邀请码注册；只管理自己的私人库，可从公共库复制题目并分别从公共/私人库组卷。
- 线上管理员：账户权限仍受题库作用域限制，不能直接改公共库。
- localhost 本地管理员：免登录维护公共编辑库，并通过“发布公共资源库”完整镜像到线上。

所有写入、删除、导入和下载操作都会在 Worker API 中再次校验登录状态。前端隐藏按钮不是权限边界。

## 云端数据

- Cloudflare D1 保存用户、会话、题库、动态模块、分类、题目、发布版本、图片分块及图片访问关联。
- 密码使用 PBKDF2-SHA-256 加盐后保存，不保存明文。
- 登录使用 `HttpOnly`、`Secure`、`SameSite=Lax` Cookie。
- `ADMIN_EMAIL` 与 `REGISTRATION_INVITE_CODE` 必须通过 Wrangler Secret 配置，不能提交到 GitHub。

备份 JSON 包含 `scope`、模块、分类和题目。会员只能导入、导出自己的私人库；localhost 管理员备份公共编辑库。旧版顶级分类备份仍可导入，导入器会沿完整祖先链恢复其模块。

## 本地开发

```bash
npm install
npm run dev
```

日常服务的 Vite 依赖缓存保存在 `node_modules/.vite/serve`，构建使用 `node_modules/.vite/build`；通过 `STUDIO_TEST_STATE` 启动的隔离预览使用该状态目录下的 `node_modules/.vite/serve`。这样预览或构建重建缓存时，不会覆盖 3001 正在使用的依赖，避免“新建试题”等按需加载入口因旧缓存引用失效而报错。

本地注册和发布需要在未提交的 `.env.local` 或 `.dev.vars` 中配置：

```text
ADMIN_EMAIL=管理员邮箱
REGISTRATION_INVITE_CODE=邀请码
PUBLIC_LIBRARY_REMOTE_URL=https://tiku.mittysapce.uk
PUBLIC_LIBRARY_PUBLISH_TOKEN=至少32字节的随机密钥
```

AI 首选通过管理员页面 `/settings/ai` 配置；旧 `.env.local` / Worker Secret 仍作为未配置或停用数据库 Provider 时的回退。`npm run dev` 会自动执行本地数据库迁移，把两份本地配置安全合并到 Worker 使用的 `.dev.vars`，并仅为本地开发注入 `LOCAL_ADMIN_MODE=true`。绝对不要把 `LOCAL_ADMIN_MODE` 配置为线上 Secret。

一键发布先比对内容哈希，只上传变化实体和远端缺失图片；远端在暂存版本完成校验后原子切换。删除也属于完整镜像的一部分，任何失败都会继续展示上一公共版本。相同内容的图片按哈希复用。

## 部署

```bash
npm run db:audit:scoped:remote
npx wrangler d1 migrations apply zhiti-question-bank --remote
npx wrangler secret put ADMIN_EMAIL
npx wrangler secret put REGISTRATION_INVITE_CODE
npx wrangler secret put PUBLIC_LIBRARY_PUBLISH_TOKEN
npx wrangler secret put AI_PROVIDER_ENCRYPTION_KEY
npm run deploy
```

正式迁移前必须先取得 Cloudflare API Token、导出远程 D1 备份并运行远程计数审计。首次发布功能测试应使用两套隔离的本地 D1，不使用生产库。

线上地址：<https://tiku.mittysapce.uk>

## 智能录题

截图识别、文件批量识别、AI 优化和矢量重绘接口仅允许登录用户调用。相关 OpenAI/Sub2API 配置使用 Worker Secret；未配置时仍可使用人工录题、共享浏览和 Word 组卷。

## Word 组卷

登录后在当前题库勾选题目，点击底部“生成 Word”，可设置标题，并选择是否在文末附带答案与解析。服务端会再次验证题库作用域与每个题目 ID；文档为标准 `.docx` 格式。

## 验证

```bash
npm test
npm run lint
npm run db:audit:scoped
```

`npm test` 包含一项真实的双 Worker / 双 D1 集成测试，覆盖账户隔离、访客权限、模块排序与级联删除、私人图片、下载作用域、公共题独立复制、发布密钥、增量发布、失败回滚和完整镜像删除。

## AI Provider 管理与安全配置

访问 `/settings/ai`，填写 Base URL、API Key 和协议，获取上游模型（没有目录时可手动添加），至少选择一个任务模型后启用。分别支持识题、文字优化、几何图重绘、作业批改；空任务选择使用其他已选模型。启用但损坏的配置会明确报错，不会悄悄把材料发给另一家环境变量供应商。

生产首次使用前，在本机生成至少 32 字节随机值（例如 `openssl rand -base64 32`），然后通过 `npx wrangler secret put AI_PROVIDER_ENCRYPTION_KEY` 的交互提示保存。它只属于 Worker Secret，不是 GitHub Actions 的明文变量，也不应提交 `.env.local`、`.dev.vars` 或写入日志。该密钥用于加密 D1 中的 Provider API Key；必须妥善保存。更换加密密钥后，原密文不能再解密，需要在管理页面重新输入 Provider API Key；不要直接把本地开发密文迁到生产。

Base URL 的规范化地址（包含路径）变化时必须重新输入 Key。带凭据的重定向不被跟随；请填写最终 API 地址。生产仅支持 HTTPS，`LOCAL_ADMIN_MODE=true` **只能用于本地开发**，不得设置为线上 Worker Secret。自动管理员只在显式本地模式、真实请求 URL 为回环地址且 Host 一致时生效，不信任转发头或请求携带的 IP 头。

自动协议仅在兼容性/上游失败时尝试其他适配器；认证、限流、Retry-After、明确拒绝及输出截断不会触发隐藏的重复请求。遇到明确“不支持 reasoning/结构化格式”时进行有界参数协商，降级结果仍在服务端验证数据结构。协议探测结果按地址、模型及凭据摘要隔离，最多缓存 32 项、10 分钟；不缓存题目或答案内容。

Antigravity 模型探测使用 `/antigravity/v1beta/models`，兼容 OpenAI `data` 与 Gemini `models` 目录格式；中转站未实现目录接口时，手动添加模型即可。`AI_MODELS_TIMEOUT_MS` 默认 15 秒；`AI_REQUEST_TIMEOUT_MS` 默认 180 秒。识别可用 `RECOGNITION_TIMEOUT_MS` 单独覆盖。请求取消会传递到上游，不继续补发请求；已保存的转录页仍可续传。

## 合并、验证和发布流程

新工作在 `mittywave` 的 `feature/*` 或 `fix/*` 分支提交 PR 到 `main`。自动验证覆盖 lint、完整构建和回归测试、数学合同/性能回归及真实浏览器转录/Word 下载。测试使用隔离本地 D1 和模拟 AI，不需要生产凭据。

生产发布仍是手动操作，不会因合并自动发布。GitHub Actions 的 Deploy 工作流仅允许 `main`，并要求确认已有远程 D1 备份、已审阅待应用 SQL；测试通过后先执行 `wrangler d1 migrations apply ... --remote`，成功才部署。不要绕过失败的迁移。`AI_PROVIDER_ENCRYPTION_KEY` 在 Worker 中单独配置，GitHub Actions 只需要部署用的 `CLOUDFLARE_API_TOKEN`。

现有本地工作目录先保存/提交自己的修改，再执行：

```bash
git remote set-url origin https://github.com/mittywave/MathPilot.git
git fetch origin
git switch main
git pull --ff-only origin main
```

若 `--ff-only` 拒绝执行，保留本地修改并另开分支合并，不要使用 `reset --hard` 或强制推送覆盖历史。Git 的提交姓名、邮箱和 GitHub 登录身份由本机管理，仓库合并不会替换本机凭据。
