import type { GradingItem, GradingVerdict, HomeworkCurriculum, HomeworkScoreSummary, QuestionType } from "./types";
export function isPendingGradingItem(item: Pick<GradingItem, "verdict" | "requiresReview" | "teacherMark" | "standardAnswer" | "referenceVerified">): boolean;
export function normalizeHomeworkAnswer(value: unknown): string;
export function isSimpleObjectiveAnswer(type: QuestionType, answer: string): boolean;
export function finalizeHomeworkVerdict(input: {
  type: QuestionType; standardAnswer: string; studentAnswer: string; modelVerdict: GradingVerdict;
  confidence: number; warnings?: string[]; threshold?: number; answerState?: string; maxScore?: number | null; modelScore?: number | null; curriculum?: HomeworkCurriculum;
}): { verdict: GradingVerdict; requiresReview: boolean; confidence: number; score: number | null };
export function normalizeMaxScore(value: unknown): number | null;
export function reconcileHomeworkScore(verdict: GradingVerdict, score: unknown, maxScore: unknown, curriculum?: HomeworkCurriculum): { verdict: GradingVerdict; score: number | null };
export function summarizeHomeworkScore(items: Array<{ score: number | null; maxScore: number | null }>): HomeworkScoreSummary | null;
export function homeworkQuestionLabel(questionNumber: unknown): string;
