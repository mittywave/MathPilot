"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { AppearancePicker } from "./AppearancePicker";
import { ALEVEL_PAGE_COPY, type AlevelPageLocale } from "../../lib/alevel-page-locale.mjs";
import { logout } from "../../lib/api-client";
import type { AuthUser } from "../../lib/types";

// MathPilot mark: a radical sign whose bar runs out to a waypoint — math, steered to its destination.
export function BrandGlyph() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.6 13.1 6.7 11.8 10.2 18.6 14.7 5.6H18.4" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" /><circle cx="20.6" cy="5.6" r="1.75" fill="currentColor" /></svg>;
}

export type SiteSection = "library" | "basket" | "handouts" | "students" | "tools";

// The one top bar shared by the home page and top-level pages such as the toolbox. Its entries read
// 题库 · 组卷篮 · 讲义编撰 · 知识图谱 · 学生档案 · 工具箱; the smaller tools sit inside the toolbox.
// On the home page 题库, 组卷篮 and 学生档案 switch views in place (onSelect); elsewhere they link back to "/".
export function SiteHeader({ active, user, loading = false, locale = "zh", basketCount = 0, onSelect, actions, trail, trailActions, title, onSignOut }: {
  active: SiteSection | null;
  user: AuthUser | null;
  loading?: boolean;
  locale?: AlevelPageLocale;
  basketCount?: number;
  onSelect?: (section: "library" | "basket" | "students") => void;
  actions?: ReactNode;
  trail?: Array<{ label: string; href?: string }>;
  trailActions?: ReactNode;
  title?: string;
  onSignOut?: (exit: () => Promise<void>) => void | Promise<void>;
}) {
  const copy = ALEVEL_PAGE_COPY[locale];
  const navigation = useRef<HTMLElement>(null);
  const signOutPhase = useRef<"idle" | "callback" | "logout">("idle");
  const [signOutStatus, setSignOutStatus] = useState<"idle" | "busy" | "error">("idle");
  const sectionTitle = active ? { library: copy.navPublic, basket: copy.navBasket, handouts: copy.navHandouts, students: copy.navStudents, tools: copy.navTools }[active] : copy.navPublic;
  const trailTitle = trail?.length ? [...new Set([trail[trail.length - 1].label, trail[0].label])].join(" · ") : "";
  const browserTitle = `${title?.trim() || trailTitle || sectionTitle} · MathPilot`;
  const accountLabel = user?.local ? copy.localAdmin : user?.email ?? copy.guestBrowse;

  useEffect(() => { document.title = browserTitle; }, [browserTitle]);
  useEffect(() => {
    navigation.current?.querySelector<HTMLElement>(".active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, basketCount, locale, signOutStatus, user?.id]);

  // The continuation may run after a page's discard confirmation, or immediately on a clean page.
  async function exit() {
    if (signOutPhase.current === "logout") return;
    signOutPhase.current = "logout";
    setSignOutStatus("busy");
    try { await logout(); window.location.assign("/"); setSignOutStatus("idle"); }
    catch { setSignOutStatus("error"); }
    finally { signOutPhase.current = "idle"; }
  }
  async function requestSignOut() {
    if (signOutPhase.current !== "idle") return;
    if (!onSignOut) { await exit(); return; }
    signOutPhase.current = "callback";
    setSignOutStatus("busy");
    try { await onSignOut(exit); }
    catch { setSignOutStatus("error"); }
    finally {
      if (signOutPhase.current === "callback") {
        signOutPhase.current = "idle";
        setSignOutStatus((status) => status === "busy" ? "idle" : status);
      }
    }
  }
  const entry = (section: "library" | "basket" | "students", href: string, label: ReactNode) => {
    const className = `nav-item ${active === section ? "active" : ""}`;
    return onSelect ? <button className={className} aria-current={active === section ? "page" : undefined} onClick={() => onSelect(section)}>{label}</button> : <a className={className} href={href} aria-current={active === section ? "page" : undefined}>{label}</a>;
  };
  const link = (href: string, label: string, current = false) => <a className={`nav-item ${current ? "active" : ""}`} href={href} aria-current={current ? "page" : undefined}>{label}</a>;
  return <><header className="topbar">
    {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- Native navigation keeps beforeunload protection; the home page switches in place. */}
    <a className="brand" href="/" onClick={(event) => { if (onSelect) { event.preventDefault(); onSelect("library"); } }}><span className="brand-mark"><BrandGlyph /></span><strong>MathPilot</strong></a>
    <nav ref={navigation} className="library-entries" aria-label="题库入口">
      {entry("library", "/", copy.navPublic)}
      {user && <>{entry("basket", "/?view=selected", <>{copy.navBasket}{basketCount ? <i>{basketCount}</i> : null}</>)}{link("/tools/handouts", copy.navHandouts, active === "handouts")}{link("/knowledge-graph", copy.navKnowledge)}</>}
      {entry("students", "/?view=wrong-book", copy.navStudents)}
      {user && link("/tools", copy.navTools, active === "tools")}
    </nav>
    <div className="account-area">
      {!loading && actions && <div className="header-actions">{actions}</div>}
      <AppearancePicker label={copy.appearance} locale={locale} />
      {loading ? <span className="guest-badge">{copy.connecting}</span> : user ? <span className="user-chip" title={accountLabel}><i aria-hidden="true">{user.local ? "管" : user.email.charAt(0).toUpperCase()}</i><span>{accountLabel}</span></span> : <span className="guest-badge">{copy.guestBrowse}</span>}
      {!loading && user && !user.local && <button type="button" className="account-button" disabled={signOutStatus === "busy"} aria-busy={signOutStatus === "busy"}
        title={signOutStatus === "error" ? copy.signOutFailed : copy.signOut} onClick={() => void requestSignOut()}>{signOutStatus === "error" ? copy.signOutFailed : copy.signOut}</button>}
    </div>
  </header>{!!trail?.length && <div className="site-trail"><nav aria-label={locale === "en" ? "Breadcrumb" : "面包屑"}><ol>{trail.map((item, index) => <li key={`${index}-${item.label}`}>
    {index < trail.length - 1 && item.href ? <a href={item.href} title={item.label}>{item.label}</a> : <span aria-current={index === trail.length - 1 ? "page" : undefined} title={item.label}>{item.label}</span>}
  </li>)}</ol></nav>{trailActions && <div>{trailActions}</div>}</div>}</>;
}
