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

// Arriving from the product page's 进入工作台 (?from=intro, the 题库's entrance marker), the page joins the view
// transition the product page opted into, so the workbench fades in where the ∞'s sand lay. While that runs <html>
// carries data-entering, and "mp-entered" says when it is over (the 题库 holds its entrance till then).
const entranceScript = `(() => {
  if (new URLSearchParams(location.search).get("from") !== "intro") return;
  const optIn = document.createElement("style");
  optIn.textContent = "@view-transition{navigation:auto}";
  document.head.append(optIn);
  addEventListener("pagereveal", (event) => {
    const transition = event.viewTransition;
    if (!transition) return optIn.remove();
    const root = document.documentElement;
    root.dataset.entering = "";
    transition.finished.finally(() => {
      optIn.remove();
      delete root.dataset.entering;
      dispatchEvent(new Event("mp-entered"));
    });
  }, { once: true });
})();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: appearanceBootstrapScript + entranceScript }} /></head><body>{children}<DialogEscape /></body></html>;
}
