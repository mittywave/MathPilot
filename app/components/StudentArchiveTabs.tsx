/* eslint-disable @next/next/no-html-link-for-pages -- These client-only pages use full navigation until vinext supports next/link prefetch. */

export function StudentArchiveTabs({ active }: { active: "wrong-book" | "homework" }) {
  return <nav className="student-archive-tabs" aria-label="学生档案功能">
    <a href="/?view=wrong-book" className={active === "wrong-book" ? "active" : ""} aria-current={active === "wrong-book" ? "page" : undefined}>错题本</a>
    <a href="/homework" className={active === "homework" ? "active" : ""} aria-current={active === "homework" ? "page" : undefined}>作业批改</a>
  </nav>;
}
