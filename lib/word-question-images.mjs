export function standaloneWordQuestionImages(question) {
  const candidates = [...(question.contentImages ?? []), ...(question.diagramImage ? [question.diagramImage] : [])];
  const embedded = new Set([...Object.values(question.stemDocxAssets ?? {}), ...(question.optionsDocxXml?.length ? Object.values(question.optionsDocxAssets ?? {}) : [])]);
  return candidates.filter((source, index) => candidates.indexOf(source) === index && !embedded.has(source));
}
