import type { Metadata } from "next";
import { appearanceBootstrapScript } from "../lib/appearance";
import { DialogEscape } from "./components/DialogEscape";
import "katex/dist/katex.min.css";
import "./globals.css";
import "./math-typography.css";

export const metadata: Metadata = {
  title: "MathPilot",
  description: "数学教研工作台：共享题库、讲义编撰、学生档案与作业批改。",
  icons: { icon: [{ url: "/favicon.svg?v=infinity", type: "image/svg+xml" }], shortcut: "/favicon.svg?v=infinity" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: appearanceBootstrapScript }} /></head><body>{children}<DialogEscape /></body></html>;
}
