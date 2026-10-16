export function orderedImportTimestamp(batchStartedAt, index) {
  const startedAt = Number.isFinite(batchStartedAt) ? Math.trunc(batchStartedAt) : Date.now();
  const offset = Number.isFinite(index) ? Math.max(0, Math.trunc(index)) : 0;
  return Math.max(1, startedAt - offset);
}

export function retainedQuestionCreatedAt(value, now = Date.now()) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= now ? Math.trunc(timestamp) : now;
}

// A file may restart its numbering in every section (例题精练 1…, 知识拼接 1…), so a question number does not
// identify a question. Only the first question of a page that repeats the type and number of the previous
// page's last question looks like one question read twice across the page break.
export function crossPageRepeat(previous, current, firstOnPage) {
  return Boolean(firstOnPage && previous && current.number && current.pageNumber === previous.pageNumber + 1
    && current.number === previous.number && current.type === previous.type);
}

// Answers and other data the source gives by number go to the one selected question with that number.
// When several share it, nothing is filled in; the caller flags them instead of guessing.
export function numberedImportTarget(items, number) {
  const matches = number.trim() ? items.filter((item) => item.selected && item.documentNumber === number) : [];
  return matches.length === 1 ? { target: matches[0], clash: [] } : { target: undefined, clash: matches };
}
