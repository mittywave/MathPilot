import type { GradingItem, InternationalReport, SubmissionReport } from "./types";
export function normalizeSubmissionReport(value: unknown, now?: number): SubmissionReport;
export function buildFallbackSubmissionReport(items: Array<Partial<GradingItem> & { questionNumber?: string }>, now?: number): SubmissionReport;
export function mainQuestionNumber(number: string): string;
export function normalizeInternationalReport(value: unknown): InternationalReport;
export function completeInternationalReport(report: InternationalReport, items: GradingItem[]): InternationalReport;
export function buildFallbackInternationalReport(items: GradingItem[]): InternationalReport;
