import type { Metadata } from "next";
import { appearanceBootstrapScript } from "../lib/appearance";
import { DialogEscape } from "./components/DialogEscape";
import "katex/dist/katex.min.css";
import "./globals.css";
import "./math-typography.css";

export const metadata: Metadata = {
  title: "Mitty 的宝藏题库",
  description: "包含深圳中考、深圳自主招生考试和深国交入学考三个数学专门模块。",
  icons: { icon: [{ url: "/favicon.svg?v=mitty", type: "image/svg+xml" }], shortcut: "/favicon.svg?v=mitty" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: appearanceBootstrapScript }} /></head><body>{children}<DialogEscape /></body></html>;
}
