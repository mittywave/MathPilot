import { homeworkQuestionLabel } from "./homework-grading-rules.mjs";
function clean(value, limit = 500) { return typeof value === "string" ? value.trim().slice(0, limit) : ""; }
function questions(value) { return Array.isArray(value) ? [...new Set(value.map((item) => clean(String(item), 40)).filter(Boolean))].slice(0, 12) : []; }

export function normalizeSubmissionReport(value, now = Date.now()) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const points = (list, gap = false) => (Array.isArray(list) ? list : []).map((item) => {
    const row = item && typeof item === "object" && !Array.isArray(item) ? item : {};
    return { title: clean(row.title, 120), detail: clean(row.detail, 600), questionNumbers: questions(row.question_numbers ?? row.questionNumbers),
      capabilityKey: gap ? clean(row.capability_key ?? row.capabilityKey, 100) || null : null };
  }).filter((item) => item.title).slice(0, 3);
  const actions = (Array.isArray(raw.actions) ? raw.actions : []).map((item) => clean(item, 300)).filter(Boolean).slice(0, 3);
  return { details: raw.details && typeof raw.details === "object" && Object.keys(raw.details).length ? normalizeInternationalReport(raw.details) : null,
    overallSummary: clean(raw.overall_summary ?? raw.overallSummary, 1_000), studentMessage: clean(raw.student_message ?? raw.studentMessage, 700),
    strengths: points(raw.strengths), gaps: points(raw.gaps, true), actions, warnings: (Array.isArray(raw.warnings) ? raw.warnings : []).map((item) => clean(item, 240)).filter(Boolean).slice(0, 8),
    generatedAt: Number(raw.generatedAt) || now, updatedAt: now };
}

const ACTIONS = [
  [/计算|符号|运算/, "每道题完成后用逆运算或代入法检查一次，先消除符号和计算失误。"],
  [/审题|条件/, "圈出题目条件和最终问题，动笔前先写出已知量与目标量。"],
  [/概念/, "回到对应定义和适用条件，用一道基础题确认概念边界。"],
  [/步骤|表达|漏答/, "把关键推导分行写完整，并在最后单独写出结论。"],
  [/推理|证明/, "先写出每一步使用的依据，再检查前后结论是否连续。"],
];

export function buildFallbackSubmissionReport(items, now = Date.now()) {
  const rows = Array.isArray(items) ? items : [];
  const correct = rows.filter((item) => item.verdict === "correct");
  const gaps = rows.filter((item) => item.verdict === "partial" || item.verdict === "incorrect");
  const strengths = correct.slice(0, 3).map((item) => ({ title: `${homeworkQuestionLabel(clean(item.questionNumber, 40))}完成较好`, detail: clean(item.feedback, 600) || "思路和结果与标准答案一致。", questionNumbers: [clean(item.questionNumber, 40)], capabilityKey: null }));
  const gapPoints = gaps.slice(0, 3).map((item) => ({ title: clean(item.errorType, 120) || `${homeworkQuestionLabel(clean(item.questionNumber, 40))}需要巩固`, detail: clean(item.feedback, 600) || "请对照标准步骤定位差异。",
    questionNumbers: [clean(item.questionNumber, 40)], capabilityKey: Array.isArray(item.capabilityKeys) ? clean(item.capabilityKeys[0], 100) || null : null }));
  const actionSet = [];
  for (const item of gaps) {
    const error = clean(item.errorType, 120); const action = ACTIONS.find(([pattern]) => pattern.test(error))?.[1] ?? "重做本次错题，并用一句话说明原来的错误原因。";
    if (!actionSet.includes(action)) actionSet.push(action);
  }
  const overall = `本次共完成 ${rows.length} 题，${correct.length} 题表现稳定，${gaps.length} 题需要继续巩固。`;
  return { overallSummary: overall, studentMessage: gaps.length ? "先解决最优先的一个问题，再完成对应错题重做。" : "本次整体表现稳定，继续保持清晰完整的解题步骤。",
    strengths, gaps: gapPoints, actions: actionSet.slice(0, 3), warnings: ["AI 整份总结暂不可用，当前建议由逐题结果自动汇总。"], generatedAt: now, updatedAt: now };
}

// IGCSE / A Level: sub-parts such as 3(b)(ii) belong to printed question 3; a second paper keeps its page prefix.
export function mainQuestionNumber(number) { return clean(String(number ?? ""), 80).replace(/\s*\(.*$/, "") || clean(String(number ?? ""), 80); }

function rows(value, limit) { return (Array.isArray(value) ? value : []).filter((item) => item && typeof item === "object" && !Array.isArray(item)).slice(0, limit); }

export function normalizeInternationalReport(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    overview: clean(raw.overview, 1_500),
    priorities: (Array.isArray(raw.priorities) ? raw.priorities : []).map((item) => clean(item, 40)).filter(Boolean).slice(0, 3),
    topics: rows(raw.topics, 60).map((row) => ({ question: clean(String(row.question ?? ""), 40), topic: clean(row.topic, 40), note: clean(row.note, 120) })).filter((row) => row.question),
    losses: rows(raw.losses, 60).map((row) => ({ section: clean(row.section, 40), questionNumbers: questions(row.question_numbers ?? row.questionNumbers), title: clean(row.title, 120),
      fact: clean(row.fact, 1_500), knowledge: clean(row.knowledge, 1_000), method: clean(row.method, 3_000), action: clean(row.action, 800) })).filter((row) => row.title && row.questionNumbers.length),
    practice: rows(raw.practice, 4).map((row) => ({ focus: clean(row.focus, 30), action: clean(row.action, 400), standard: clean(row.standard, 400) })).filter((row) => row.action),
    checklist: clean(raw.checklist, 300),
  };
}

/** Every lost mark appears in the report: a sub-part the model left out is added from its own grading. */
export function completeInternationalReport(report, items) {
  const covered = new Set(report.losses.flatMap((loss) => loss.questionNumbers));
  const missing = (Array.isArray(items) ? items : []).filter((item) => item.score != null && item.maxScore != null && item.score < item.maxScore && !covered.has(item.questionNumber));
  const losses = [...report.losses, ...missing.map((item) => ({ section: "其他失分", questionNumbers: [item.questionNumber], title: clean(item.errorType, 40) || "本小问需要订正",
    fact: clean(item.feedback, 1_500) || (item.verdict === "unreadable" ? "作答看不清，按 0 分计。" : "本小问未得满分。"), knowledge: item.verdict === "unreadable" ? "无法从看不清的作答判断掌握情况。" : "",
    method: clean(item.standardAnswer, 1_000), action: item.verdict === "unreadable" ? "补交清晰照片，或独立重做本小问。" : "对照正确思路独立重做本小问。" }))];
  const topicNumbers = new Set(report.topics.map((topic) => topic.question));
  const topics = [...report.topics, ...[...new Set((items ?? []).map((item) => mainQuestionNumber(item.questionNumber)))].filter((number) => !topicNumbers.has(number)).map((question) => ({ question, topic: "", note: "" }))];
  return { ...report, losses, topics };
}

export function buildFallbackInternationalReport(items) {
  const gaps = (Array.isArray(items) ? items : []).filter((item) => item.score != null && item.maxScore != null && item.score < item.maxScore);
  const actions = [];
  for (const item of gaps) { const action = ACTIONS.find(([pattern]) => pattern.test(clean(item.errorType, 120)))?.[1]; if (action && !actions.includes(action)) actions.push(action); }
  return completeInternationalReport({
    overview: gaps.length ? `本次共有 ${gaps.length} 个小问未得满分，失分分析见下文，先按优先级完成订正。` : "本次各小问均得满分，继续保持完整的书写和检查。",
    priorities: [], topics: [], losses: [], checklist: "每题结束前检查：范围是否检查？条件是否用完？问题是否答全？",
    practice: (actions.length ? actions : gaps.length ? ["重做本次失分小问，并用一句话写出原来的失分原因。"] : []).slice(0, 3).map((action) => ({ focus: "订正", action, standard: "独立重做后与正确思路逐步一致。" })),
  }, items);
}
