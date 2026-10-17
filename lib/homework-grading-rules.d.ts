import type { GradingItem, GradingVerdict, HomeworkCurriculum, HomeworkProgress, HomeworkScoreSummary, QuestionType, StudentHomework } from "./types";
export function isHomeworkGrading(item: Pick<StudentHomework, "latest">): boolean;
export function homeworkProgress(items: Array<Pick<StudentHomework, "latest" | "assigned" | "pending" | "done" | "total">>): HomeworkProgress | null;
export function isPendingGradingItem(item: Pick<GradingItem, "verdict" | "requiresReview" | "teacherMark" | "standardAnswer" | "referenceVerified">): boolean;
export function titleWithoutStudent(title: string, studentName?: string | null): string;
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
