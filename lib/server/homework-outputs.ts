import type { AuthUser, HomeworkOutputs, HomeworkSubmission } from "../types";

// Grading only produces the record of one homework. Everything it feeds about the student is a separate
// module, chosen per homework at upload, so each can change or stay off without touching the grading pipeline.
export const DEFAULT_HOMEWORK_OUTPUTS: HomeworkOutputs = { wrongBook: true, report: true, profile: false };

export function normalizeHomeworkOutputs(value: unknown): HomeworkOutputs {
  const raw = value && typeof value === "object" ? value as Partial<Record<keyof HomeworkOutputs, unknown>> : {};
  return {
    wrongBook: typeof raw.wrongBook === "boolean" ? raw.wrongBook : DEFAULT_HOMEWORK_OUTPUTS.wrongBook,
    report: typeof raw.report === "boolean" ? raw.report : DEFAULT_HOMEWORK_OUTPUTS.report,
    profile: typeof raw.profile === "boolean" ? raw.profile : DEFAULT_HOMEWORK_OUTPUTS.profile,
  };
}

/** Brings every chosen output up to date with the current grading; a correction refreshes the report. */
export async function applySubmissionOutputs(submission: HomeworkSubmission, user: AuthUser, options: { refreshReport?: boolean } = {}) {
  const { outputs } = submission;
  if (outputs.report && (options.refreshReport || !submission.report)) await (await import("./homework-reports")).generateSubmissionReport(submission, user);
  if (outputs.wrongBook) await (await import("./homework-wrong-book")).syncSubmissionWrongBook(submission, user);
  if (outputs.profile) await (await import("./homework-capabilities")).replaceSubmissionCapabilityEvidence({
    ownerUserId: user.id, studentId: submission.studentId, assignmentId: submission.assignmentId, submissionId: submission.id, gradingItems: submission.gradingItems,
  });
}
