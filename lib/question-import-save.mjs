// Wait for every in-flight save before deciding which drafts may be retried.
// A rejected Promise.all loses the successes that finish after the first error.
export async function saveQuestionImportBatch(drafts, createQuestion, concurrency = 3) {
  const results = new Array(drafts.length);
  let nextIndex = 0;
  async function run() {
    while (nextIndex < drafts.length) {
      const index = nextIndex++;
      const draft = drafts[index];
      try {
        results[index] = { draft, question: await createQuestion(draft) };
      } catch (error) {
        results[index] = { draft, error: error instanceof Error ? error.message : '试题保存失败' };
      }
    }
  }
  const limit = Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 3;
  await Promise.all(Array.from({ length: Math.min(limit, drafts.length) }, run));
  return {
    saved: results.filter(result => 'question' in result),
    failed: results.filter(result => 'error' in result),
  };
}
