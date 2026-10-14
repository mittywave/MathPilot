import type { ReactNode } from "react";
import { AppearancePicker } from "./AppearancePicker";
import { ALEVEL_PAGE_COPY, type AlevelPageLocale } from "../../lib/alevel-page-locale.mjs";
import type { AuthUser } from "../../lib/types";

export type SiteSection = "library" | "basket" | "handouts" | "students" | "tools";

// The one top bar shared by the home page and top-level pages such as the toolbox. Its entries read
// 题库 · 组卷篮 · 讲义编撰 · 知识图谱 · 学生档案 · 工具箱; the smaller tools sit inside the toolbox.
// On the home page 题库, 组卷篮 and 学生档案 switch views in place (onSelect); elsewhere they link back to "/".
export function SiteHeader({ active, user, loading = false, locale = "zh", basketCount = 0, onSelect, actions }: {
  active: SiteSection | null;
  user: AuthUser | null;
  loading?: boolean;
  locale?: AlevelPageLocale;
  basketCount?: number;
  onSelect?: (section: "library" | "basket" | "students") => void;
  actions?: ReactNode;
}) {
  const copy = ALEVEL_PAGE_COPY[locale];
  const entry = (section: "library" | "basket" | "students", href: string, label: ReactNode) => {
    const className = `nav-item ${active === section ? "active" : ""}`;
    return onSelect ? <button className={className} onClick={() => onSelect(section)}>{label}</button> : <a className={className} href={href}>{label}</a>;
  };
  const link = (href: string, label: string, current = false) => <a className={`nav-item ${current ? "active" : ""}`} href={href} aria-current={current ? "page" : undefined}>{label}</a>;
  return <header className="topbar">
    {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- Native navigation keeps beforeunload protection; the home page switches in place. */}
    <a className="brand" href="/" onClick={(event) => { if (onSelect) { event.preventDefault(); onSelect("library"); } }}><span className="brand-mark">题</span><strong>MathPilot</strong></a>
    <nav className="library-entries" aria-label="题库入口">
      {entry("library", "/", copy.navPublic)}
      {user && <>{entry("basket", "/?view=selected", <>{copy.navBasket}{basketCount ? <i>{basketCount}</i> : null}</>)}{link("/tools/handouts", copy.navHandouts, active === "handouts")}{link("/knowledge-graph", copy.navKnowledge)}</>}
      {entry("students", "/?view=wrong-book", copy.navStudents)}
      {user && link("/tools", copy.navTools, active === "tools")}
    </nav>
    <div className="account-area"><AppearancePicker label={copy.appearance} locale={locale} />{loading ? <span className="guest-badge">{copy.connecting}</span> : <>{user && <span className="user-chip"><b>{user.local ? copy.localAdmin : user.role === "admin" ? copy.admin : copy.member}</b>{user.local ? copy.noLogin : user.email}</span>}{actions}</>}</div>
  </header>;
}
