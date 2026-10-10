// Tools collected under the single “工具箱” entry. Adding a tool is one entry here plus its own page; cards open the tool in a new tab.
export type ToolboxTool = { key: string; href: string; name: string; summary: string; icon: "pen" | "book" | "share" | "check" | "graph"; tags: string[]; adminOnly?: boolean };

export const TOOLBOX_TOOLS: ToolboxTool[] = [
  {
    key: "handouts", href: "/tools/handouts", name: "讲义编撰", icon: "book",
    summary: "从题库选题或录入外部题目，编排讲义、作业和小测，题目可随时替换。",
    tags: ["选题", "录入", "导出 Word"],
  },
  {
    key: "homework", href: "/tools/homework", name: "作业批改", icon: "check",
    summary: "上传学生已完成的作业，自动批改；可选写入错题本、生成错题报告或整合到学生画像。",
    tags: ["照片", "PDF", "自动批改"],
  },
  {
    key: "answer-studio", href: "/tools/answer-studio", name: "手写转录", icon: "pen",
    summary: "把手写答案、讲义照片或 PDF 转成可编辑的 Word 解析，可选含图或纯文字版本。",
    tags: ["PDF", "图片", "导出 Word"],
  },
  {
    key: "knowledge-graph", href: "/knowledge-graph", name: "知识图谱", icon: "graph",
    summary: "在点云里浏览初中数学知识点的前置与后续，叠加学生证据看薄弱环节；老师可编辑并发布。",
    tags: ["点云", "前置链", "学情"],
  },
  {
    key: "sharing", href: "/tools/sharing", name: "共享办公", icon: "share", adminOnly: true,
    summary: "在公司把知题共享给同事：一键开关、记住公司网络，管理邀请码和同事账号。",
    tags: ["局域网", "邀请码", "成员"],
  },
];
