export const ALEVEL_PAGE_LOCALE_KEY = "mitty-alevel-9709-locale";

export function isAlevel9709ModuleName(name) {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "") === "alevel9709";
}

export const ALEVEL_PAGE_COPY = {
  zh: {
    brandSubtitle: "的宝藏题库", navPublic: "我的题库", navStudents: "学生档案", navBasket: "组卷篮", navKnowledge: "知识图谱", navTools: "工具箱",
    displayMode: "显示模式", light: "浅色", dark: "深色", localAdmin: "本地管理员", admin: "管理员", member: "会员", noLogin: "无需登录", signOut: "退出", newQuestion: "新建试题",
    connecting: "正在连接云端…", guestBrowse: "访客 · 仅浏览", loginRegister: "登录 / 注册", knowledgeDirectory: "知识目录", addCategory: "添加分类", manageCategories: "分类与数据管理", loginToDownload: "登录后可下载", maintainedByAdmin: "公共库由本地管理员维护",
    publicLibrary: "我的题库", myLibrary: "私人题库", publicMemberAccess: "可浏览、复制和导出 Word", publicGuestAccess: "访客可浏览，登录后可下载", privateAccess: "仅你可见的独立题库",
    recentlyPublished: "最近发布", publishing: "正在发布…", publishFailed: "发布失败", retryPublish: "重试发布", publishLibrary: "发布公共资源库", manageModules: "管理模块", moduleSwitcher: "题库模块", noSubtitle: "未设置副标题", newModule: "新建模块", customModule: "自定义名称和副标题",
    searchLabel: "搜索试题", searchPlaceholder: "搜索题干、年份、来源或知识点…", propertyFilter: "题目属性筛选", property: "题目属性", all: "全部", allQuestions: "全部试题", allTypes: "全部题型", selectResults: "全选当前结果", clearSelection: "取消全选",
    language: "Alevel 9709 页面语言", questionUnit: "题", questionsUnit: "道试题", moduleSuffix: "模块", localAdminSuffix: "localhost 本地管理员", guestSuffix: "访客可直接浏览", loggedInAs: "已登录为",
    empty: "空", noQuestions: "还没有试题", addFirstQuestion: "录入第一道试题", noResources: "当前模块暂无可浏览资源",
    selectQuestion: "选择", deselectQuestion: "取消选择", imageRedraw: "高清矢量重绘", legacyRedraw: "旧版 GeoGebra 重绘", imageCapture: "图像识别", figure: "题目配图", aiEnhanced: "AI 已优化", figureAlt: "题目配图",
    answer: "答案", solution: "解析", none: "略", showSolution: "查看解析", hideSolution: "收起解析", addWrong: "记入错题本", enteredBy: "由", enteredSuffix: "录入", edit: "编辑", delete: "删除",
    selectedQuestions: "已选试题", publicPractice: "公共库练习", privatePractice: "私人库练习", practiceSet: "专项练习", copyToMine: "复制到私人题库", deleteManaged: "删除可管理题目", clear: "清空", exportWord: "生成 Word",
  },
  en: {
    brandSubtitle: "Question Bank", navPublic: "My Library", navStudents: "Student Records", navBasket: "Paper Basket", navKnowledge: "Knowledge Map", navTools: "Toolbox",
    displayMode: "Display mode", light: "Light", dark: "Dark", localAdmin: "Local Admin", admin: "Admin", member: "Member", noLogin: "No sign-in", signOut: "Sign out", newQuestion: "New Question",
    connecting: "Connecting…", guestBrowse: "Guest · Browse only", loginRegister: "Sign in / Register", knowledgeDirectory: "Topic Directory", addCategory: "Add category", manageCategories: "Manage Categories", loginToDownload: "Sign in to download", maintainedByAdmin: "The public library is maintained locally",
    publicLibrary: "My Library", myLibrary: "Private Library", publicMemberAccess: "Browse, copy and export to Word", publicGuestAccess: "Guests can browse; sign in to download", privateAccess: "Your private question bank",
    recentlyPublished: "Last published", publishing: "Publishing…", publishFailed: "Publish failed", retryPublish: "Retry", publishLibrary: "Publish Library", manageModules: "Manage Modules", moduleSwitcher: "Question bank modules", noSubtitle: "No subtitle", newModule: "New Module", customModule: "Custom name and subtitle",
    searchLabel: "Search questions", searchPlaceholder: "Search question, year, source or topic…", propertyFilter: "Question source filter", property: "Question Source", all: "All", allQuestions: "All Questions", allTypes: "All Types", selectResults: "Select Results", clearSelection: "Clear Selection",
    language: "Alevel 9709 page language", questionUnit: "question", questionsUnit: "questions", moduleSuffix: "module", localAdminSuffix: "localhost local admin", guestSuffix: "guest access", loggedInAs: "signed in as",
    empty: "Empty", noQuestions: "has no questions yet", addFirstQuestion: "Add the first question", noResources: "No questions are available in this module",
    selectQuestion: "Select", deselectQuestion: "Deselect", imageRedraw: "Vector Redraw", legacyRedraw: "Legacy GeoGebra", imageCapture: "Image Capture", figure: "Figure", aiEnhanced: "AI Enhanced", figureAlt: "Question figure",
    answer: "Answer", solution: "Solution", none: "Not provided", showSolution: "View Solution", hideSolution: "Hide Solution", addWrong: "Save Mistake", enteredBy: "Entered by", enteredSuffix: "", edit: "Edit", delete: "Delete",
    selectedQuestions: "Selected", publicPractice: "Public practice", privatePractice: "Private practice", practiceSet: "Practice Set", copyToMine: "Copy to Private Library", deleteManaged: "Delete Managed", clear: "Clear", exportWord: "Export Word",
  },
};

const LABELS = {
  "单选题": "Multiple Choice", "多选题": "Multiple Select", "填空题": "Fill in the Blank", "判断题": "True / False", "解答题": "Structured Question",
  "基础": "Foundation", "中等": "Intermediate", "提高": "Advanced",
  "真题": "Past Paper", "风格题": "Practice", "来源待核实": "Source Pending",
};

export function alevelPageLabel(value, locale) {
  return locale === "en" ? LABELS[value] ?? value : value;
}

export function alevelQuestionCount(count, locale) {
  if (locale !== "en") return `${count} 道试题`;
  return `${count} ${count === 1 ? "question" : "questions"}`;
}

const ALEVEL_TAG_PAIRS = [
  ["三角函数应用", "Modelling with Trigonometric Functions"],
  ["一元二次方程", "Quadratic Equations"],
  ["根的判别式", "The Discriminant"],
];

function normalizedTagKey(value) {
  return String(value ?? "").trim().toLocaleLowerCase("en").replace(/[\s_–—-]+/g, " ");
}

function uniqueTags(values) {
  const result = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const tag = String(value ?? "").trim();
    const key = normalizedTagKey(tag);
    if (!tag || seen.has(key)) continue;
    seen.add(key); result.push(tag);
  }
  return result;
}

const ALEVEL_TAG_LOOKUP = new Map();
for (const [zh, en] of ALEVEL_TAG_PAIRS) {
  const pair = { zh, en };
  ALEVEL_TAG_LOOKUP.set(normalizedTagKey(zh), pair);
  ALEVEL_TAG_LOOKUP.set(normalizedTagKey(en), pair);
}

export function alevelTagVersions(question = {}) {
  const legacyZh = []; const legacyEn = [];
  for (const tag of uniqueTags(question.tags)) {
    const pair = ALEVEL_TAG_LOOKUP.get(normalizedTagKey(tag));
    if (pair) { legacyZh.push(pair.zh); legacyEn.push(pair.en); }
    else if (/\p{Script=Han}/u.test(tag)) legacyZh.push(tag);
    else legacyEn.push(tag);
  }
  return {
    zh: uniqueTags(Array.isArray(question.tagsZh) ? question.tagsZh : legacyZh),
    en: uniqueTags(Array.isArray(question.tagsEn) ? question.tagsEn : legacyEn),
  };
}

export function localizeAlevelTags(question, locale) {
  const versions = alevelTagVersions(question);
  return locale === "en" ? versions.en : versions.zh;
}
