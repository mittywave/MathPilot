import type { Category, LibraryModule, Question } from "./types";

// "模块 / 分类 / 子分类", the label every category picker shows.
export function categoryPath(modules: LibraryModule[], categories: Category[], id: string) {
  const directModule = modules.find((item) => item.id === id); if (directModule) return directModule.name;
  const names: string[] = []; let current = categories.find((item) => item.id === id); let guard = 0;
  while (current && guard < 20) {
    names.unshift(current.name);
    const parentModule = modules.find((item) => item.id === current?.parentId);
    if (parentModule) { names.unshift(parentModule.name); break; }
    const parentId = current.parentId;
    current = categories.find((item) => item.id === parentId); guard += 1;
  }
  return names.join(" / ");
}

export function categoryDescendants(categories: Category[], id: string): string[] {
  return [id, ...categories.filter((item) => item.parentId === id).flatMap((item) => categoryDescendants(categories, item.id))];
}

// Search question content, topic tags and optional source details.
export function questionMatchesKeyword(question: Question, keyword: string, path: string) {
  return `${question.stem} ${question.answer} ${question.analysis} ${question.source} ${question.examYear ?? ""} ${(question.tags ?? []).join(" ")} ${(question.tagsZh ?? []).join(" ")} ${(question.tagsEn ?? []).join(" ")} ${path}`.toLowerCase().includes(keyword);
}
