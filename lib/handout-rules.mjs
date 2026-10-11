export const HANDOUT_LIMITS = { title: 120, items: 400, id: 200, sectionTitle: 200, note: 20_000 };
export const DEFAULT_HANDOUT_TITLE = "未命名讲义";

// 讲义放在三个书架上：课程体系按 年级 → 学期 → 课次 编排（一学年从暑假开始，课次号是讲义在本学期里的先后）；
// 专题库按板块存放知识专题；学生讲义挂在学生档案下，只有这位学生的老师能看到。
export const HANDOUT_GRADES = [{ value: 7, label: "初一" }, { value: 8, label: "初二" }, { value: 9, label: "初三" }];
export const HANDOUT_TERMS = [{ value: "summer", label: "暑假" }, { value: "autumn", label: "秋季" }, { value: "winter", label: "寒假" }, { value: "spring", label: "春季" }];
export const HANDOUT_DOMAINS = [{ value: "function", label: "函数" }, { value: "geometry", label: "几何" }, { value: "algebra", label: "代数" }, { value: "number", label: "数论" }, { value: "thinking", label: "数学思想" }];
export const HANDOUT_SHELVES = [{ value: "course", label: "课程体系" }, { value: "topic", label: "专题库" }, { value: "student", label: "学生讲义" }];
// Handouts filed nowhere (older ones without a term) wait in the topic library until moved.
export const UNSORTED_TOPIC_LABEL = "未分板块";

// The shelf follows from where a handout is stored: a student, else a term, else the topic library.
export const shelfOf = (group) => group?.studentId ? "student" : group?.term ? "course" : "topic";

// A group is one term, one topic domain or one student; 课次 and topic order number within it.
// Nothing given is the unsorted part of the topic library. Anything malformed is null:
// an unknown grade, term or domain, or a grade and term without each other.
export function normalizeHandoutGroup(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const given = (value) => value !== undefined && value !== null && value !== "";
  if (given(source.studentId)) {
    const studentId = typeof source.studentId === "string" ? source.studentId.trim() : "";
    return studentId && studentId.length <= HANDOUT_LIMITS.id ? { grade: null, term: null, domain: null, studentId } : null;
  }
  if (given(source.domain)) {
    const domain = HANDOUT_DOMAINS.find((item) => item.value === source.domain)?.value;
    return domain ? { grade: null, term: null, domain, studentId: null } : null;
  }
  const grade = given(source.grade) ? HANDOUT_GRADES.find((item) => item.value === Number(source.grade))?.value : null;
  const term = given(source.term) ? HANDOUT_TERMS.find((item) => item.value === source.term)?.value : null;
  if (grade === undefined || term === undefined || Boolean(grade) !== Boolean(term)) return null;
  return { grade, term, domain: null, studentId: null };
}

export const sameGroup = (a, b) => ["studentId", "domain", "grade", "term"].every((key) => (a?.[key] ?? null) === (b?.[key] ?? null));

// 初一暑假 / 函数专题 / 未分板块 / the student's name.
export function groupLabel(group) {
  if (group?.studentId) return group.studentName || "学生讲义";
  const grade = HANDOUT_GRADES.find((item) => item.value === group?.grade)?.label;
  const term = HANDOUT_TERMS.find((item) => item.value === group?.term)?.label;
  if (grade && term) return `${grade}${term}`;
  const domain = HANDOUT_DOMAINS.find((item) => item.value === group?.domain)?.label;
  return domain ? `${domain}专题` : UNSORTED_TOPIC_LABEL;
}

// 每个知识模块固定四段：知识点 → 例题 → 练习 → 变式。编辑页、精排 PDF 和 Word 共用这些说法。
export const HANDOUT_BANDS = ["example", "practice", "variant"];
export const HANDOUT_PARTS = {
  knowledge: { label: "知识点", tagline: "本模块要掌握的内容", hint: "列出本模块要掌握的全部内容；可粘贴或拖入截图自动识别" },
  example: { label: "例题", prefix: "例", tagline: "跟着老师，看知识点怎么用", hint: "选和上面知识点直接对应的典型题，带学生一起做" },
  practice: { label: "练习", prefix: "", tagline: "自己动手，检验掌握", hint: "和例题同类的题，学生独立完成" },
  variant: { label: "变式", prefix: "变式", tagline: "换个情境，抓住本质", hint: "换情境、换题型，考查同一个思维模型" },
};
const NUMERALS = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

const text = (value, limit) => typeof value === "string" ? value.slice(0, limit) : "";

// Questions saved before bands existed read as 例题.
export const bandOf = (item) => HANDOUT_BANDS.includes(item?.band) ? item.band : "example";
export const bandLabel = (band, number) => `${HANDOUT_PARTS[band].prefix}${number}`;

export function chineseNumeral(value) {
  if (value <= 10) return NUMERALS[value];
  if (value < 20) return `十${NUMERALS[value - 10]}`;
  return `${NUMERALS[Math.floor(value / 10)]}十${value % 10 ? NUMERALS[value % 10] : ""}`;
}

// The server stores only what passes here; malformed items are dropped, not repaired.
export function normalizeHandoutDraft(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const title = text(source.title, HANDOUT_LIMITS.title).trim() || DEFAULT_HANDOUT_TITLE;
  const items = []; const seen = new Set();
  for (const item of Array.isArray(source.items) ? source.items : []) {
    if (items.length === HANDOUT_LIMITS.items) break;
    const id = text(item?.id, HANDOUT_LIMITS.id).trim();
    if (!id || seen.has(id)) continue;
    if (item.kind === "question") {
      const questionId = text(item.questionId, HANDOUT_LIMITS.id).trim();
      if (!questionId || (item.scope !== "public" && item.scope !== "mine")) continue;
      items.push({ id, kind: "question", scope: item.scope, questionId, band: bandOf(item) });
    } else if (item.kind === "section") {
      items.push({ id, kind: "section", title: text(item.title, HANDOUT_LIMITS.sectionTitle), note: text(item.note, HANDOUT_LIMITS.note) });
    } else continue;
    seen.add(id);
  }
  return { title, items };
}

// A section item is a knowledge module; questions belong to the module before them.
// Questions placed before the first module form an untitled leading block.
function moduleBlocks(items) {
  const blocks = [{ section: null, items: [] }];
  for (const item of items) {
    if (item.kind === "section") blocks.push({ section: item, items: [] });
    else blocks.at(-1).items.push(item);
  }
  return blocks;
}

export function handoutModules(items) {
  return moduleBlocks(items).map((block) => ({
    section: block.section,
    bands: Object.fromEntries(HANDOUT_BANDS.map((band) => [band, block.items.filter((item) => bandOf(item) === band)])),
  }));
}

// The list's view of a handout: each module's title and the questions it references, without notes.
export function handoutOutline(items) {
  return handoutModules(items).flatMap((module) => {
    const questionIds = HANDOUT_BANDS.flatMap((band) => module.bands[band].map((item) => item.questionId));
    return module.section || questionIds.length ? [{ title: module.section?.title ?? "", questionIds }] : [];
  });
}

// Each band numbers on across modules: 例1…, 1…, 变式1….
export function handoutNumbers(items) {
  const counters = { example: 0, practice: 0, variant: 0 }; const numbers = new Map();
  for (const block of handoutModules(items)) {
    for (const band of HANDOUT_BANDS) for (const item of block.bands[band]) numbers.set(item.id, bandLabel(band, ++counters[band]));
  }
  return numbers;
}

// Modules are numbered by position; a number typed in front of the name is dropped so it never doubles.
export function moduleHeading(title, index) {
  return { numeral: chineseNumeral(index + 1), title: String(title ?? "").trim().replace(/^(?:模块\s*)?(?:[一二三四五六七八九十]{1,3}|\d{1,2})\s*[、.．:：](?!\d)\s*/, "") };
}

export function handoutSections(items, resolve) {
  let missingCount = 0;
  const resolveAll = (list) => list.flatMap((item) => {
    const question = resolve(item.scope, item.questionId);
    if (!question) missingCount += 1;
    return question ? [question] : [];
  });
  const modules = handoutModules(items).map((block) => ({
    heading: block.section?.title ?? "",
    note: block.section?.note ?? "",
    bands: Object.fromEntries(HANDOUT_BANDS.map((band) => [band, resolveAll(block.bands[band])])),
  })).filter((entry, index) => index > 0 || HANDOUT_BANDS.some((band) => entry.bands[band].length));
  return { modules, missingCount };
}

// A question swaps with its nearest neighbour in the same band of the same module;
// a module moves together with all its questions past the neighbouring module.
export function moveHandoutItem(items, id, direction) {
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) return items;
  if (items[index].kind === "question") {
    const band = bandOf(items[index]);
    for (let target = index + direction; target >= 0 && target < items.length && items[target].kind === "question"; target += direction) {
      if (bandOf(items[target]) !== band) continue;
      const next = [...items];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    }
    return items;
  }
  const blocks = moduleBlocks(items);
  const blockIndex = blocks.findIndex((block) => block.section?.id === id);
  const target = blockIndex + direction;
  if (target < 1 || target >= blocks.length) return items;
  [blocks[blockIndex], blocks[target]] = [blocks[target], blocks[blockIndex]];
  return blocks.flatMap((block) => block.section ? [block.section, ...block.items] : block.items);
}

// A question changing band joins the end of that band in its module.
export function setItemBand(items, id, band) {
  const index = items.findIndex((item) => item.id === id && item.kind === "question");
  if (index < 0 || !HANDOUT_BANDS.includes(band) || bandOf(items[index]) === band) return items;
  const section = items.slice(0, index).findLast((item) => item.kind === "section");
  const rest = items.filter((_, position) => position !== index);
  const at = insertIndexForSection(rest, section?.id ?? null);
  return [...rest.slice(0, at), { ...items[index], band }, ...rest.slice(at)];
}

// Every question sits in a module: questions saved before modules existed, or an empty 讲义, get a first module.
export function ensureLeadingModule(items, id) {
  return items[0]?.kind === "section" ? items : [{ id, kind: "section", title: "", note: "" }, ...items];
}

// New questions go to the end of the chosen module: null is the area before the first module.
export function insertIndexForSection(items, sectionId) {
  const start = sectionId == null ? 0 : items.findIndex((item) => item.id === sectionId) + 1;
  if (sectionId != null && start === 0) return items.length;
  const next = items.findIndex((item, index) => index >= start && item.kind === "section");
  return next < 0 ? items.length : next;
}

// 考点 are the question's own knowledge tags from the library.
export function questionPoints(question) {
  const tags = question?.tagsZh?.length ? question.tagsZh : question?.tags ?? [];
  return [...new Set(tags.map((tag) => String(tag).trim()).filter(Boolean))].slice(0, 3);
}
