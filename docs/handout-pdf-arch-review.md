# 讲义 PDF 架构判断：TeX 还是 CSS

> 咨询对象：Claude（经 `claude-route` → zgo-hy2）
> 运行环境：`zhiti-local-question-bank` 项目目录，只读权限（Read/Grep/Glob），未修改任何文件
> 生成时间：2026-10-01

---

## 0. Claude 先说它看到的现状

它读了代码后确认：题目存成「文字 + `$LaTeX$`」，网页用 KaTeX 渲染（`app/components/MathText.tsx`）；Word 导出时公式由 `lib/math-omml.ts` 从 LaTeX 转 OMML，不支持的写法直接报错、不会把命令名漏进文档，白名单由 `math-capabilities.mjs` 决定。

`lib/docx-web-content.ts` 的 OMML→LaTeX **只在导入 Word 时用，导出不走它**。

> **所以「两个版本」里，Word 素版基本已经有了（`buildWordBlob`）。真正要新做的只有 PDF 这一条。**

---

## 1. TeX 是不是一定合适？——**不是，而且在这个项目里大概率不合适**

### TeX 的优势
- 断行、标点挤压、数学排版质量最好（xeCJK + Knuth-Plass 断行优于浏览器）
- 输出稳定可复现：版本固定后，同样输入得到同样的 PDF
- 长文档功能齐全：目录、交叉引用、页眉页脚都是现成的

### TeX 的代价（大多是这个项目特有的）
- **多了第三条渲染链。** 现在已有 LaTeX→KaTeX（网页）和 LaTeX→OMML（Word）。TeX 是第三个解释器，**三者能接受的写法各不相同**。还要额外处理正文转义（`% & # _ ~` 出现在中文题干里）、R2 图片落地、表格转换
- **Workers 跑不了。** 要么另开 Cloudflare Containers 或独立机器跑 Tectonic，要么只能本地批量出——会多一个运维对象
- **设计迭代贵。** tcolorbox、TikZ 做版式，每改一次都得懂 TeX 的人来改；CSS 改版式门槛低得多
- **预览和成品对不上。** 网页里看到的是 KaTeX + HTML，导出的是 TeX 排版，**老师看到的预览不等于最终 PDF**

### 判断标准

| 情况 | TeX |
|---|---|
| 离线批量印刷、排版质量第一、团队有人长期维护 LaTeX 模板、不需要网页所见即所得 | ✅ 适合 |
| **内容在网页里编辑、需预览与成品一致、版式要频繁调整、部署在 Workers** | ❌ **你们是这种** |

---

## 2. 两个版本最省的架构：**同一份内容，两个渲染器**

```
L0 存储      Question（文字 + $LaTeX$ + 图片）、Handout（分节 + 题目引用）
              ↓
L1 公式闸门  math-capabilities 白名单 + normalizeMathNotation
             规则：只放行 KaTeX 和 OMML 都能处理的写法（两者的交集），录入时就拦截
              ↓
L2 文档模型  纯函数 buildHandoutModel(handout) → 有序 block 列表
             题号、答案位置（不附 / 文末 / 每题后）、选项排列、图片布局都在这里算好
             复用 resolveQuestionImageLayout、isCompactConclusionQuestion
              ↓                              ↓
L3a Word 渲染器（现有 buildWordBlob）    L3b 打印用 HTML 渲染器（QuestionBody + print.css）
    素版：不做装饰                          设计版：主题 CSS + @page
```

### 防止两版不一致的三条硬规则

1. **渲染器不做决定。** 题号、顺序、答案位置、选项排几列，**只在 L2 算一次**，两个渲染器照着画。
2. **装饰和内容要分清。** PDF 里如果出现"易错点""知识点"框，而框里有文字，**这段文字就是内容，必须放进 L2 模型**，Word 素版用纯文本输出。只有纯装饰（色块、图标、底纹）才能只存在于 CSS。**这是最容易出现两版内容不一致的地方。**
3. **加一个双渲染测试。** 对每道题，`katex.renderToString(..., {throwOnError:true})` 和 `compileMathOmml` 都不能报错。任何一边失败就挡在**录入阶段**，不要等到导出才发现。

---

## 3. CSS 路线能不能做到设计感好、可直接投产？——**能，但要分清在哪里生成 PDF**

| 方案 | 能否满足约束 | 判断 |
|---|---|---|
| 浏览器 `@page` + `window.print()` | 纯客户端 | 可以起步，但做不到可复现 |
| **Paged.js / Vivliostyle** | 纯 JS，客户端或无头浏览器都能跑 | 提供页眉页脚、`string-set`、`target-counter` 目录页码。**Vivliostyle 对中日文更友好、维护更活跃**；Paged.js 更新慢 |
| **Cloudflare Browser Rendering**（Workers binding + Puppeteer `page.pdf()`） | ✅ 在 Workers 体系内，不用自己部署原生二进制 | **生产出 PDF 推荐用它。** Cloudflare 托管 Chromium，输出稳定。需付费计划，有并发和时长配额，以当前文档为准 |
| WeasyPrint / Prince | ❌ 原生程序 | WeasyPrint **不执行 JS、不支持 MathML**，KaTeX 排版易错位；Prince 效果最好但商业授权贵。不推荐 |
| Typst（WASM） | 浏览器里能跑；放进 Workers 体积大概率超限 | 设计友好、编译快，但**公式语法不是 LaTeX，要转换**（如 MiTeX）→ 又多一条渲染链。不推荐作主线 |
| react-pdf | 可以跑 | 自研布局引擎，**没有 CSS 层叠**，用不了 KaTeX HTML，中文断行弱。❌ |
| Satori | — | 只能出单帧 SVG，没有分页。❌ |
| html2canvas + jsPDF | 可以跑 | **输出是位图**：文字不能选、放大糊、文件大。**不能用于生产**（虽然你依赖里已经有了） |

### 客户端出 PDF 的坑

- **可复现性。** 结果取决于老师用什么浏览器、什么版本、打印对话框怎么设（边距、是否勾"背景图形"、是否带浏览器自带页眉 URL）。Safari 和 iPad 尤其弱。**只适合预览或应急，不适合当生产标准。**
- **中文字体。** 必须用**网页字体**，不能依赖本机字体。完整中文字体每个字重 10–20MB，要按 unicode-range 切片或子集化；打印前要等 `document.fonts.ready`。Chrome 生成 PDF 会自动子集嵌入。**字体授权才是真风险**：方正、汉仪等商业字体用于印刷/分发需授权；**思源宋体/黑体、霞鹜文楷是 OFL，可安全使用**。
- **公式。** KaTeX 的 HTML 输出打印是矢量文字，质量没问题，前提是 KaTeX 字体预加载。要调的是 **KaTeX 字号与基线和中文正文的配比**。
- **分页。** `break-inside: avoid` 让单题不跨页；超长题跨页、图片与题干分到两页，需要在 L2 模型里加提示（"这道题需要整页"）。`orphans`/`widows` 只对段落生效。
- **页眉页脚。** Chrome 131+ 原生支持 `@page` margin boxes（`@top-center`、`counter(page)`）。**随章节变化的页眉（running headers）原生做不到**，需 Paged.js 或 Vivliostyle。
- **目录页码。** Chrome 原生不支持 `target-counter`，同样需 polyfill。讲义一般不需要目录，可以先不做。
- **懒加载图片。** 打印路由里 `loading="lazy"` 的图会打印成空白，**必须改成同步加载**。

---

## 4. 现有渲染链怎么复用

### 保留
- 存储格式（`$LaTeX$`）
- `math-capabilities` 白名单、`normalizeMathNotation`、`splitMathText`
- **`MathText` 和 KaTeX `renderToString`** —— 它是纯函数，**可在 Worker 里服务端渲染**，打印页直接输出静态 HTML，Browser Rendering 不用等 hydration
- `QuestionBody`、`resolveQuestionImageLayout` 等布局纯函数
- OMML→LaTeX 导入链：只管导入，和导出方案无关，原样保留
- **`pdfjs-dist`**：可在应用里预览生成的 PDF，也可把 PDF 渲染成逐页图片做视觉回归——**正好满足你们 AGENTS.md 的验证要求**

### 要改
- `QuestionBody` 拆成「语义结构」和「主题样式」两部分，打印主题单独写 `print.css`，**不要和应用界面 CSS 混在一起**
- KaTeX 加打印专用字号、基线微调，并预加载字体
- 新增打印路由（如 `/tools/handouts/[id]/print`），只输出 HTML、不含交互
- **白名单从「OMML 能编译」改成「KaTeX 和 OMML 都能编译」**

### 放弃
- Tectonic 链路、LaTeX 正文转义层。**之前 Tectonic 的验证结果可以留作「排版质量基准」，用来对比 CSS 版的效果**

---

## 5. 推荐方案

> **单一 L2 文档模型 → Word 素版（现有）+ 打印用 HTML/CSS → PDF。** 分三步走：

1. **打印路由加原生 `@page`**，先用 Chrome「另存为 PDF」验证版式和公式质量。成本最低，网页预览和 PDF 一致
2. 需要**随章节变化的页眉**或目录时，加 **Vivliostyle** 或 Paged.js
3. 需要**稳定、可复现的生产输出**时，接 **Cloudflare Browser Rendering**，服务端调 `page.pdf()`，Chromium 版本由 Cloudflare 固定

**理由：** 公式只经过 KaTeX 和 OMML 两个渲染器，**不新增第三个**；完全在 Workers 体系内；设计改动只改 CSS；**老师在网页上看到的就是最终 PDF**。

---

## 6. Claude 认为你们可能想错了的地方

1. **TeX 还是 CSS 不是核心问题。** 核心是 **L2 单一模型 + 公式交集白名单**。这两样做对了，渲染器以后可以换；做错了，用 TeX 也会出现两版不一致。

2. **「CSS 嵌套」带不来设计感。** 起作用的是 **CSS Paged Media**（`@page`、margin boxes、`break-*`、counters）加一套排版系统（网格、字体搭配、字号层级）。**设计感来自设计本身，不来自某项技术**，CSS 只是让设计改起来更便宜。

3. **「直接投入生产」要先问清楚是什么生产。** ⚠️
   - 学校打印机或复印：浏览器生成的 **RGB PDF 完全够用**
   - 送**印刷厂做胶印**：通常要求 **CMYK、PDF/X、3mm 出血和裁切线**，浏览器生成不了，需用 Ghostscript 后处理，或先确认印刷厂是否接受 RGB 数码印刷
   - **这一条会影响方案，建议先问清楚。**

4. **「Workers 跑不了原生程序所以只能在客户端出 PDF」不成立。** Browser Rendering 就是 Workers 体系内的无头 Chrome。客户端打印只适合预览，不适合当生产标准。

5. **不要给 PDF 版偷偷加内容。** 设计版里加的提示框、点评文字**如果不进 L2 模型，Word 素版就会少内容**——这正好违反了你们已经确认的原则「单一题目格式，所有输出一致」。

---

## 附：Hermes 的补充

claude 第 3 条（问清「生产」是什么生产）和第 5 条（别给 PDF 偷偷加内容）是最实用的两条，因为它们**不涉及技术选型，但你一旦踩到会返工**。

另外它第 1 条点得很准：**你现在纠结的 TeX vs CSS，其实是个伪命题**。真正决定成败的是中间那层 `L2 文档模型` —— 只要它做好了，用 TeX、用 CSS、甚至以后换 Typst，都不会出现两版不一致；做不好，换什么都是同样的坑。
