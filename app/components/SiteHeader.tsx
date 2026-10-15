"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { AppearancePicker } from "./AppearancePicker";
import { ALEVEL_PAGE_COPY, type AlevelPageLocale } from "../../lib/alevel-page-locale.mjs";
import { logout } from "../../lib/api-client";
import type { AuthUser } from "../../lib/types";

// MathPilot wordmark: "Math" upright in the ink colour, "Pilot" italic in the theme accent. The letters are
// outlines of DM Serif Display (SIL OFL), so the brand looks the same on every computer without a web font.
export function BrandWordmark() {
  return <svg className="brand-word" viewBox="0 0 4237 716" role="img" aria-label="MathPilot"><path d="M0 701V691L20 684Q54 673 54 627V115Q54 95 50 83Q45 71 26 63L0 51V41H193L378 525L552 41H749V51L733 57Q714 64 707 76Q700 89 700 109V632Q700 652 705 663Q710 674 729 682L749 691V701H500V691L521 682Q540 674 545 663Q550 652 550 632V407L552 121L343 701H293L75 128L78 377V629Q78 651 84 664Q91 678 110 684L132 691V701ZM917 716Q859 716 820 683Q780 650 780 588Q780 541 828 502Q876 462 979 442Q995 439 1015 436Q1035 432 1057 428V349Q1057 281 1040 254Q1024 226 989 226Q965 226 951 242Q937 257 933 295L931 306Q929 349 910 369Q891 389 863 389Q837 389 820 373Q803 357 803 330Q803 289 832 261Q860 233 907 219Q954 205 1009 205Q1098 205 1146 248Q1195 292 1195 390V611Q1195 656 1237 656H1259L1268 664Q1249 688 1226 701Q1204 714 1163 714Q1119 714 1094 694Q1068 673 1060 639Q1030 671 998 694Q967 716 917 716ZM978 655Q998 655 1016 646Q1033 636 1057 616V448Q1047 450 1037 452Q1027 454 1014 456Q968 468 940 496Q913 525 913 573Q913 614 932 634Q951 655 978 655ZM1479 716Q1415 716 1380 684Q1344 652 1344 582V240H1275V230L1299 226Q1330 219 1352 206Q1375 193 1397 171L1479 80H1489L1486 220H1598V240H1485V600Q1485 635 1500 653Q1516 671 1540 671Q1561 671 1577 660Q1593 650 1609 632L1619 642Q1599 676 1564 696Q1529 716 1479 716ZM1653 701V691L1665 687Q1701 675 1701 637V103Q1701 82 1694 72Q1687 62 1667 57L1652 53V43L1828 0L1844 9L1840 150V275Q1875 246 1916 226Q1956 205 2005 205Q2070 205 2108 242Q2147 279 2147 356V638Q2147 658 2155 670Q2163 682 2183 688L2191 691V701H1957V691L1969 688Q2005 676 2005 637V323Q2005 283 1992 268Q1978 253 1944 253Q1922 253 1896 262Q1870 270 1843 291V639Q1843 678 1879 689L1887 691V701Z" /><path className="brand-word-accent" d="M2213 701 2215 691 2226 687Q2269 672 2277 629L2329 351Q2340 296 2350 238Q2360 181 2372 111Q2379 70 2340 55L2330 51L2332 41H2550Q2679 41 2738 90Q2796 140 2796 221Q2796 279 2762 330Q2729 380 2662 410Q2594 441 2492 441H2448Q2440 481 2432 530Q2423 578 2414 627Q2407 673 2450 688L2462 691L2460 701ZM2452 421H2489Q2565 421 2612 366Q2659 312 2659 216Q2659 141 2629 101Q2599 61 2543 61H2519Q2503 151 2486 241Q2469 331 2452 421ZM2986 149Q2958 149 2938 130Q2917 112 2917 81Q2917 46 2942 24Q2966 1 2997 1Q3027 1 3046 20Q3065 39 3065 69Q3065 103 3041 126Q3017 149 2986 149ZM2893 716Q2862 716 2842 700Q2822 684 2822 653Q2822 635 2826 610Q2830 585 2835 560L2882 335Q2891 294 2853 277L2837 269L2838 258L3026 204L3036 213L2958 575Q2954 593 2952 606Q2950 618 2950 630Q2950 652 2970 652Q2985 652 3000 642Q3015 633 3038 611L3047 620Q3022 657 2984 686Q2945 716 2893 716ZM3172 716Q3139 716 3120 699Q3100 682 3100 650Q3100 632 3104 606Q3108 581 3116 541L3173 265Q3181 227 3186 196Q3192 165 3199 126Q3206 86 3167 72L3150 66L3152 56L3348 0L3354 7L3231 587Q3228 602 3226 614Q3224 625 3224 633Q3224 655 3243 655Q3268 655 3316 610L3326 618Q3301 655 3263 686Q3225 716 3172 716ZM3559 716Q3507 716 3464 696Q3421 675 3396 634Q3371 592 3371 528Q3371 464 3392 406Q3414 348 3453 302Q3492 257 3544 231Q3596 205 3657 205Q3710 205 3752 226Q3793 246 3818 287Q3842 328 3842 392Q3842 455 3820 514Q3799 572 3760 618Q3722 663 3670 690Q3619 716 3559 716ZM3571 696Q3602 696 3628 668Q3653 639 3672 592Q3691 544 3701 486Q3711 429 3711 372Q3711 289 3694 257Q3677 225 3650 225Q3618 225 3591 253Q3564 281 3544 328Q3524 375 3513 432Q3502 489 3502 546Q3502 631 3522 664Q3542 696 3571 696ZM3990 716Q3959 716 3938 700Q3918 683 3918 651Q3918 631 3922 608Q3926 584 3931 557L4000 241H3917L3920 229L3956 225Q3984 222 4005 211Q4026 200 4045 180L4141 83H4156L4128 220H4237L4232 241H4123L4054 574Q4050 593 4048 606Q4046 620 4046 629Q4046 639 4052 645Q4058 651 4065 651Q4079 651 4095 640Q4111 628 4135 605L4147 615Q4122 652 4082 684Q4042 716 3990 716Z" /></svg>;
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
    <a className="brand" href="/" onClick={(event) => { if (onSelect) { event.preventDefault(); onSelect("library"); } }}><BrandWordmark /></a>
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
