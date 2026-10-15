export const HANDOUT_LIMITS = { title: 120, items: 400, id: 200, sectionTitle: 200, note: 20_000 };
export const DEFAULT_HANDOUT_TITLE = "未命名讲义";

// 讲义放在三个书架上：课程体系按自定义体系 → 阶段 → 单元 → 课次编排；
// 专题库按自定义专题存放讲义；学生讲义挂在学生档案下，只有这位学生的老师能看到。
export const HANDOUT_GRADES = [{ value: 7, label: "初一" }, { value: 8, label: "初二" }, { value: 9, label: "初三" }];
export const HANDOUT_DOMAINS = [{ value: "function", label: "函数" }, { value: "geometry", label: "几何" }, { value: "algebra", label: "代数" }, { value: "number", label: "数论" }, { value: "thinking", label: "数学思想" }];
export const HANDOUT_TOPIC_ROOT = "topic-library";
export const HANDOUT_SHELVES = [{ value: "course", label: "课程体系" }, { value: "topic", label: "专题库" }, { value: "student", label: "学生讲义" }];
// Handouts filed nowhere wait in the topic library until moved.
export const UNSORTED_TOPIC_LABEL = "未分板块";

// The shelf follows from where a handout is stored: a student, a course unit, or the topic library.
export const shelfOf = (group) => group?.studentId ? "student" : group?.courseUnitId ? "course" : "topic";

// A group is one course unit, topic domain or student; lesson numbers follow its order.
// Nothing given is the unsorted topic shelf; malformed placement is refused.
export function normalizeHandoutGroup(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const given = (value) => value !== undefined && value !== null && value !== "";
  if (given(source.studentId)) {
    const studentId = typeof source.studentId === "string" ? source.studentId.trim() : "";
    return studentId && studentId.length <= HANDOUT_LIMITS.id ? { courseUnitId: null, domain: null, studentId } : null;
  }
  if (given(source.domain)) {
    const domain = typeof source.domain === "string" ? source.domain.trim() : "";
    return domain && domain.length <= HANDOUT_LIMITS.id ? { courseUnitId: null, domain, studentId: null } : null;
  }
  // Old clients must reload instead of silently placing a course lesson in topics.
  if (given(source.grade) || given(source.term)) return null;
  const courseUnitId = given(source.courseUnitId) ? typeof source.courseUnitId === "string" ? source.courseUnitId.trim() : "" : null;
  if (courseUnitId === "" || (courseUnitId && courseUnitId.length > HANDOUT_LIMITS.id)) return null;
  return { courseUnitId, domain: null, studentId: null };
}

export const sameGroup = (a, b) => ["studentId", "domain", "courseUnitId"].every((key) => (a?.[key] ?? null) === (b?.[key] ?? null));

// A course breadcrumb, topic domain or student name.
export function groupLabel(group) {
  if (group?.studentId) return group.studentName || "学生讲义";
  if (group?.courseUnitId) return group.coursePath?.map((node) => node.name).join(" / ") || "课程体系";
  if (group?.domainName) return group.domainName;
  const domain = HANDOUT_DOMAINS.find((item) => item.value === group?.domain)?.label;
  return domain ? `${domain}专题` : group?.domain ? "专题库" : UNSORTED_TOPIC_LABEL;
}

// Stable IDs keep names and order independent of the lessons already written.
export function coursePath(nodes, id) {
  const path = [];
  while (id && path.length < 3) {
    const node = nodes.find((item) => item.id === id);
    if (!node) return [];
    path.unshift(node); id = node.parentId;
  }
  return id ? [] : path;
}

// 每个知识模块固定四段：知识点 → 例题 → 练习 → 变式。编辑页、精排 PDF 和 Word 共用这些说法。
export const HANDOUT_BANDS = ["example", "practice", "variant"];
// tagline 只印在精排 PDF 和 Word 里；编辑页只显示 label。hint 是知识点编辑框的占位提示。
export const HANDOUT_PARTS = {
  knowledge: { label: "知识点", tagline: "本模块要掌握的内容", hint: "列出本模块要掌握的全部内容；可粘贴或拖入截图自动识别" },
  example: { label: "例题", prefix: "例", tagline: "跟着老师，看知识点怎么用" },
  practice: { label: "练习", prefix: "", tagline: "自己动手，检验掌握" },
  variant: { label: "变式", prefix: "变式", tagline: "换个情境，抓住本质" },
};
// 一讲的三份资料。讲义按知识模块编排；小测和作业各是一列题，编号 1、2、3…，每道题记着它考的是哪个模块。
export const HANDOUT_SHEETS = [{ value: "handout", label: "讲义" }, { value: "quiz", label: "小测" }, { value: "homework", label: "作业" }];
export const sheetLabel = (sheet) => HANDOUT_SHEETS.find((item) => item.value === sheet)?.label ?? HANDOUT_SHEETS[0].label;
const LISTS = ["quiz", "homework"];
const onList = (item) => LISTS.includes(item?.kind);
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
// 小测 and 作业 questions are kept after the whole 讲义, each list in its own order.
export function normalizeHandoutDraft(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const title = text(source.title, HANDOUT_LIMITS.title).trim() || DEFAULT_HANDOUT_TITLE;
  const items = []; const seen = new Set();
  for (const item of Array.isArray(source.items) ? source.items : []) {
    if (items.length === HANDOUT_LIMITS.items) break;
    const id = text(item?.id, HANDOUT_LIMITS.id).trim();
    if (!id || seen.has(id)) continue;
    if (item.kind === "question" || onList(item)) {
      const questionId = text(item.questionId, HANDOUT_LIMITS.id).trim();
      if (!questionId || (item.scope !== "public" && item.scope !== "mine")) continue;
      items.push(item.kind === "question" ? { id, kind: "question", scope: item.scope, questionId, band: bandOf(item) }
        : { id, kind: item.kind, scope: item.scope, questionId, moduleId: text(item.moduleId, HANDOUT_LIMITS.id).trim() || null });
    } else if (item.kind === "section") {
      items.push({ id, kind: "section", title: text(item.title, HANDOUT_LIMITS.sectionTitle), note: text(item.note, HANDOUT_LIMITS.note) });
    } else continue;
    seen.add(id);
  }
  // A 小测 or 作业 question that names no module of this handout goes with the first module.
  const modules = items.filter((item) => item.kind === "section").map((item) => item.id);
  for (const item of items) if (onList(item) && !modules.includes(item.moduleId)) item.moduleId = modules[0] ?? null;
  return { title, items: [...items.filter((item) => !onList(item)), ...items.filter(onList)] };
}

// A section item is a knowledge module; 讲义 questions belong to the module before them.
// Questions placed before the first module form an untitled leading block. 小测 and 作业 questions belong to no block.
function moduleBlocks(items) {
  const blocks = [{ section: null, items: [] }];
  for (const item of items) {
    if (item.kind === "section") blocks.push({ section: item, items: [] });
    else if (item.kind === "question") blocks.at(-1).items.push(item);
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

// A 讲义 question swaps with its nearest neighbour in the same band of the same module, a 小测 or 作业 question
// with its neighbour in the list; a module moves together with all its 讲义 questions past the neighbouring module.
export function moveHandoutItem(items, id, direction) {
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) return items;
  const moving = items[index];
  if (moving.kind !== "section") {
    for (let target = index + direction; target >= 0 && target < items.length; target += direction) {
      if (moving.kind === "question" && items[target].kind === "section") break;
      if (items[target].kind !== moving.kind || (moving.kind === "question" && bandOf(items[target]) !== bandOf(moving))) continue;
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
  return [...blocks.flatMap((block) => block.section ? [block.section, ...block.items] : block.items), ...items.filter(onList)];
}

// Deleting a module takes its 讲义 questions with it; 小测 and 作业 questions on it move to the module before it
// (after it, when it was the first).
export function removeHandoutModule(items, sectionId) {
  const sections = items.filter((item) => item.kind === "section");
  const at = sections.findIndex((item) => item.id === sectionId);
  if (at < 0) return items;
  const heir = (sections[at - 1] ?? sections[at + 1])?.id ?? null;
  const removed = new Set([sectionId, ...moduleBlocks(items).find((block) => block.section?.id === sectionId).items.map((item) => item.id)]);
  return items.flatMap((item) => removed.has(item.id) ? [] : [onList(item) && item.moduleId === sectionId ? { ...item, moduleId: heir } : item]);
}

// A copy gets fresh ids throughout; its 小测 and 作业 questions stay with the copies of their modules.
export function copyHandoutItems(items, newId) {
  const ids = new Map(items.map((item) => [item.id, newId()]));
  return items.map((item) => ({ ...item, id: ids.get(item.id), ...(onList(item) ? { moduleId: ids.get(item.moduleId) ?? null } : {}) }));
}

// How many questions the 小测 and the 作业 hold, for the shelf.
export function sheetCounts(items) {
  return Object.fromEntries(LISTS.map((sheet) => [sheet, items.filter((item) => item.kind === sheet).length]));
}

// A 小测 or 作业 as it prints: its questions in list order, without those the library no longer has.
export function sheetQuestions(items, sheet, resolve) {
  let missingCount = 0;
  const questions = items.flatMap((item) => {
    if (item.kind !== sheet) return [];
    const question = resolve(item.scope, item.questionId);
    if (!question) missingCount += 1;
    return question ? [question] : [];
  });
  return { questions, missingCount };
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

// Every question sits in a module: questions saved before modules existed, or an empty 讲义, get a first module,
// and 小测 and 作业 questions that had no module to name go with it.
export function ensureLeadingModule(items, id) {
  if (items[0]?.kind === "section") return items;
  return [{ id, kind: "section", title: "", note: "" }, ...items.map((item) => onList(item) && !item.moduleId ? { ...item, moduleId: id } : item)];
}

// New questions go to the end of the chosen module: null is the area before the first module.
// The 小测 and 作业 lists stay after the whole 讲义.
export function insertIndexForSection(items, sectionId) {
  const lists = items.findIndex(onList);
  const start = sectionId == null ? 0 : items.findIndex((item) => item.id === sectionId) + 1;
  if (sectionId != null && start === 0) return lists < 0 ? items.length : lists;
  const next = items.findIndex((item, index) => index >= start && (item.kind === "section" || onList(item)));
  return next < 0 ? items.length : next;
}

// 考点 are the question's own knowledge tags from the library.
export function questionPoints(question) {
  const tags = question?.tagsZh?.length ? question.tagsZh : question?.tags ?? [];
  return [...new Set(tags.map((tag) => String(tag).trim()).filter(Boolean))].slice(0, 3);
}
