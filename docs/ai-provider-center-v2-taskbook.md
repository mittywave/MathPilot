# AI Provider Center V2 重构任务书

版本：1.0 · 编制日期：2026-09-26  
目标仓库：`mittywave/zhiti-local-question-bank`  
核对基线：`main` / `8ab8dba8e48524a206d245968772b42728b42b96`  
建议开发分支：`feature/ai-provider-center-v2`  
建议入库路径：`docs/ai-provider-center-v2-taskbook.md`

**状态：待开发任务书，不是已实现或已通过验收的说明。** 本文件的生成不包含代码提交、分支创建、线上发布或生产数据修改。开发开始时重新核对最新 main；不要为对齐本文件而重置、覆盖后来的有效提交。[R1]

---

## 0. 给执行开发工具的指令

在上述仓库中实施本任务书。先读根目录 `AGENTS.md` 和受影响目录内的项目规则，检查工作区、当前分支、远程地址和最新 main。在独立功能分支完成实现、测试和说明；不要覆盖用户未提交的修改，不要 force push，不要擅自合并 main 或部署生产。

交付的是能保存、能调用、能迁移旧配置、能通过实际浏览器验证的 AI 配置控制台，不是仅有页面的演示，不是静态假数据，不是只加几个 Provider 下拉选项。

本轮重点限定为 AI 设置、Provider 管理、模型发现、任务路由和协议适配。保留现有题库、会员权限、转录工作台、作业系统、公式解析、Word 导出、并发和断点恢复的契约。

执行中遇到未提供的真实服务信息，完成可离线验证的实现和契约测试，并准确列出未验证项。不要索要用户在聊天、Issue 或提交中公开真实 API Key。真实调用只用用户在本地私密配置的凭据，并明确提示测试可能计费。

## 1. 已核对的现状与必须纠正的假设

### 1.1 当前项目

项目使用 React、TypeScript、Vinext/Vite、Cloudflare Workers 和 D1；不是可以随意改成另一套框架的空项目。当前 AI 配置存于 `ai_provider_config` 的单条 `global` 记录，网关入口为 `callStructuredAi()`。已有安全校验、超时、取消信号、协议兼容降级、输出校验和能力缓存，应先梳理后复用。[R2][R3][R4]

设置页 `app/settings/ai/page.tsx` 使用大量内联样式。获取模型、添加模型按钮写死浅色背景但未指定对应前景色；`app/globals.css` 又设置了 `button { color: inherit; }`，在深色主题下会形成浅底浅字。原浏览器表单测试的独立构建没有加载真实全局样式，因此“独立表单测试通过”不能证明完整应用的深色 UI 正确。[R5][R6][R7]

### 1.2 DeepSeek 不能按旧印象实现

截至本任务书核对日期，官方文档列出的模型包括 `deepseek-flash`、`deepseek-v4-pro`，且 `deepseek-flash` 支持图片输入。DeepSeek 也提供 Responses API。因此不能把 `deepseek-chat` / `deepseek-reasoner` 写成永久固定的当前目录，更不能为整个 DeepSeek 品牌统一设置 `vision=false` 或“只支持 Chat Completions”。[R10][R11][R12]

使用 `/models` 的实际目录和能力元数据；已保存的用户自定义模型 ID 不应因为预设更新而被悄悄改名或删除。文档快照只能作为带日期的初始能力提示，不能冒充用户服务的实测结果。

### 1.3 Sub2API 与 Antigravity 不是协议的同义词

Sub2API 是网关；Antigravity 是其可接入的上游来源之一。上游来源不自动等于客户端应使用的协议。参考上游文档，Antigravity 的 Gemini 与 Claude 分别有 `/antigravity/v1beta/` 与 `/antigravity/v1/messages` 入口；部分部署还支持通用入口混合调度。[R15]

用户部署的版本、网关前缀、分组、模型别名和开放路径尚未提供。实现必须能显式配置这些差异，不能把上游 main 的默认路径冒充用户实例的已验证路径。

### 1.4 几何图重绘不是纯文本任务

当前 `reconstruct-diagram` 会把原题图片传给模型，要求模型返回矢量结构。不能因为某模型擅长数学推理，就把没有图片输入能力的模型绑定为该任务的默认值。[R8]

---

## 2. 产品目标与范围

将 `/settings/ai` 重做为“AI 配置中心”，允许同时保存多个官方 API、自建网关和兼容接口，并清楚回答：

- 当前有哪些提供方，哪一个已配置，哪一次测试成功，测试的是目录还是实际模型？
- 每一种题库任务实际使用哪个提供方、哪个模型、哪种协议？
- 失败后是否会发往另一提供方，可能多发几次请求，数据将发到哪里？

V2 必须交付：完整深浅主题 UI、多 Provider CRUD、模型目录与手动录入、按能力校验的四类任务路由、显式备用模型、DeepSeek 官方适配、Sub2API 的 OpenAI / Gemini / Claude 入口适配、旧配置迁移、真实页面与本地数据库测试。

本轮不做：计费充值中心、自动模型排行榜、多租户个人 Key 管理、聊天机器人、任意脚本式适配器、自动购买额度、后台定期付费探测。不要为了展示统计卡片编造价格、成功率、调用次数或“连接正常”。

## 3. UI 设计定稿方向

### 3.1 视觉语言

采用“石墨灰 + 克制的靛蓝强调色”的工具型控制台。以清晰、精致、耐看为目标，不做营销落地页。标题区保留少量品牌感；配置区减少厚边框和嵌套大卡片。

沿用应用已有 `html[data-theme]` 主题状态，不另存第二套主题。新增样式必须限定在 AI 配置中心的 CSS Module 或专属根类中，不修改全站 `button/input/select/nav` 等标签规则来解决局部问题。

以下是设计起点，不是已经测过对比度的最终色板；实现后必须实际检查配对颜色：

| Token | 深色建议 | 浅色建议 |
|---|---|---|
| 页面背景 | `#101218` | `#F6F7FB` |
| 内容表面 | `#191D27` | `#FFFFFF` |
| 次级表面 | `#222838` | `#EEF1F8` |
| 主文字 | `#F1F3F9` | `#172033` |
| 次文字 | `#AFB8CA` | `#536079` |
| 分隔边框 | `#343D50` | `#D7DEEC` |
| 主按钮背景 | `#5663D9` | `#4653C8` |
| 主按钮文字 | `#FFFFFF` | `#FFFFFF` |
| 焦点环 | `#A8B2FF` | `#4653C8` |

布局采用 4/8px 间距尺度；正文 14–16px，说明至少 13px，页面标题 26–30px。输入控件约 42px 高，移动端主要点击区域至少 44px。卡片圆角 12–16px，控件 8–10px。不要再用窄列、过小字号和一屏灰色说明来压缩信息。

正文、占位文字及可操作按钮的文本对比度按 WCAG AA 检查：普通文本至少 4.5:1，大文本至少 3:1。禁用组件也要保持可辨识文案，这是本项目额外验收要求，而非宣称 WCAG 对禁用组件有相同要求。[R16]

### 3.2 页面结构

```text
题库 / 设置
AI 配置中心                           本地环境 · 密钥加密可用
管理接入服务与任务模型                              [+ 添加提供方]

[提供方]  [任务分配]

┌ 提供方列表：约 272px ┐  ┌ 当前提供方详情：弹性宽度 ──────────────┐
│ 搜索                │  │ 我的 Sub2API          已保存 · 需测试  │
│ 我的 Sub2API        │  │ [连接配置] [模型目录] [诊断]           │
│ DeepSeek 官方       │  │                                      │
│ 兼容中转站          │  │ 类型、地址、密钥、协议、端点预览        │
│                     │  │ 高级设置（默认折叠）                   │
│ 环境变量配置：只读   │  │                                      │
└─────────────────────┘  └──────────────────────────────────────┘
                  未保存修改                       [放弃] [保存配置]
```

这是信息结构说明，不是需要照搬字符边框的视觉稿。

页面最大宽度建议 1280–1360px，左右留白 24–32px。小于约 900px 改为单列，提供方选择收进顶部选择器或抽屉；不要让手机用户先滚过所有 Provider 才能编辑当前内容。

“任务分配”是全局页面，不塞进某一个 Provider 的详情。因为主模型和备用模型可以来自不同 Provider，这样才能看清实际调用关系。

### 3.3 提供方列表与新建流程

每行只展示名称、类型、主机名、配置状态和任务引用数。复制、停用、删除放入更多菜单。复制配置默认不复制密钥。

新建时提供四种预设：OpenAI 兼容、DeepSeek 官方、Sub2API、自定义。预设负责填写建议值和说明，不代表连通性保证。切换预设不得悄悄覆盖已编辑的地址或复用不对应的 Key。

首次为空时只突出“添加第一个提供方”，不展示无意义的四张空任务卡或报错式环境变量提示。

### 3.4 连接配置

默认展示：名称、接入类型、Base URL、API Key、协议/输出模式。下方实时展示即将访问的模型目录和推理路径，隐藏任何凭据。

Key 输入仅允许查看当前手工输入的临时值。已保存 Key 只显示“已保存”，不能通过“眼睛按钮”从后端取回。地址/租户前缀/认证范围改变后显示警告并要求新 Key。

高级项包含请求超时、目录超时、结构化输出策略和端点相对路径。禁止直接提供任意 JavaScript、任意绝对 URL 的请求模板，禁止让自定义 Header 覆盖 Cookie、Host、认证边界等敏感字段。

保存、获取目录、测试模型使用独立进行中状态和 AbortController。取消测试不能被锁在一个禁用 fieldset 内。操作期间保留上下文；切换 Provider 或修改配置后，过期响应不得覆盖当前页。

保存草稿与启用路由分开：用户可以先保存未绑定任务的连接；页面必须显示“已保存，尚未分配任务”，不能显示“所有 AI 功能已启用”。路由激活时必须校验可用 Key、模型和能力。

### 3.5 模型目录

显示搜索、总数、刷新目录、手动添加和模型列表。每行包含准确 ID、展示名、文本/图片/结构化输出能力、能力来源和最后验证时间；未知显示“未确认”，不显示假勾。

模型 ID 按上游语义保留大小写，同一 Provider 中精确去重；不同 Provider 的同名模型是不同目标。目录刷新不得删除已绑定模型或手工配置；缺失项保留并标记“本次目录未返回”，不能静默替换模型。

没有目录 API 时允许手工添加并测试。目录刷新成功不等于模型推理成功；HTTP 200 不等于返回了有效数据。

### 3.6 状态与交互

状态拆成“配置状态”“目录探测”“模型探测”，不要压成一个在线绿点。模型测试结果必须绑定配置版本、Key 版本、模型与协议，配置变化立即失效，并显示测试时间。

页脚仅有当前页主要提交动作；未保存时显示 dirty 状态。换 Provider、返回题库、关闭编辑器时提醒保存/放弃。保存后由后端返回的版本刷新 UI；并发编辑冲突给出可操作提示，不自动覆盖。

错误就近显示，聚焦第一个错误字段。保留用户其他输入。成功用轻量 toast 或状态条，不弹浏览器 alert。提示必须有文字，不能只靠红绿颜色。菜单、对话框、选择器、抽屉支持键盘、焦点返回和屏幕阅读器。

动画建议 120–180ms，只用于状态变化；尊重 reduced motion，不加自动播放背景、粒子和重动画依赖。

## 4. Provider 与协议的类型边界

以下为目标契约示意，实施时统一放入共享类型，不复制到每个组件：

```ts
export type ProviderKind =
  | 'openai_compatible'
  | 'deepseek'
  | 'sub2api'
  | 'custom';

export type WireProtocol =
  | 'auto'
  | 'responses'
  | 'chat_completions'
  | 'gemini_generate_content'
  | 'anthropic_messages';

export type AiTaskRole = 'recognition' | 'text' | 'diagram' | 'grading';
export type CapabilityState = 'supported' | 'unsupported' | 'unknown';

export interface ModelTarget {
  providerId: string;
  modelId: string;
}

export interface AiTaskRoute {
  role: AiTaskRole;
  primary: ModelTarget | null; // null 表示按实际输入使用明确的全局默认目标
  fallback: ModelTarget | null;
  fallbackEnabled: boolean;
}

export interface AiRoutingConfig {
  revision: number;
  defaultTextTarget: ModelTarget | null;
  defaultVisionTarget: ModelTarget | null;
  allowEnvironmentFallback: boolean;
  routes: AiTaskRoute[];
}

export interface CapabilityEvidence {
  state: CapabilityState;
  source: 'catalog' | 'documentation' | 'probe' | 'manual';
  observedAt: number;
  configurationFingerprint: string;
}
```

保留既有任务 role，不随意改成 `vision/homework` 造成调用方不兼容。保留旧 `antigravity_gemini` 值的迁移映射；新类型不能让旧配置无法读取。

ProviderKind 负责产品预设与参数策略，WireProtocol 负责实际请求/响应格式，EndpointProfile 负责部署前缀与路径，ModelCapability 负责模态和参数能力。不得互相用一个字符串替代。

## 5. 接口兼容要求

### 5.1 OpenAI 兼容接口

保留 Responses 与 Chat Completions 两条适配。不能假设所有“兼容”站点都实现全部可选参数。支持按配置固定协议；auto 只能在明确允许的同一接入范围内切换，不按模型名盲目转去另一业务前缀。

结构化输出根据模型和协议能力选择。优先有证据支持的 schema 模式，必要时用 JSON mode + 明确格式提示；所有模式最终都必须通过本地结构与业务校验。OpenAI 的 JSON mode 与 Structured Outputs 不是相同的结构保证。[R17]

不能用任意 400 触发删参数重试。只有明确识别出的 unsupported-parameter 错误才允许有界降级；权限、余额、模型不存在、无效业务 schema、拒绝和截断应保留原因。

### 5.2 DeepSeek 官方

预设 Base URL 为 `https://api.deepseek.com`，默认请求路径分别为 `/models`、`/chat/completions`、`/responses`。不要让现有通用规范化函数无条件添加 `/v1`；兼容用户已填入的版本前缀时必须按实际文档和路径测试，而不是自动改写。[R10][R12][R13]

实现要求：

1. 动态拉取模型。解析存在的 `name`、`input_modalities`、`output_modalities`、`effort`、`api_capabilities` 等元数据；缺字段时保留 unknown。[R13]
2. Chat 模式按官方 JSON Output 文档使用 `response_format: {type: 'json_object'}` 并加入格式说明，避免先发送已知不兼容的 strict schema 再失败降级。[R14]
3. Responses 根据其独立契约使用 `text.format`，不要机械拷贝所有 OpenAI 请求字段。处理 completed/incomplete/failed，并读取最终文本而非 reasoning item。[R12]
4. 区分 Chat 的 `thinking` / `reasoning_effort` 与 Responses 的 reasoning 参数；根据能力展示档位，不能把同一组参数原样发送给所有 Provider。[R18]
5. 最终题库数据只来自最终正文，不能把 `reasoning_content` 拼进待解析 JSON 或 Word 正文。显示、导出和诊断日志都不记录模型内部推理内容。
6. 图片路由按具体模型验证。已确认的纯文本模型不接收原题图片；有图片能力的模型允许测试，不按品牌封禁。
7. 本轮以非流式业务返回为主；上游出现 SSE 时不得直接当 JSON 读取。若实现流式适配，按协议事件结束条件聚合、检查截断；不支持的流式响应明确报兼容错误，不伪装为空正文成功。

### 5.3 用户自建 Sub2API

接入类型选择 Sub2API 后，额外选择“本实例提供的接口格式”：

| 模式 | Base URL 的预设形态 | 调用方式 |
|---|---|---|
| OpenAI 兼容 | `https://网关/可选前缀/v1` | Responses 或 Chat Completions |
| Antigravity → Gemini | `https://网关/可选前缀/antigravity/v1beta` | Gemini generateContent |
| Antigravity → Claude | `https://网关/可选前缀/antigravity/v1` | Anthropic Messages |

这是可配置的默认形态，不是用户实例已通过的契约。仅接入网关向用户发放的 API Key；不要求题库保存 Google/Anthropic 登录态、OAuth refresh token 或上游账号密码。

保持路径前缀，最终端点可预览，防止 `/v1/v1`、`/antigravity/antigravity`、`/v1beta/v1`。Gemini 使用自己的图片内容块与 schema 转换，Claude 使用 Messages 对应的数据结构。不要把 Claude 请求发送到 Gemini 路径，也不要仅因模型名字出现 `gemini` 就把通用站点拼成 Antigravity 地址。[R15]

目录能力是独立能力。实际部署若不提供特定 `/models` 路径，返回“目录接口不可用，可以手动添加”，而不是把整个 Provider 判死。未经确认，不硬编码声称 Claude 模式一定存在某个模型目录地址。

网关分组和模型别名必须原样尊重；不同分组最好用独立 Provider 记录区分。通用入口混合调度是否开启由实例决定，不在客户端偷偷切换。[R15]

## 6. 任务路由、能力检查与备用策略

### 6.1 四类任务

| 任务 | role | 运行时最低要求 |
|---|---|---|
| 截图 / 文件识题、答案转录 | recognition | 处理图片时有图片输入能力；输出符合识别 schema |
| 文字优化 / 解析 | text | 纯文本时文本能力；附图时还需图片能力 |
| 几何图重绘 | diagram | 图片理解 + 矢量方案结构化输出 |
| 作业批改 | grading | 按调用实际是否有图片检查；评分输出符合既有契约 |

必须依据实际 `images` 等输入判定，不仅凭 role 名字。对于 text 路由收到图片但所选模型只支持文本：在请求前阻止并说明，或使用用户明确配置的合格目标；不丢图后继续，更不引入未经授权的 OCR 预处理链。

能力 unknown 可以通过显式模型测试或管理员标注补足。手工标注必须显示来源，不能伪装为实测。已知 unsupported 禁止绑定对应图片任务。迁移旧配置产生的 unknown 应保留旧绑定并显示待确认，不无故让原来工作的任务全部失效；新配置采用上述校验。

### 6.2 解析顺序

首先解析任务显式主目标；没有设置时，按实际输入选择明确的默认文本/图片目标。只有没有可用配置且允许环境配置时，才使用只读环境回退。明确配置但损坏、失效或被停用的目标，不能被当成“未配置”而自动绕过。

每个任务最多一个备用目标，默认不开启跨 Provider 自动回退。主备不能相同。备用必须具备同等输入模态和必要输出能力；诊断必须记录实际使用了备用。打开时说明题目、图片会发送给备用提供方，可能产生额外费用。

### 6.3 错误分类与请求预算

将同 Provider 协议兼容、同 Provider 重试、跨 Provider 备用区分开：

| 情况 | 默认动作 |
|---|---|
| 401/403、余额问题、模型不存在 | 停止，提示修正配置或权限 |
| 用户取消、模型拒绝、截断、业务 schema 不通过 | 停止；不规避拒绝、不返回半份数据 |
| 明确接口不支持、明确可选参数不支持 | 仅在已允许范围内进行有界兼容切换 |
| 429 / Retry-After | 保留并遵守等待提示，不立即轮换绕过限流 |
| 请求已发送后的网络异常或超时 | 默认停止；提示上游是否执行不确定 |
| 5xx 或 HTTP 200 空正文 | 显示失败与可能重复计费风险；仅按显式策略执行有限备用 |

建议默认整个逻辑任务最多 3 次上游尝试，至多两个 Provider；用一个总 deadline 和统一预算覆盖参数降级、协议切换与备用，不让 4 次参数尝试 × 3 个协议 × 2 个提供方相乘。业务层与队列既有重试也须梳理，诊断显示该次与上层尝试次数，不能宣称全系统 exactly-once。

请求预算是本任务的设计值，可经测试调整但必须有硬上限。超过预算返回明确错误。拿到任何有效输出后不再后台另发一遍择优。

## 7. 持久化与迁移

### 7.1 新表与职责

新增顺序迁移，当前基线可从 `0015_ai_provider_center_v2.sql` 开始，开发时确认编号未占用。不要编辑已执行的 0014，也不要直接 DROP 旧表。[R9]

建议实体：

| 表 | 主要字段 / 作用 |
|---|---|
| ai_providers | id、name、kind、base_url、wire_api、endpoint_config_json、enabled、加密凭据、cipher_version、credential_revision、revision、时间戳 |
| ai_provider_models | provider_id + model_id 复合主键、display_name、capabilities_json、evidence_json、catalog_present、时间戳 |
| ai_task_routes | role、主备 provider/model 引用、fallback_enabled；纳入原子配置版本 |
| ai_routing_settings | 全局默认文本/图片目标、环境回退开关、configuration_revision、迁移状态 |
| ai_provider_diagnostics | 有界的诊断摘要；provider/model/protocol/version、耗时、错误类别、测试时间，不存原题/图片/密钥/模型正文 |

配置编辑用 revision/乐观锁。两端拿相同旧版本修改时，只能一个成功，另一个返回 409。路由切换与引用检查必须保证原子性；不要误以为 batch 内 UPDATE 影响 0 行就会自动抛错回滚。用可证明的条件写入/约束设计并测试竞态。

D1 提供有事务回滚语义的 `batch()`，实现时按其实际能力设计，不假设有 Node SQLite 的任意长事务对象。[R19]

### 7.2 单 Provider 迁移

旧 `global` 存在时，迁移成确定性 ID（例如 `legacy-global`），复制原始加密数据而非输出、解密后明文落库或生成假 Key。保留旧密文版本的解密兼容；新格式若使用与 providerId 绑定的 AAD，要有明确版本和升级流程，不能简单搬密文导致无法解密。[R3]

原四个 role 先按旧 `selectAiProviderRoleModel()` 求出实际生效模型，再写成明确路由，不能把旧空字段当作“没有路由”而改变业务。原 Provider 已停用或只有环境配置的情况必须分别测试，保留原有行为。[R3][R20]

迁移必须具备显式完成标记和幂等性：重复执行不重复创建、不覆盖之后的编辑；用户后来删光 Provider 也不能触发“旧配置复活”。迁移失败不留下半份有效新配置。

保留旧表作迁移快照，但 V2 启用后只有一个可写事实来源。旧设置 API 可提供兼容读；无法无损表达多 Provider 的旧写请求返回带说明的 409，不能覆盖整个 V2。需要保留旧写兼容时，必须限定迁移记录和同一版本校验，不双写两套独立配置。

### 7.3 部署与回退

保留现有手动部署和备份确认，不在 push 或测试时操作生产。升级先本地演练迁移，再说明生产迁移步骤；执行生产迁移和发布需另行授权。

回退分两层：代码切回不等于数据恢复。保留旧快照并提供明确回退说明；回退会不会丢失 V2 新增的配置必须写清楚。不要声称保留旧表就能自动无损回退所有新数据。

## 8. 安全与隐私验收要求

所有管理读写、模型发现、连通测试和诊断均在后端校验管理员权限。写入保留同源检查；JSON 解析失败返回 400，不把抛出的 401/403 响应吞成 500。不能以隐藏按钮代替鉴权。

浏览器只请求本站 API，Worker 才联系上游。Key 不进入查询字符串、URL、localStorage、IndexedDB、日志、截图、普通 JSON 导出或响应；服务器仅返回 hasApiKey / credentialRevision 等非敏感信息。

使用显式凭据操作（keep / replace / clear）。keep 只允许同一 Provider 的同一凭据范围：规范化主机、端口、租户/网关前缀及认证方案。端点范围变化必须重新确认并输入对应 Key。未经重新输入不能把另一 Provider 的 Key 自动带过去。已有的换地址防泄漏、加密准备状态与授权重定向限制必须回归。[R3]

生产 HTTPS，拒绝 URL userinfo、非 HTTP(S)、超范围端点、敏感地址与元数据服务；本地 HTTP 只能在明确本地开发和允许端点条件下使用。高级自定义相对路径不能包含协议切换、路径逃逸或指向其他 origin。

不要把字符串层面的 localhost 过滤宣称为完整 SSRF 防护。必须考虑 IPv4/IPv6、域名解析和重定向；Cloudflare 运行环境不能提供可靠的解析后地址控制时，选择服务端可信目的地 allowlist 或受控出站代理，明确剩余边界。

管理测试接口设置合理限流、请求体和响应体限制，不能变成公开代理。错误信息只返回稳定错误码、可操作提示和脱敏诊断 ID。跨 Provider 备用需明确数据流向和用户同意。

## 9. 后端 API 契约

以下为目标路由，实施时可一致性微调命名，但功能和安全边界不能遗漏。

| Method / Path | 作用 |
|---|---|
| GET /api/admin/ai-providers | 提供方摘要、配置版本、加密准备状态、环境回退摘要 |
| POST /api/admin/ai-providers | 新建连接草稿；写入加密 Key 时校验加密准备状态 |
| GET /api/admin/ai-providers/[id] | 详情，不含密钥及可回放凭据 |
| PATCH /api/admin/ai-providers/[id] | 基于 expectedRevision 更新；显式凭据操作 |
| DELETE /api/admin/ai-providers/[id] | 删除未引用的 Provider；有任务/默认引用时返回 409 |
| POST /api/admin/ai-providers/[id]/models/discover | 拉取目录；可基于明确的未保存连接草稿，结果绑定草稿指纹 |
| POST /api/admin/ai-providers/[id]/test | 显式选择目录、文本、图片或结构化测试；不自动保存配置 |
| GET /api/admin/ai-routing | 获取默认目标、四任务路由、版本 |
| PUT /api/admin/ai-routing | 原子校验并保存整套路由 |

未保存的新 Provider 可先保存为禁用草稿后探测；不要为一个空 ID 偷偷借用旧 global 的凭据。编辑已保存 Provider 的未保存地址也要做相同 Key 范围检查。

停用已被引用 Provider 时给出影响预览；必须在同一次原子更新中完成重新分配，或明确使相关任务不可用并确认，不能静默选择列表第一项。删除使用 RESTRICT 式约束，不级联删除任务配置。

统一错误 envelope 示例：

```json
{
  "error": {
    "code": "PROVIDER_CREDENTIAL_SCOPE_CHANGED",
    "message": "连接地址已变化，请重新输入该地址的 API Key。",
    "field": "apiKey",
    "retryable": false,
    "diagnosticId": "opaque-id"
  }
}
```

应包括 UNAUTHORIZED、FORBIDDEN、INVALID_INPUT、REVISION_CONFLICT、PROVIDER_IN_USE、MIGRATION_REQUIRED、CAPABILITY_MISMATCH、UPSTREAM_AUTH_FAILED、UPSTREAM_RATE_LIMITED、UPSTREAM_TIMEOUT、OUTPUT_INVALID 等分类，避免所有失败统一 500。

## 10. 调用层与文件拆分

保留 `callStructuredAi()` 对业务端的入口及原返回字段，扩展元信息时保持兼容。Provider 解析、路由、协议适配、HTTP 安全、校验与诊断分层，但不要为了目录整齐复制三份重试逻辑。

```text
app/settings/ai/
  page.tsx                         # 重构为页面编排
  ai-center.module.css             # 新增，完整深浅主题
  _components/
    provider-list.tsx
    provider-editor.tsx
    model-catalog.tsx
    task-routing.tsx
    connection-test-panel.tsx
    status-notice.tsx
    save-bar.tsx

app/api/admin/
  ai-providers/route.ts
  ai-providers/[id]/route.ts
  ai-providers/[id]/models/discover/route.ts
  ai-providers/[id]/test/route.ts
  ai-routing/route.ts
  ai-provider/...                   # 现有单 Provider 接口兼容层

lib/
  ai-provider-types.ts              # 新增，共享公共类型，不能导入服务端 Key
  ai-provider-presets.ts            # 新增，接入预设与有日期的能力提示
  ai-provider-rules.mjs             # 修改，保留旧调用兼容
  ai-provider-rules.d.mts           # 同步更新声明
  server/
    ai-provider.ts                  # 现有 facade / 旧格式桥接
    ai-gateway.ts                   # 现有业务入口
    ai-http.ts                      # 复用并扩展 HTTP 安全与总 deadline
    ai-schema.ts                    # 复用/加强校验；不声称未实现的完整标准
    ai/
      provider-repository.ts
      routing.ts
      endpoint-policy.ts
      capabilities.ts
      diagnostics.ts
      adapters/
        openai.ts
        deepseek.ts
        gemini.ts
        anthropic.ts

migrations/
  0015_ai_provider_center_v2.sql    # 仅为基线下建议编号

tests/
  ai-provider-v2-migration.test.mjs
  ai-provider-v2-api.test.mjs
  ai-provider-endpoints.test.mjs
  ai-provider-routing.test.mjs
  ai-provider-security.test.mjs
  deepseek-adapter.test.mjs
  sub2api-adapters.test.mjs

scripts/
  verify-ai-settings-browser.py     # 扩展为实际页面、主题和交互验证

docs/
  ai-provider-center-v2-taskbook.md
  ai-provider-center-v2-validation.md
```

这些新增路径为目标结构，不表示已经存在。开发前检查已有工具和组件并优先复用。

## 11. 连接测试的真实含义

“检查目录”只验证 URL、鉴权、目录结构及耗时，不能标为所有模型可用。“测试模型”需用户明确点击，使用少量合成文本或合成图片，不用真实学生材料；提示可能计费，并限制输出和总请求次数。

分别显示目录、文本生成、图片输入、结构化输出测试结果。记录配置指纹、模型、协议、实际端点（脱敏）、HTTP 状态、耗时和失败分类。没有运行的项显示“未测试”，不显示成功。

不能因 `/models` 有 `image` 字段就说“视觉质量验收通过”；也不能因一个简单 JSON 测试通过就说“复杂题库 schema 全部兼容”。能力探测与业务质量验收分开。

## 12. 测试矩阵与完成定义

### 12.1 必须的自动化用例

| 领域 | 最低验收场景 |
|---|---|
| URL | 根地址、尾斜杠、/v1、部署前缀、Gemini 与 Claude 原生前缀；不重复拼接；拒绝 userinfo/异源路径 |
| 凭据 | A 地址旧 Key 不发给 B；不同 Provider Key 不串用；复制无 Key；同源不同租户前缀保护；错误脱敏 |
| DeepSeek | 实际模型目录元数据、Chat JSON mode、Responses schema、最终正文与 reasoning 分离、图片能力按模型区分 |
| Sub2API | 三类入口的请求/响应 fixture；不同模型别名；目录 404 后手动模型仍可用；错误分组不盲试其他入口 |
| 路由 | 四任务独立；主备跨 Provider；缺省按实际模态；无效配置不偷偷回退；重复/环路拒绝 |
| 输出 | 空 200、HTML、畸形 JSON、缺字段、多余字段、错误类型、截断、拒绝、不同协议错误体 |
| 预算 | 参数降级与备用共享次数/时间预算；Retry-After 保留；取消后不再开始任何新上游请求 |
| 迁移 | 无旧配置、完整旧配置、缺角色模型、已停用、仅环境变量、旧密文、重复迁移、失败回滚、删除后不复活 |
| 并发 | 配置 revision 冲突；旧探测结果不能覆盖新草稿；路由读到一致版本；目录刷新保留手工/已选模型 |
| 权限 | 访客和普通会员不能管理/探测；伪造 forwarded host 无管理员权限；写入同源校验 |

### 12.2 真实浏览器验收

必须运行实际应用的 `/settings/ai`，加载真实 layout、编译后的全局样式、主题初始化和局部样式。孤立组件 harness 可以继续用于快速回归，但不能替代这项验收。[R7]

至少验证 390px、768px、1440px 视口；深色与浅色均检查。增加 Chromium 和 WebKit（用于接近 macOS Safari 的兼容验证），支持时检查键盘与屏幕阅读器语义。

重点场景：空状态、已有单 Provider 迁移、三种 Provider 并存、未保存切换、保存失败、目录失败、手动模型、重复 ID、空模型、错误模型能力、Key 换地址、测试取消、停用/删除引用中的 Provider、手机抽屉、主题切换。

截图检查真实文字与背景，不能只断言 DOM 中存在按钮文字。首轮截图必须覆盖获取模型与添加模型按钮，专门回归用户反馈的浅底浅字问题。

界面无不必要的横向溢出，长模型 ID 不挤坏布局，主要按钮不折成竖排，底部保存条不遮挡输入和错误提示。

### 12.3 真实业务与验收边界

在测试配置下运行四类业务路径，确认角色路由实际到达指定目标。外部 AI 用 mock 时说明 mock 范围；D1/Worker 逻辑应有真实本地集成，而不是全部 mock。

真实 DeepSeek 和用户自建 Sub2API 的 smoke test 仅在安全提供凭据并允许后执行。未执行时在交付表写“未验证真实实例”，不能写“完全兼容所有中转站”。需要的信息为版本/镜像标签、对外 Base URL、脱敏请求示例、模型 ID 和分组信息，不是公开密钥。

按 AGENTS.md 保留 Word 真实导出验证；生成 DOCX 检查文字、公式、表格、图片，再渲染逐页检查。没有 Word/WPS 实机时说明覆盖范围，不把 LibreOffice 的结果当作所有办公软件认证。[R21]

### 12.4 基线命令

以下脚本在核对基线已存在。开发期间新增的 V2 测试必须接入测试入口与 CI，不能只是留在目录里：[R2]

```bash
npm ci
npm run lint
npm run test:studio
npm test
npm run benchmark:studio
```

`npm run dev` 当前已经包含本地 D1 迁移准备；核对后用它启动真实网页验证。不要为测试执行 `--remote` 或 `npm run deploy`。[R2]

独立类型检查有既有问题时，分别记录基线与新增问题；不得通过 ignoreBuildErrors、删除测试、缩减断言或一概吞异常使结果变绿。本地 Wrangler 偶发波动要记录首次与重试结果，不能用“最后退出为 0”掩盖不稳定性。

## 13. 实施阶段与交付物

| 阶段 | 工作内容 | 可验证交付 |
|---|---|---|
| A | 读现状、记录基线、端点契约与迁移设计 | 变更清单、风险和不受影响模块 |
| B | UI 主题与页面壳、可用的提供方编辑流程 | 真实页面深浅主题截图、交互测试；不只是 mock 展示 |
| C | 多 Provider 持久化、旧配置迁移、CRUD | 本地迁移与权限、冲突测试 |
| D | DeepSeek/Sub2API adapters、模型能力与诊断 | fixture 契约测试、测试按钮与脱敏记录 |
| E | 四任务路由、主备和统一请求预算 | 实际业务路径与取消/限流/回退用例 |
| F | 全量回归、真实浏览器、Word 样例与说明 | validation 文档、测试报告、截图、未验证清单 |

上述阶段可形成逐步可审查的提交；最终 PR 必须给出完整功能，而不是以“架构已准备好”为由留空真实 API、迁移和路由。

最终交付说明必须列出：代码版本、修改文件、迁移影响、每个 Provider 的适配策略、真实测试与 mock 的区别、已执行命令及结果、UI 前后截图、已知限制、本地更新方式和需要用户单独授权的生产步骤。

## 14. 执行工具的最终验收自检

交付前逐条回答，不得把计划当结果：

1. 已保存的旧 Key 是否仍可解密？原有角色的实际模型是否保持？
2. 页面是否真正加载全站样式并在深色主题下检查了按钮文字？
3. 三个 Provider 是否能同时存在，且任务能选到不同 Provider 的模型？
4. DeepSeek 是否支持动态能力，而不是品牌级别的“文本限定”？
5. Sub2API 是否区分 OpenAI、Gemini、Claude，且保留实际部署前缀？
6. 所有成功响应是否在进入业务前经过结构校验？
7. 取消、限流和错误是否会引发额外隐式请求？是否有总预算？
8. 路由与设置是否有并发保护？删除/停用是否保留明确行为？
9. 浏览器、网络响应、日志和导出中是否找不到可回放密钥？
10. 哪些真实接口尚未测试？哪些类型/视觉/基础设施问题仍存在？

**验收底线：好看、可用、可迁移、可验证；不以丢失旧功能、安全退步或伪造测试结果换取表面完成。**

---

## 附：核对来源

项目代码来源均固定到上述基线，外部接口文档核对日期为 2026-09-26；开发时重新核对。以下 URL 为资料入口，不应作为包含真实凭据的终端命令粘贴。

- [R1] main Git 引用：`https://api.github.com/repos/mittywave/zhiti-local-question-bank/git/ref/heads/main`
- [R2] package.json：`https://github.com/mittywave/zhiti-local-question-bank/blob/8ab8dba8e48524a206d245968772b42728b42b96/package.json`
- [R3] 当前 Provider 服务：`https://github.com/mittywave/zhiti-local-question-bank/blob/8ab8dba8e48524a206d245968772b42728b42b96/lib/server/ai-provider.ts`
- [R4] 当前 AI 网关：`https://github.com/mittywave/zhiti-local-question-bank/blob/8ab8dba8e48524a206d245968772b42728b42b96/lib/server/ai-gateway.ts`
- [R5] 当前设置页：`https://github.com/mittywave/zhiti-local-question-bank/blob/8ab8dba8e48524a206d245968772b42728b42b96/app/settings/ai/page.tsx`
- [R6] 当前全局主题样式：`https://github.com/mittywave/zhiti-local-question-bank/blob/8ab8dba8e48524a206d245968772b42728b42b96/app/globals.css`
- [R7] 当前独立浏览器测试构建：`https://github.com/mittywave/zhiti-local-question-bank/blob/8ab8dba8e48524a206d245968772b42728b42b96/scripts/build-ai-settings-browser.mjs`
- [R8] 几何图重绘路由：`https://github.com/mittywave/zhiti-local-question-bank/blob/8ab8dba8e48524a206d245968772b42728b42b96/app/api/reconstruct-diagram/route.ts`
- [R9] 当前迁移目录：`https://github.com/mittywave/zhiti-local-question-bank/tree/8ab8dba8e48524a206d245968772b42728b42b96/migrations`
- [R10] DeepSeek 入门与当前模型：`https://api-docs.deepseek.com/`
- [R11] DeepSeek 图片输入：`https://api-docs.deepseek.com/guides/vision/`
- [R12] DeepSeek Responses API：`https://api-docs.deepseek.com/api/create-response/`
- [R13] DeepSeek 模型目录元数据：`https://api-docs.deepseek.com/api/list-models/`
- [R14] DeepSeek Chat JSON Output：`https://api-docs.deepseek.com/guides/json_mode/`
- [R15] Sub2API 上游 Antigravity 支持说明：`https://github.com/Wei-Shaw/sub2api#antigravity-support`
- [R16] W3C 文字对比度说明：`https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html`
- [R17] OpenAI Structured Outputs：`https://developers.openai.com/api/docs/guides/structured-outputs`
- [R18] DeepSeek 思考模式参数：`https://api-docs.deepseek.com/guides/thinking_mode/`
- [R19] Cloudflare D1 batch：`https://developers.cloudflare.com/d1/worker-api/d1-database/`
- [R20] 当前 Provider 规则：`https://github.com/mittywave/zhiti-local-question-bank/blob/8ab8dba8e48524a206d245968772b42728b42b96/lib/ai-provider-rules.mjs`
- [R21] 项目验证规则：`https://github.com/mittywave/zhiti-local-question-bank/blob/8ab8dba8e48524a206d245968772b42728b42b96/AGENTS.md`
