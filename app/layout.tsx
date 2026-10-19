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
// carries data-entering. The library releases the sand once its first cards have committed; "mp-entered" then
// tells its rails to unfold. Waiting is bounded so a failed read or hydration never strands the user behind the sand.
const entranceScript = `(() => {
  const params = new URLSearchParams(location.search);
  if (location.pathname !== "/library" || params.get("from") !== "intro" || params.has("view")) return;
  const optIn = document.createElement("style");
  optIn.textContent = "@view-transition{navigation:auto}";
  document.head.append(optIn);
  addEventListener("pagereveal", (event) => {
    const transition = event.viewTransition;
    if (!transition) return optIn.remove();
    const root = document.documentElement;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    const reveal = () => {
      clearTimeout(timeout);
      if (root.hasAttribute("data-entering")) root.dataset.entering = "";
    };
    const skip = () => transition.skipTransition();
    const onMotion = () => { if (motion.matches) skip(); };
    const cleanup = () => {
      clearTimeout(timeout);
      removeEventListener("mp-library-ready", reveal);
      removeEventListener("pagehide", skip);
      motion.removeEventListener("change", onMotion);
      optIn.remove();
      delete root.dataset.entering;
      dispatchEvent(new Event("mp-entered"));
    };
    root.dataset.entering = document.querySelector('.app-shell[aria-busy="false"]') ? "" : "loading";
    const timeout = setTimeout(reveal, 2500);
    addEventListener("mp-library-ready", reveal, { once: true });
    addEventListener("pagehide", skip, { once: true });
    motion.addEventListener("change", onMotion);
    transition.finished.then(cleanup, cleanup);
    if (motion.matches) skip();
  }, { once: true });
})();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{ __html: appearanceBootstrapScript + entranceScript }} /></head><body>{children}<DialogEscape /></body></html>;
}
