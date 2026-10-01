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
