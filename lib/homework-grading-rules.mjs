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

export function finalizeHomeworkVerdict(input) {
  const confidence = Math.max(0, Math.min(1, Number(input.confidence) || 0));
  if (input.answerState === "blank") return { verdict: "incorrect", requiresReview: false, confidence };
  if (input.modelVerdict === "unreadable" || input.modelVerdict === "review_required" || !normalizeHomeworkAnswer(input.studentAnswer)) {
    return { verdict: input.modelVerdict === "review_required" ? "review_required" : "unreadable", requiresReview: true, confidence };
  }
  const simple = isSimpleObjectiveAnswer(input.type, input.standardAnswer);
  if (simple) {
    const reference = normalizeHomeworkAnswer(input.standardAnswer);
    const student = normalizeHomeworkAnswer(input.studentAnswer);
    return { verdict: reference === student ? "correct" : "incorrect", requiresReview: false, confidence };
  }
  const verdict = ["correct", "partial", "incorrect"].includes(input.modelVerdict) ? input.modelVerdict : "unreadable";
  return { verdict, requiresReview: verdict === "unreadable", confidence };
}
