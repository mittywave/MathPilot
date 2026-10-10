const OBJECTIVE_TYPES = new Set(["单选题", "多选题", "填空题", "判断题"]);

export function normalizeHomeworkAnswer(value) {
  return String(value ?? "")
    .trim()
    .replace(/\$+/g, "")
    .replace(/\\[()[\]]/g, "")
    .replace(/[Ａ-Ｆ]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0xfee0))
    .replace(/[√✓]/g, "正确")
    .replace(/[×✕✗]/g, "错误")
    .replace(/^(?:答案|答)[：:]\s*/u, "")
    .replace(/[，,、;；\s]+/g, "")
    .replace(/[。．]$/g, "")
    .toUpperCase();
}

export function isSimpleObjectiveAnswer(type, answer) {
  if (!OBJECTIVE_TYPES.has(type)) return false;
  const normalized = normalizeHomeworkAnswer(answer);
  if (!normalized) return false;
  if (type === "单选题" || type === "多选题") return /^[A-F]+$/.test(normalized);
  if (type === "判断题") return /^(正确|错误|TRUE|FALSE|对|错)$/.test(normalized);
  return /^[-+]?\d+(?:\.\d+)?(?:%|°)?$/.test(normalized) || /^[A-F]+$/.test(normalized);
}

/**
 * School homework identifies a question as “page-printed number(sub-part)”: 5-3(2) reads 第 5 面 第 3 题 (2).
 * A single exam paper keeps its printed numbers, such as 3(b)(ii).
 */
export function homeworkQuestionLabel(questionNumber) {
  const number = String(questionNumber ?? "").trim();
  const school = /^(\d+)-(.+?)((?:\([^()]*\))*)$/.exec(number);
  if (!school) return `第 ${number} 题`;
  const [, page, printed, parts] = school;
  return `第 ${page} 面 第 ${printed} 题${parts ? ` ${parts}` : ""}`;
}

// Marks exist only when the paper prints them; half marks are the finest step a paper uses.
export function normalizeMaxScore(value) {
  const number = value == null || value === "" ? NaN : Number(value);
  return Number.isFinite(number) && number > 0 && number <= 1000 ? Math.round(number * 2) / 2 : null;
}

/**
 * A score always agrees with the verdict stored beside it; without printed marks there is no score.
 * IGCSE / A Level marking counts an unreadable answer as 0 marks; it still waits for a clearer photo.
 */
export function reconcileHomeworkScore(verdict, score, maxScore, curriculum = "school") {
  const max = normalizeMaxScore(maxScore);
  if (max != null && verdict === "unreadable" && curriculum === "international") return { verdict, score: 0 };
  if (max == null || !["correct", "partial", "incorrect"].includes(verdict)) return { verdict, score: null };
  const raw = score == null || score === "" ? NaN : Number(score);
  if (Number.isFinite(raw)) {
    const value = Math.max(0, Math.min(max, Math.round(raw * 2) / 2));
    return { verdict: value >= max ? "correct" : value <= 0 ? "incorrect" : "partial", score: value };
  }
  return { verdict, score: verdict === "correct" ? max : verdict === "incorrect" ? 0 : null };
}

/** The denominator is every question on the paper; a total exists only when each question carries marks. Any number is a settled score. */
export function summarizeHomeworkScore(items) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length || rows.some((item) => normalizeMaxScore(item.maxScore) == null)) return null;
  const maxScore = rows.reduce((sum, item) => sum + normalizeMaxScore(item.maxScore), 0);
  const settled = rows.filter((item) => item.score != null && Number.isFinite(Number(item.score)));
  const score = settled.reduce((sum, item) => sum + Number(item.score), 0);
  const pending = rows.length - settled.length;
  return { score, maxScore, pending, percentage: pending ? null : Math.round(score * 1000 / maxScore) / 10 };
}

export function finalizeHomeworkVerdict(input) {
  const confidence = Math.max(0, Math.min(1, Number(input.confidence) || 0));
  const scored = (verdict, requiresReview, score) => ({ ...reconcileHomeworkScore(verdict, score, input.maxScore, input.curriculum), requiresReview, confidence });
  if (input.answerState === "blank") return scored("incorrect", false, 0);
  if (input.modelVerdict === "unreadable" || input.modelVerdict === "review_required" || !normalizeHomeworkAnswer(input.studentAnswer)) {
    return scored(input.modelVerdict === "review_required" ? "review_required" : "unreadable", true, null);
  }
  const simple = isSimpleObjectiveAnswer(input.type, input.standardAnswer);
  if (simple) {
    const reference = normalizeHomeworkAnswer(input.standardAnswer);
    const student = normalizeHomeworkAnswer(input.studentAnswer);
    return scored(reference === student ? "correct" : "incorrect", false, null);
  }
  const verdict = ["correct", "partial", "incorrect"].includes(input.modelVerdict) ? input.modelVerdict : "unreadable";
  return scored(verdict, verdict === "unreadable", input.modelScore);
}
