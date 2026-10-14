// Tools collected under the single “工具箱” entry. Adding a tool is one entry here plus its own page; cards open the tool in a new tab.
export type ToolboxTool = { key: string; href: string; name: string; summary: string; icon: "pen" | "share" | "check" | "page" | "spark"; tags: string[]; adminOnly?: boolean };

export const TOOLBOX_TOOLS: ToolboxTool[] = [
  {
    key: "homework", href: "/tools/homework", name: "作业批改", icon: "check",
    summary: "上传学生已完成的作业，自动批改；可选写入错题本、生成错题报告或计入定档。",
    tags: ["照片", "PDF", "自动批改"],
  },
  {
    key: "answer-studio", href: "/tools/answer-studio", name: "手写转录", icon: "pen",
    summary: "把手写答案、讲义照片或 PDF 转成可编辑的 Word 解析，可选含图或纯文字版本。",
    tags: ["PDF", "图片", "导出 Word"],
  },
  {
    key: "typeset", href: "/tools/typeset", name: "快速排版", icon: "page",
    summary: "上传 Word 练习，按固定的 LaTeX 练习模板排成 PDF：学生版、附答案或教师版，题间距和作答横线可调。",
    tags: ["Word", "LaTeX", "PDF"],
  },
  {
    key: "smart-paper", href: "/tools/smart-paper", name: "智能组卷", icon: "spark",
    summary: "说一句要出什么练习，按学生档案从题库挑题、按天排好，确认后进快速排版，每天单独起页。",
    tags: ["学生档案", "按天打卡", "快速排版"],
  },
  {
    key: "ai-settings", href: "/settings/ai", name: "AI 配置中心", icon: "spark", adminOnly: true,
    summary: "管理 AI 服务连接、模型目录和任务分配，查看连接诊断。",
    tags: ["服务连接", "模型", "任务分配"],
  },
  {
    key: "sharing", href: "/tools/sharing", name: "共享办公", icon: "share", adminOnly: true,
    summary: "在公司把知题共享给同事：一键开关、记住公司网络，管理邀请码和同事账号。",
    tags: ["局域网", "邀请码", "成员"],
  },
];
