// Tools collected under the single “工具箱” entry. Adding a tool is one entry here plus its own page.
export type ToolboxTool = { key: string; href: string; name: string; summary: string; icon: "pen"; tags: string[] };

export const TOOLBOX_TOOLS: ToolboxTool[] = [
  {
    key: "answer-studio", href: "/tools/answer-studio", name: "手写转录", icon: "pen",
    summary: "把手写答案、讲义照片或 PDF 转成可编辑的 Word 解析，可选含图或纯文字版本。",
    tags: ["PDF", "图片", "导出 Word"],
  },
];
