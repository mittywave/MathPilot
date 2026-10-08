export function saveQuestionImportBatch<T, Q>(
  drafts: T[], createQuestion: (draft: T) => Promise<Q>, concurrency?: number,
): Promise<{ saved: { draft: T; question: Q }[]; failed: { draft: T; error: string }[] }>;
