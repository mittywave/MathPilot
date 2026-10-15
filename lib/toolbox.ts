// Tools collected under the single “工具箱” entry. Adding a tool is one entry here plus its own page; cards open the tool in the current tab.
export type ToolboxTool = { key: string; href: string; name: string; summary: string; icon: "pen" | "share" | "check" | "page" | "spark"; adminOnly?: boolean };

export const TOOLBOX_TOOLS: ToolboxTool[] = [
  {
    key: "homework", href: "/tools/homework", name: "作业批改", icon: "check",
    summary: "上传学生拍好的作业照片或 PDF，自动批改，可写入错题本和定档。",
  },
  {
    key: "answer-studio", href: "/tools/answer-studio", name: "手写转录", icon: "pen",
    summary: "把手写答案、讲义照片或 PDF 转成可编辑的 Word 解析。",
  },
  {
    key: "typeset", href: "/tools/typeset", name: "快速排版", icon: "page",
    summary: "把 Word 练习排成 PDF：学生版、附答案或教师版。",
  },
  {
    key: "smart-paper", href: "/tools/smart-paper", name: "智能组卷", icon: "spark",
    summary: "说一句要什么练习，按学生档案挑题、按天排好。",
  },
  {
    key: "ai-settings", href: "/settings/ai", name: "AI 配置", icon: "spark", adminOnly: true,
    summary: "管理 AI 服务连接、模型目录和任务分配。",
  },
  {
    key: "sharing", href: "/tools/sharing", name: "共享办公", icon: "share", adminOnly: true,
    summary: "在公司把 MathPilot 共享给同事，管理邀请码和账号。",
  },
];
