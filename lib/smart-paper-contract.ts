import type { QuestionType, SmartPaperBrief, SmartPaperGroup, SmartPaperPlan } from "./types";

// 智能组卷 shared rules: what a plan may hold when it is stored, reopened or sent back by the agent.
export const SMART_PAPER_LIMITS = { days: 14, perDay: 40, questions: 300, request: 2000 };
const QUESTION_TYPES: QuestionType[] = ["单选题", "多选题", "填空题", "判断题", "解答题"];

const record = (value: unknown) => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const list = (value: unknown) => (Array.isArray(value) ? value : []);
const text = (value: unknown, limit: number) => (typeof value === "string" ? value.trim().slice(0, limit) : "");
const whole = (value: unknown, min: number, max: number, fallback: number) => {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

export function normalizeSmartPaperBrief(value: unknown): SmartPaperBrief {
  const raw = record(value);
  return {
    title: text(raw.title, 80),
    days: whole(raw.days, 1, SMART_PAPER_LIMITS.days, 1),
    perDay: whole(raw.perDay, 1, SMART_PAPER_LIMITS.perDay, 10),
    categoryIds: [...new Set(list(raw.categoryIds).map((id) => text(id, 100)).filter(Boolean))].slice(0, 60),
    questionTypes: [...new Set(list(raw.questionTypes).filter((type): type is QuestionType => QUESTION_TYPES.includes(type as QuestionType)))],
    difficulty: text(raw.difficulty, 200),
    focus: list(raw.focus).map((item) => ({ label: text(record(item).label, 30), description: text(record(item).description, 200) })).filter((item) => item.label).slice(0, 8),
  };
}

// A plan as it is stored: every question at most once and at most 300 in all, days kept in order with their titles.
// Malformed parts are dropped; a plan without a single question is not a plan.
export function normalizeSmartPaperPlan(value: unknown): SmartPaperPlan | null {
  const raw = record(value);
  const seen = new Set<string>();
  const groups: SmartPaperGroup[] = list(raw.groups).slice(0, SMART_PAPER_LIMITS.days).map((group, index) => {
    const items = list(record(group).items).flatMap((item) => {
      const id = text(record(item).id, 100);
      if (!id || seen.has(id) || seen.size >= SMART_PAPER_LIMITS.questions) return [];
      seen.add(id);
      return [{ id, focus: text(record(item).focus, 40), reason: text(record(item).reason, 300) }];
    });
    return { title: text(record(group).title, 60) || `第 ${index + 1} 天`, theme: text(record(group).theme, 120), items };
  });
  if (!seen.size) return null;
  return {
    request: text(raw.request, SMART_PAPER_LIMITS.request),
    studentId: text(raw.studentId, 100) || null,
    brief: normalizeSmartPaperBrief(raw.brief),
    findings: list(raw.findings).map((item) => ({ label: text(record(item).label, 60), evidence: text(record(item).evidence, 300) })).filter((item) => item.label).slice(0, 12),
    avoided: whole(raw.avoided, 0, 1_000_000, 0),
    groups,
  };
}

export function planQuestionIds(plan: Pick<SmartPaperPlan, "groups">) {
  return plan.groups.flatMap((group) => group.items.map((item) => item.id));
}
