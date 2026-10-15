export const ALEVEL_PAGE_LOCALE_KEY = "mitty-alevel-9709-locale";

export function isAlevel9709ModuleName(name) {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "") === "alevel9709";
}

export const ALEVEL_PAGE_COPY = {
  zh: {
    navPublic: "题库", navStudents: "学生档案", navBasket: "组卷篮", navHandouts: "讲义编撰", navKnowledge: "知识图谱", navTools: "工具箱",
    appearance: "外观", localAdmin: "本机管理员", signOut: "退出登录", signOutFailed: "退出失败，点击重试", newQuestion: "新建试题",
    connecting: "正在连接云端…", guestBrowse: "访客 · 仅浏览", loginRegister: "登录 / 注册", addCategory: "新建分类", manageCategories: "分类与数据管理", loginToDownload: "登录后可下载",
    publicLibrary: "题库",
    manageModules: "管理模块", moduleSwitcher: "模块", newModule: "新建模块",
    searchLabel: "搜索试题", searchPlaceholder: "搜索题干、知识点，或输入四位 ID", all: "全部", allTypes: "全部题型", selectResults: "全选结果", clearSelection: "取消选中",
    language: "Alevel 9709 页面语言",
    empty: "空", noQuestions: "没有符合条件的试题", addFirstQuestion: "录入第一道试题", noResources: "当前模块暂无可浏览资源",
    selectQuestion: "选择", deselectQuestion: "取消选择", imageRedraw: "高清矢量重绘", legacyRedraw: "旧版 GeoGebra 重绘", imageCapture: "图像识别", figure: "题目配图", aiEnhanced: "AI 已优化", figureAlt: "题目配图",
    answer: "答案", solution: "解析", none: "略", showSolution: "查看解析", hideSolution: "收起解析", addWrong: "记入错题本", enteredBy: "由", enteredSuffix: "录入", edit: "编辑", delete: "删除",
    selectedQuestions: "已选试题", selectionHere: "本分类", selectionElsewhere: "其他分类", basketReadyHint: "选好后去组卷篮整理", publicPractice: "公共库练习", privatePractice: "私人库练习", practiceSet: "专项练习", copyToMine: "复制到私人题库", deleteManaged: "删除可管理题目", clear: "清空", exportWord: "生成 Word",
  },
  en: {
    navPublic: "Library", navStudents: "Student Records", navBasket: "Paper Basket", navHandouts: "Handouts", navKnowledge: "Knowledge Map", navTools: "Toolbox",
    appearance: "Appearance", localAdmin: "Local Admin", signOut: "Sign out", signOutFailed: "Sign-out failed · Retry", newQuestion: "New Question",
    connecting: "Connecting…", guestBrowse: "Guest · Browse only", loginRegister: "Sign in / Register", addCategory: "New category", manageCategories: "Manage Categories", loginToDownload: "Sign in to download",
    publicLibrary: "Library",
    manageModules: "Manage Modules", moduleSwitcher: "Modules", newModule: "New Module",
    searchLabel: "Search questions", searchPlaceholder: "Search text, topics or a 4-digit ID", all: "All", allTypes: "All Types", selectResults: "Select Results", clearSelection: "Clear Selection",
    language: "Alevel 9709 page language",
    empty: "Empty", noQuestions: "No matching questions", addFirstQuestion: "Add the first question", noResources: "No questions are available in this module",
    selectQuestion: "Select", deselectQuestion: "Deselect", imageRedraw: "Vector Redraw", legacyRedraw: "Legacy GeoGebra", imageCapture: "Image Capture", figure: "Figure", aiEnhanced: "AI Enhanced", figureAlt: "Question figure",
    answer: "Answer", solution: "Solution", none: "Not provided", showSolution: "View Solution", hideSolution: "Hide Solution", addWrong: "Save Mistake", enteredBy: "Entered by", enteredSuffix: "", edit: "Edit", delete: "Delete",
    selectedQuestions: "Selected", selectionHere: "This category", selectionElsewhere: "Other categories", basketReadyHint: "Organise the selected questions in the paper basket", publicPractice: "Public practice", privatePractice: "Private practice", practiceSet: "Practice Set", copyToMine: "Copy to Private Library", deleteManaged: "Delete Managed", clear: "Clear", exportWord: "Export Word",
  },
};

const LABELS = {
  "单选题": "Multiple Choice", "多选题": "Multiple Select", "填空题": "Fill in the Blank", "判断题": "True / False", "解答题": "Structured Question",
  "基础": "Foundation", "中等": "Intermediate", "提高": "Advanced",
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
