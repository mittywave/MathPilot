import type { ReactNode } from "react";
import { AppearancePicker } from "./AppearancePicker";
import { ALEVEL_PAGE_COPY, type AlevelPageLocale } from "../../lib/alevel-page-locale.mjs";
import type { AuthUser } from "../../lib/types";

export type SiteSection = "library" | "basket" | "students" | "tools";

// The one top bar shared by the home page and top-level pages such as the toolbox.
// On the home page the first three entries switch views in place (onSelect); elsewhere they link back to "/".
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
    return <header className="topbar">
    <div className="brand"><span className="brand-mark">题</span><div><strong>Mitty</strong><span>{copy.brandSubtitle}</span></div></div>
    <nav className="library-entries" aria-label="题库入口">
      {entry("library", "/", copy.navPublic)}
      {user && entry("basket", "/?view=selected", <>{copy.navBasket}{basketCount ? <i>{basketCount}</i> : null}</>)}
      {entry("students", "/?view=wrong-book", copy.navStudents)}
      {user && <a className={`nav-item ${active === "tools" ? "active" : ""}`} href="/tools" aria-current={active === "tools" ? "page" : undefined}>{copy.navTools}</a>}
    </nav>
    <div className="account-area"><AppearancePicker label={copy.appearance} locale={locale} />{loading ? <span className="guest-badge">{copy.connecting}</span> : <>{user && <span className="user-chip"><b>{user.local ? copy.localAdmin : user.role === "admin" ? copy.admin : copy.member}</b>{user.local ? copy.noLogin : user.email}</span>}{actions}</>}</div>
  </header>;
}
