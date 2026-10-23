import { moduleHeading } from "./handout-rules.mjs";
import type { Question, QuestionType, TypesetSettings } from "./types";

export const basketQuestionTypes: QuestionType[] = ["单选题", "多选题", "填空题", "判断题", "解答题"];
export type BasketStructure = { sections: { id: string; title: string; questionIds: string[] }[]; unassignedIds: string[] };
export type BasketDraft = {
  version: 1; structure: BasketStructure; title: string; includeAnswers: boolean;
  snapshots: Question[]; temporaryQuestions: Question[]; typeset: { ids: string; settings: TypesetSettings } | null;
};

export function basketIds(basket: BasketStructure): string[] {
  return [...basket.sections.flatMap((section) => section.questionIds), ...basket.unassignedIds];
}

// Selection changes keep existing placements; new questions always wait at the end.
export function selectBasketQuestions(basket: BasketStructure, ids: string[]): BasketStructure {
  const wanted = new Set(ids), previous = new Set(basketIds(basket));
  return {
    sections: basket.sections.map((section) => ({ ...section, questionIds: section.questionIds.filter((id) => wanted.has(id)) })),
    unassignedIds: [...basket.unassignedIds.filter((id) => wanted.has(id)), ...[...wanted].filter((id) => !previous.has(id))],
  };
}

export function placeBasketQuestion(basket: BasketStructure, id: string, sectionId: string | null, beforeId?: string): BasketStructure {
  if (!basketIds(basket).includes(id) || beforeId === id || sectionId !== null && !basket.sections.some((section) => section.id === sectionId)) return basket;
  const next = selectBasketQuestions(basket, basketIds(basket).filter((item) => item !== id));
  const target = sectionId === null ? next.unassignedIds : next.sections.find((section) => section.id === sectionId)!.questionIds;
  const before = beforeId ? target.indexOf(beforeId) : -1;
  target.splice(before < 0 ? target.length : before, 0, id);
  return next;
}

export function removeBasketSection(basket: BasketStructure, id: string): BasketStructure {
  const section = basket.sections.find((item) => item.id === id);
  return section ? { sections: basket.sections.filter((item) => item.id !== id), unassignedIds: [...basket.unassignedIds, ...section.questionIds] } : basket;
}

export function groupBasketByType(basket: BasketStructure, pool: Question[], idFor: () => string): BasketStructure {
  const questions = orderedBasketQuestions(pool, basketIds(basket));
  return { sections: basketQuestionTypes.flatMap((type) => {
    const ids = questions.filter((question) => question.type === type).map((question) => question.id);
    return ids.length ? [{ id: idFor(), title: type, questionIds: ids }] : [];
  }), unassignedIds: questions.filter((question) => !basketQuestionTypes.includes(question.type)).map((question) => question.id) };
}

// This projection supplies every visible/exported heading, question number and order.
// Empty headings remain editable but take no printed section number.
export function basketSections(basket: BasketStructure, pool: Question[]) {
  let start = 0, ordinal = 0;
  const project = (id: string | null, title: string, ids: string[]) => {
    const questions = orderedBasketQuestions(pool, ids);
    const name = moduleHeading(title, ordinal).title || "新分组";
    const heading = questions.length && basket.sections.length ? `${moduleHeading(name, ordinal++).numeral}、${name}` : "";
    const section = { id, title: name, heading, questions, start };
    start += questions.length;
    return section;
  };
  return [...basket.sections.map((section) => project(section.id, section.title, section.questionIds)),
    project(null, "其他题目", basket.unassignedIds)];
}

export function restoreBasketDraft(raw: unknown, library: Question[]): { draft: BasketDraft; missing: number } {
  const value = raw as Partial<BasketDraft> | null;
  if (!value || value.version !== 1 || !Array.isArray(value.structure?.sections) || !Array.isArray(value.structure?.unassignedIds)) throw new Error("本机组卷草稿格式无法读取，已保留原记录");
  const seen = new Set<string>(), sections = new Set<string>();
  const ids = (list: unknown) => (Array.isArray(list) ? list : []).filter((id): id is string => {
    if (typeof id !== "string" || !id || seen.has(id)) return false;
    seen.add(id); return true;
  });
  const structure: BasketStructure = { sections: value.structure.sections.flatMap((section) => {
    if (!section || typeof section.id !== "string" || !section.id || sections.has(section.id)) return [];
    sections.add(section.id);
    return [{ id: section.id, title: typeof section.title === "string" ? section.title : "新分组", questionIds: ids(section.questionIds) }];
  }), unassignedIds: ids(value.structure.unassignedIds) };
  const snapshots = (Array.isArray(value.snapshots) ? value.snapshots : []).filter((question) => question && typeof question.id === "string" && typeof question.stem === "string" && typeof question.answer === "string" && typeof question.analysis === "string" && Array.isArray(question.options) && basketQuestionTypes.includes(question.type) && seen.has(question.id));
  const temporaryQuestions = (Array.isArray(value.temporaryQuestions) ? value.temporaryQuestions : []).filter((question, index, all) => question && typeof question.id === "string" && question.id && typeof question.stem === "string" && typeof question.answer === "string" && typeof question.analysis === "string" && Array.isArray(question.options) && basketQuestionTypes.includes(question.type) && all.findIndex((item) => item?.id === question.id) === index);
  const available = new Set([...library, ...snapshots, ...temporaryQuestions].map((question) => question.id));
  const present = basketIds(structure).filter((id) => available.has(id));
  return { missing: seen.size - present.length, draft: {
    version: 1, structure: selectBasketQuestions(structure, present),
    title: typeof value.title === "string" ? value.title : "专项练习", includeAnswers: value.includeAnswers !== false,
    snapshots: snapshots.filter((question) => !library.some((item) => item.id === question.id)),
    temporaryQuestions,
    typeset: value.typeset && typeof value.typeset.ids === "string" && value.typeset.settings && typeof value.typeset.settings === "object" ? value.typeset : null,
  } };
}

// A single atomic record per account; question images in wrong-book snapshots can
// exceed localStorage's quota, so keep the complete draft in IndexedDB.
export async function basketStorage(owner: string, action: "read" | "write", value?: BasketDraft): Promise<unknown> {
  if (!owner || action === "write" && !value) throw new Error("缺少组卷草稿或账号");
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("mathpilot-paper-basket", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("drafts");
    let blocked = false;
    request.onblocked = () => { blocked = true; reject(new Error("请关闭旧的组卷页后重试本机保存")); };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { if (blocked) { request.result.close(); return; } request.result.onversionchange = () => request.result.close(); resolve(request.result); };
  });
  return new Promise((resolve, reject) => {
    const tx = db.transaction("drafts", action === "read" ? "readonly" : "readwrite");
    const store = tx.objectStore("drafts");
    const request = action === "read" ? store.get(owner) : store.put(value, owner);
    tx.oncomplete = () => { db.close(); resolve(action === "read" ? request.result : null); };
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error || new Error("本机组卷保存失败")); };
  });
}

export function orderedBasketQuestions<T extends { id: string }>(questions: T[], ids: string[]): T[] {
  const byId = new Map(questions.map((question) => [question.id, question]));
  return [...new Set(ids)].flatMap((id) => {
    const question = byId.get(id);
    return question ? [question] : [];
  });
}

export function moveBasketQuestion(ids: string[], id: string, direction: -1 | 1): string[] {
  const index = ids.indexOf(id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= ids.length) return ids;
  const next = [...ids];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
