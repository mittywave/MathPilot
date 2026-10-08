import type { LibraryData, LibraryModule, Question } from "../../../../lib/types";
import { requireSameOrigin, requireUser } from "../../../../lib/server/auth";
import { createScopedCategory, createScopedModule, createScopedQuestion } from "../../../../lib/server/library";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireUser(request);
    const body = await request.json() as LibraryData;
    if (!Array.isArray(body.categories) || !Array.isArray(body.questions)) return Response.json({ error: "备份格式不正确" }, { status: 400 });
    if (body.questions.length > 1000 || body.categories.length > 500 || (body.modules?.length ?? 0) > 100) {
      return Response.json({ error: "单次最多导入 100 个模块、500 个分类和 1000 道题" }, { status: 413 });
    }
    const legacyRoots = body.categories.filter((item) => item.parentId == null);
    const categoriesById = new Map(body.categories.map((item) => [item.id, item]));
    const rootModuleId = (categoryId: string) => {
      let current = categoriesById.get(categoryId);
      const seen = new Set<string>();
      while (current && !seen.has(current.id)) {
        seen.add(current.id);
        if (!current.parentId) return current.id;
        current = categoriesById.get(current.parentId);
      }
      return null;
    };
    const sourceModules: LibraryModule[] = body.modules?.length ? body.modules : legacyRoots.map((item, index) => ({
      id: item.id, name: item.name, subtitle: "", sortOrder: index, createdAt: item.createdAt, updatedAt: item.createdAt,
    }));
    const moduleIds = new Map<string, string>();
    for (const source of sourceModules.sort((left, right) => left.sortOrder - right.sortOrder)) {
      const created = await createScopedModule({ name: source.name, subtitle: source.subtitle }, user);
      moduleIds.set(source.id, created.id);
    }

    const categoryIds = new Map<string, string>();
    const remaining = body.categories.filter((item) => !legacyRoots.some((root) => root.id === item.id));
    let guard = 0;
    while (remaining.length && guard < body.categories.length + 1) {
      guard += 1;
      let progressed = false;
      for (let index = remaining.length - 1; index >= 0; index -= 1) {
        const source = remaining[index];
        const sourceModuleId = source.moduleId ?? rootModuleId(source.id);
        const moduleId = sourceModuleId ? moduleIds.get(sourceModuleId) : null;
        if (!moduleId) continue;
        const parentId = !source.parentId || moduleIds.has(source.parentId) ? moduleId : categoryIds.get(source.parentId);
        if (!parentId) continue;
        const created = await createScopedCategory({ ...source, id: crypto.randomUUID(), moduleId, parentId }, user);
        categoryIds.set(source.id, created.id); remaining.splice(index, 1); progressed = true;
      }
      if (!progressed) break;
    }
    if (remaining.length) return Response.json({ error: "备份中存在无法还原的分类层级" }, { status: 400 });

    let imported = 0;
    for (const raw of body.questions as Question[]) {
      const sourceModuleId = raw.moduleId ?? categoriesById.get(raw.categoryId)?.moduleId ?? rootModuleId(raw.categoryId);
      const moduleId = sourceModuleId ? moduleIds.get(sourceModuleId) : null;
      if (!moduleId || !raw.stem?.trim()) continue;
      const categoryId = raw.categoryId === sourceModuleId ? moduleId : categoryIds.get(raw.categoryId) ?? moduleId;
      await createScopedQuestion({ ...raw, id: crypto.randomUUID(), moduleId, categoryId }, user);
      imported += 1;
    }
    return Response.json({ imported, modules: moduleIds.size, categories: categoryIds.size });
  } catch (error) {
    if (error instanceof Response) return error;
    return Response.json({ error: error instanceof Error ? error.message : "备份导入失败" }, { status: 500 });
  }
}
