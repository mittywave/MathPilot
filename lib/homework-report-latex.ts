import { latexInline, latexPlain } from "./handout-latex";
import { mainQuestionNumber } from "./homework-report.mjs";
import type { GradingItem, HomeworkSubmission, InternationalReport } from "./types";

// IGCSE / A Level 批改报告 → one self-contained TeX file, read by parents and students together.
// The visual language follows the confirmed Alevel report: navy headings, teal accents, a pale score banner.
export const HOMEWORK_REPORT_MAIN = "report.tex";

const PREAMBLE = String.raw`% 知题作业批改生成的批改报告。编译：tectonic report.tex，或 xelatex report.tex 两遍。
% 需要 ctex、amsmath、booktabs、tabularx、fancyhdr、lastpage；macOS 使用华文黑体，其他系统退回 Fandol 黑体。
\documentclass[UTF8,fontset=none,11pt,a4paper]{ctexart}
\IfFontExistsTF{STHeiti}{\setCJKmainfont{STHeiti}}{\setCJKmainfont{FandolHei-Regular.otf}[BoldFont=FandolHei-Bold.otf]}
\usepackage[margin=20mm,top=19mm,bottom=20mm]{geometry}
\usepackage{amsmath,amssymb,booktabs,tabularx,array,xcolor,fancyhdr,lastpage}
\usepackage[unicode,hidelinks]{hyperref}
\definecolor{ink}{HTML}{20374A}
\definecolor{accent}{HTML}{247B85}
\definecolor{muted}{HTML}{596773}
\definecolor{pale}{HTML}{EDF4F5}
\setlength{\parindent}{0pt}
\setlength{\parskip}{5pt}
\linespread{1.16}
\setlength{\headheight}{15pt}
\setlength{\emergencystretch}{2em}
\pagestyle{fancy}\fancyhf{}
\renewcommand{\headrulewidth}{0.3pt}
\ctexset{section={format=\Large\bfseries\color{ink},number={},beforeskip=10pt,afterskip=7pt}}
\newcommand{\topic}[2]{\par\vspace{7pt}{\large\bfseries\color{ink}#1}\hfill{\small\color{accent}#2}\par\vspace{3pt}}
\newcommand{\lbl}[1]{\textbf{\color{ink}#1}\quad}
\newcommand{\note}[1]{\par\smallskip{\small\color{muted}#1}\par}
\newcommand{\banner}[1]{\par\smallskip\colorbox{pale}{\parbox{\dimexpr\linewidth-2\fboxsep}{\vspace{4pt}\color{ink}#1\vspace{4pt}}}\par}`;

function marks(value: number) { return Number.isInteger(value) ? String(value) : value.toFixed(1); }
function date(value: number | null | undefined) {
  if (!value) return "未记录";
  const day = new Date(value);
  return `${day.getFullYear()}年${day.getMonth() + 1}月${day.getDate()}日`;
}
// Table cells cannot hold display math.
function cell(value: string) { return latexInline(value.replace(/\$\$/g, "$")); }
function paragraph(value: string) { return value.split(/\n+/).map((line) => latexInline(line)).filter(Boolean).join("\n\n"); }
function numbers(values: string[]) { return values.map((value) => latexPlain(value)).join("、"); }

type Group = { items: GradingItem[]; score: number; max: number; pending: boolean };
function group(items: GradingItem[]): Group {
  const scored = items.filter((item) => item.score != null);
  return { items, score: scored.reduce((sum, item) => sum + Number(item.score), 0), max: items.reduce((sum, item) => sum + Number(item.maxScore ?? 0), 0), pending: scored.length < items.length };
}
function groupMarks({ score, max, pending }: Group) { return pending ? `${marks(score)}/${marks(max)}（待核）` : `${marks(score)}/${marks(max)}`; }

function scoreTable(items: GradingItem[], report: InternationalReport) {
  const order = [...new Set(items.map((item) => mainQuestionNumber(item.questionNumber)))];
  const rows = order.map((number) => {
    const part = group(items.filter((item) => mainQuestionNumber(item.questionNumber) === number));
    const topic = report.topics.find((row) => row.question === number);
    return `${latexPlain(number)} & ${cell(topic?.topic || "—")} & ${groupMarks(part)} & ${cell(topic?.note || "")}\\\\`;
  });
  const total = group(items);
  return String.raw`\renewcommand{\arraystretch}{1.3}
\begin{tabularx}{\linewidth}{@{}c p{30mm} c X@{}}
\toprule
\textbf{题号} & \textbf{考查内容} & \textbf{得分} & \textbf{反馈要点}\\
\midrule
${rows.join("\n")}
\midrule
\multicolumn{2}{@{}l}{\textbf{总计}} & \textbf{${groupMarks(total)}} & \textbf{失分${marks(total.max - total.score)}分${total.pending ? "（不含待核小问）" : ""}}\\
\bottomrule
\end{tabularx}`;
}

function lossBlock(loss: InternationalReport["losses"][number], items: GradingItem[]) {
  const part = group(items.filter((item) => loss.questionNumbers.includes(item.questionNumber)));
  const lines = [String.raw`\topic{第${numbers(loss.questionNumbers)}题：${latexInline(loss.title)}}{${marks(part.score)}/${marks(part.max)}分 · 失${marks(part.max - part.score)}分}`];
  for (const [label, value] of [["失分事实", loss.fact], ["知识与能力", loss.knowledge], ["正确思路", loss.method], ["订正动作", loss.action]] as const) {
    if (value) lines.push(String.raw`\lbl{${label}}${paragraph(value)}`);
  }
  return lines.join("\n\n");
}

function lossSections(report: InternationalReport, items: GradingItem[]) {
  const sections = [...new Set(report.losses.map((loss) => loss.section || "失分分析"))];
  return sections.map((section, index) => [String.raw`\section{${String(index + 1).padStart(2, "0")}\quad ${latexPlain(section)}}`,
    ...report.losses.filter((loss) => (loss.section || "失分分析") === section).map((loss) => lossBlock(loss, items))].join("\n\n")).join("\n\n");
}

function practiceTable(report: InternationalReport) {
  const rows = report.practice.map((row, index) => `${index + 1}${row.focus ? ` · ${latexPlain(row.focus)}` : ""} & ${cell(row.action)} & ${cell(row.standard)}\\\\`);
  return String.raw`\section{下一步练习建议}
\renewcommand{\arraystretch}{1.35}
\begin{tabularx}{\linewidth}{@{}p{32mm}XX@{}}
\toprule
\textbf{优先级} & \textbf{练习动作} & \textbf{完成标准}\\
\midrule
${rows.join("\n")}
\bottomrule
\end{tabularx}`;
}

export function buildHomeworkReportLatex(submission: HomeworkSubmission) {
  const report = submission.report?.details;
  if (!report) throw new Error("本次作业还没有批改报告");
  const items = submission.gradingItems;
  const total = group(items);
  const pendingNumbers = items.filter((item) => item.score == null).map((item) => item.questionNumber);
  const name = latexPlain(submission.studentName);
  const title = latexPlain(submission.assignmentTitle);
  const percentage = submission.gradingSummary?.marks?.percentage;
  const banner = String.raw`\banner{\begin{tabularx}{\linewidth}{@{}XXX@{}}
\small ${total.pending ? "已确认得分" : "本次得分"} & \small 得分率 & \small 评分范围\\[3pt]
{\LARGE\bfseries ${marks(total.score)} / ${marks(total.max)}} & {\LARGE\bfseries ${percentage == null ? "待定" : `${percentage}\\%`}} & {\large ${items.length}个小问 · ${submission.pages.length}页作答}
\end{tabularx}}`;
  const body = [
    PREAMBLE,
    String.raw`\hypersetup{pdftitle={${name} ${title} 批改报告},pdfauthor={学习反馈}}`,
    String.raw`\fancyhead[L]{\small\color{muted}${name}\quad / \quad ${title}}`,
    String.raw`\fancyhead[R]{\small\color{muted}学习反馈报告}`,
    String.raw`\fancyfoot[L]{\footnotesize\color{muted}学习反馈 · 家长与学生共读}`,
    String.raw`\fancyfoot[R]{\footnotesize\color{muted}\thepage\ / \pageref{LastPage}}`,
    String.raw`\begin{document}`,
    String.raw`{\small\color{accent}\bfseries MATHEMATICS \quad / \quad 学习反馈报告}
\vspace{7pt}

{\Huge\bfseries\color{ink}${name}}\\[4pt]
{\LARGE\color{ink}${title} 批改报告}`,
    banner,
    String.raw`{\small\color{muted}提交日期：${date(submission.submittedAt)}\quad 批改日期：${date(submission.report?.updatedAt)}}`,
    ...(pendingNumbers.length ? [String.raw`\note{第${numbers(pendingNumbers)}题待补图或核实，暂未计分；满分仍包含这些小问，得分率待全部定分后给出。}`] : []),
    String.raw`\section{本次学习表现}`,
    paragraph(report.overview),
    ...(report.priorities.length ? [String.raw`优先改进：\textbf{${report.priorities.map((item) => latexPlain(item)).join("、")}}。`] : []),
    String.raw`\section{分题成绩}`,
    scoreTable(items, report),
    ...(report.losses.length ? [String.raw`\newpage`, lossSections(report, items)] : [String.raw`\section{失分分析}`, "本次各小问均得满分，没有扣分项。"]),
    ...(report.practice.length ? [practiceTable(report)] : []),
    ...(report.checklist ? [String.raw`\banner{${latexInline(report.checklist)}}`] : []),
    String.raw`\note{以上为订正建议。未记录用时或独立完成情况，本报告不对答题速度或独立掌握程度作判断，成绩也不直接换算正式考试等级。}`,
    String.raw`\end{document}`,
  ];
  return `${body.join("\n\n")}\n`;
}
