const OBJECTIVE_TYPES = new Set(["单选题", "多选题", "填空题", "判断题"]);

/** Lists already identify the student; keep the stored title for the printed exercise. */
export function titleWithoutStudent(title, studentName) {
  const name = studentName?.trim();
  if (!name || !title.startsWith(name)) return title;
  const rest = title.slice(name.length);
  const separator = /^(?:\s*[·\-－：:]\s*|\s+)/u.exec(rest);
  if (!separator) return title;
  return rest.slice(separator[0].length).trim() || title;
}

/** Any day's upload can still be grading, even when a later day has finished. */
export function isHomeworkGrading(item) {
  return Boolean(item.grading || item.latest.status === "submitted" || item.latest.status === "processing");
}

/** The badge beside a student in 学生档案: 批改中 while any upload is graded, else 作业中 while assigned work is not done. */
export function homeworkProgress(items) {
  return items.some(isHomeworkGrading) ? "grading"
    : items.some((item) => item.assigned && !item.endedAt && (item.latest.status !== "published" || item.pending > 0 || item.done < item.total)) ? "assigned" : null;
}

/** A verified reference may hold its answer in the analysis; a teacher's mark needs no reference. */
export function isPendingGradingItem(item) {
  return Boolean(item.requiresReview
    || item.verdict === "unreadable" || item.verdict === "review_required"
    || ((item.verdict === "incorrect" || item.verdict === "partial") && !item.teacherMark
      && (!(item.standardAnswer?.trim() || item.standardAnalysis?.trim()) || !item.referenceVerified)));
}

export function normalizeHomeworkAnswer(value, type) {
  let normalized = String(value ?? "")
    .trim()
    .replace(/\$+/g, "")
    .replace(/\\[()[\]]/g, "")
    .replace(/[！-～]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0xfee0))
    .replace(/−/g, "-")
    .replace(/[√✓]/g, "正确")
    .replace(/[×✕✗]/g, "错误")
    .replace(/^(?:答案|答)[：:]\s*/u, "")
    .replace(/[，、;；]/g, ",")
    .replace(/(?<=\d)\s+(?=[+-]?\d)/g, ",")
    .replace(/\s+/g, "")
    .replace(/[。．]$/g, "")
    .toUpperCase();
  if (type === "判断题") {
    if (/^(正确|TRUE|对)$/.test(normalized)) return "正确";
    if (/^(错误|FALSE|错)$/.test(normalized)) return "错误";
  }
  if (/^[A-F](?:,?[A-F])*$/.test(normalized)) {
    normalized = normalized.replace(/,/g, "");
    // Duplicated options are invalid, not a set that may silently discard repetitions.
    if (type === "多选题" && new Set(normalized).size === normalized.length) normalized = [...normalized].sort().join("");
  }
  if (type === "填空题" && /^[+-]?\d+[%°]?(?:,[+-]?\d+[%°]?)*$/.test(normalized)) {
    normalized = normalized.split(",").map(part => part.replace(/^[+-]?\d+/, integer => String(BigInt(integer)))).join(",");
  }
  return normalized;
}

export function isSimpleObjectiveAnswer(type, answer) {
  if (!OBJECTIVE_TYPES.has(type)) return false;
  const normalized = normalizeHomeworkAnswer(answer, type);
  if (!normalized) return false;
  if (type === "单选题") return /^[A-F]$/.test(normalized);
  if (type === "多选题") return /^[A-F]+$/.test(normalized) && new Set(normalized).size === normalized.length;
  if (type === "判断题") return /^(正确|错误|TRUE|FALSE|对|错)$/.test(normalized);
  // A decimal reference may require a reduced fraction in the student's answer;
  // the model must check its value and final form instead of comparing strings.
  return /^-?\d+[%°]?(?:,-?\d+[%°]?)*$/.test(normalized) || /^[A-F]$/.test(normalized);
}

/**
 * School homework identifies a question as “page-printed number(sub-part)”: 5-3(2) reads 第 5 面 第 3 题 (2).
 * A single exam paper keeps its printed numbers, such as 3(b)(ii). An assigned material printed in days numbers each
 * day from 1: D2-3 reads 第 2 天 第 3 题.
 */
export function homeworkQuestionLabel(questionNumber) {
  const number = String(questionNumber ?? "").trim();
  const day = /^D(\d+)-(\d+)$/.exec(number);
  if (day) return `第 ${day[1]} 天 第 ${day[2]} 题`;
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
  // A stem's explicit final-form requirement still belongs to mathematical grading (e.g. reduced fractions).
  const formatRequired = input.type === "填空题" && /小数|分数|最简|化简|精确|保留|有效数字|科学计数|形式|格式|不得|必须|不能|只能|decimal|fraction|significant|round|nearest|standard form|scientific notation|without|must/i.test(input.stem ?? "");
  const simple = !formatRequired && isSimpleObjectiveAnswer(input.type, input.standardAnswer)
    && (input.type !== "填空题" || isSimpleObjectiveAnswer(input.type, input.studentAnswer));
  if (simple) {
    const reference = normalizeHomeworkAnswer(input.standardAnswer, input.type);
    const student = normalizeHomeworkAnswer(input.studentAnswer, input.type);
    return scored(reference === student ? "correct" : "incorrect", false, null);
  }
  const verdict = ["correct", "partial", "incorrect"].includes(input.modelVerdict) ? input.modelVerdict : "unreadable";
  return scored(verdict, verdict === "unreadable", input.modelScore);
}
