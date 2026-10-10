# AI Provider Center V2 — 最终验收交接补记

本文件补充 `ai-provider-center-v2-validation.md`，不能只看早先成功的一轮而遗漏后来复跑结果。最终分支版本、最新检查和验收状态见 [PR #3](https://github.com/mittywave/zhiti-local-question-bank/pull/3) 的提交与 Checks。

## 版本范围

- 业务功能与 UI/Word 修复：`eb5179423141689fbcac6bcb52528c61c9748c05`。该版本通过的 CI、截图与已逐页检查的两份 Word 见 validation 文档。
- 验证文档：`4aad5144fa7fa0f0bf867d115498c8fffe71d797`，仅文档。
- 浏览器夹具修正：`451fad952d78d646de0fc99a121d5b60aabbb875`，仅 `scripts/verify-ai-settings-browser.py`；不改变生产业务、协议、数据库迁移、UI 或 Word 输出。

## 文档提交后的复跑失败与修复

[运行 36303921556](https://github.com/mittywave/zhiti-local-question-bank/actions/runs/36303921556) 的普通回归通过，Chromium 完整流程通过，但 WebKit 在旧配置迁移夹具阶段启动额外 `wrangler d1 execute` 时，其 workerd 子进程发生内部错误。主应用 Worker 已成功启动并完成管理员注册；失败不是页面断言成功，也不能称这轮浏览器整体通过。原始失败保留在该运行的 `studio-browser-results`，`browser-results.json` 标出 WebKit failed，原始错误未用后续成功覆盖。

修复：初始 schema 仍由本地 Wrangler 建立；应用 Worker 启动后，夹具只访问该隔离临时目录内唯一具有 `ai_provider_config` 的真实 D1 SQLite 文件。只允许播种旧配置的 INSERT 和只读 SELECT，不允许任意变更；只读连接开启 query_only。这样不再与正在测试的 Worker 同时启动第二个 workerd。真正的旧配置到 V2 迁移、旧 Key 解密、角色解析、重复迁移与删除不复活仍由真实本站 API/Worker/D1 执行并断言，没有替换成 mock，没有扩大超时或把失败改成重试后自动通过。

修正的 Python 语法检查、真实临时 SQLite 播种/读取/拒绝其他写入用例已在开发环境通过。该提交以及本交接文件自动触发标准 CI，最新结果以 PR Checks 和交接评论的具体运行链接为准，不把尚未结束的检查写成成功。

## 验收入口

先阅读 `ai-provider-center-v2-validation.md` 的安装、备份、升级和回退说明，再从独立本地工作区检查功能分支。保留原数据库和 `AI_PROVIDER_ENCRYPTION_KEY`。不要覆盖未提交修改，也不要为了升级重新生成加密 Secret。

接入服务、目录/手动模型、四任务主备、旧数据迁移、能力/档位、换地址换 Key、取消、深浅主题和手机操作，以及实际下载 Word 的公式/表格/图片，均是所有者最终验收范围。

开发侧外部 AI 均为合成服务；真实 DeepSeek、用户 Sub2API 的版本/分组/模型别名必须私密本地测试，可能计费。不要将 Key 发布到聊天、PR、Issue 或截图。LibreOffice 逐页检查不是 macOS Word/WPS 认证。独立 TypeScript 检查仍有 validation 中披露的 237 项诊断，不是整库类型零错误。

没有合并 main、审批自己的 PR、部署生产或运行远程迁移。验收通过后，由仓库所有者决定后续合并和单独授权的生产步骤。

## 2026-09-27 follow-up: zero-config custom Provider

Owner acceptance feedback changed the custom-provider UX requirement: entering a public HTTPS Base URL and API Key in the AI Provider Center must be sufficient to save, test, and use the provider. The previous `AI_PROVIDER_ALLOWED_BASES` prerequisite was therefore removed from runtime validation and UI guidance.

Production still rejects non-HTTPS endpoints, obvious localhost/private/link-local/cloud-metadata targets, and redirects. Local synthetic browser/E2E fixtures retain an internal loopback-HTTP test switch only. This deliberately improves first-run usability while documenting that URL-string checks do not provide DNS pinning.
