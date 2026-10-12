// Tools collected under the single “工具箱” entry. Adding a tool is one entry here plus its own page; cards open the tool in a new tab.
export type ToolboxTool = { key: string; href: string; name: string; summary: string; icon: "pen" | "share" | "check" | "page"; tags: string[]; adminOnly?: boolean };

export const TOOLBOX_TOOLS: ToolboxTool[] = [
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
    key: "typeset", href: "/tools/typeset", name: "快速排版", icon: "page",
    summary: "上传 Word 练习，按固定的 LaTeX 练习模板排成 PDF：学生版、附答案或教师版，也可下载 TeX 源码。",
    tags: ["Word", "LaTeX", "PDF"],
  },
  {
    key: "sharing", href: "/tools/sharing", name: "共享办公", icon: "share", adminOnly: true,
    summary: "在公司把知题共享给同事：一键开关、记住公司网络，管理邀请码和同事账号。",
    tags: ["局域网", "邀请码", "成员"],
  },
];
