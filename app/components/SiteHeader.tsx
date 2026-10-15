"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { AppearancePicker } from "./AppearancePicker";
import { ALEVEL_PAGE_COPY, type AlevelPageLocale } from "../../lib/alevel-page-locale.mjs";
import { logout } from "../../lib/api-client";
import { homeworkApi } from "../../lib/homework-api-client";
import type { AuthUser } from "../../lib/types";

// MathPilot wordmark, the "01 editorial" design: "Math" upright in the ink colour, "Pilot" italic in a soft accent,
// a flight-path arrow beneath. The letters are EB Garamond SemiBold (SIL OFL) outlines placed exactly as in the
// design file, plus a hairline stroke for the weight the design shows as live text; outlines keep the brand the
// same on every computer without a web font.
export function BrandWordmark() {
  return <svg className="brand-word" viewBox="14 102 958 251" role="img" aria-label="MathPilot" fill="currentColor" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
    <g strokeWidth="3.6"><path d="M23 273Q20 273 18 272Q17 271 17 270Q17 268 19 267Q21 266 24 266Q29 264 33 259Q37 255 38 247Q40 233 42 216Q44 199 45 181Q47 164 48 149Q48 147 48 145Q48 143 48 141Q47 138 46 135Q45 133 43 131Q39 129 36 127Q32 126 28 125Q25 125 24 123Q22 122 22 120Q22 118 24 118Q26 117 29 117Q32 117 37 117Q42 118 48 118Q54 118 60 118Q66 119 71 119Q73 119 74 120Q75 121 76 123Q77 127 79 131Q80 136 82 140L117 227Q118 228 119 228Q120 228 121 227L159 143Q160 136 161 131Q163 126 163 122Q164 119 167 119H176Q185 119 195 118Q205 117 210 117Q212 117 214 118Q216 118 216 120Q216 122 214 123Q213 124 210 125Q208 126 206 127Q203 128 201 129Q196 131 194 134Q191 137 192 143Q192 160 193 173Q193 187 194 198Q195 210 195 222Q196 234 197 249Q198 256 202 259Q207 263 214 265Q217 266 219 267Q221 268 221 270Q221 271 219 272Q218 273 215 273Q210 273 204 273Q198 272 192 272Q187 272 182 272Q177 272 172 272Q167 272 162 273Q157 273 151 273Q149 273 147 272Q145 271 145 270Q145 268 147 267Q149 266 152 265Q160 264 163 260Q166 257 166 249Q165 234 165 220Q165 205 164 192Q163 178 163 164Q163 162 162 162Q161 162 160 164L112 272Q111 275 109 274Q107 274 106 272Q95 245 83 218Q71 191 60 164Q59 162 58 162Q56 163 56 165Q55 178 54 192Q53 206 53 220Q53 234 53 248Q53 254 57 259Q61 263 69 265Q72 266 74 267Q76 268 76 270Q76 271 74 272Q73 273 70 273Q64 273 60 273Q57 272 54 272Q51 272 47 272Q42 272 37 272Q33 272 29 273Q26 273 23 273ZM245 275Q239 275 234 272Q229 269 226 264Q223 259 223 254Q223 246 227 241Q232 236 242 232L264 223Q268 221 269 219Q270 217 271 213L271 199Q271 192 268 188Q265 184 259 184Q256 184 253 185Q250 187 248 188Q247 189 247 191Q246 192 246 194Q246 195 246 197Q247 199 247 200Q247 201 243 203Q239 206 235 207Q230 209 227 209Q226 209 225 208Q224 207 224 205Q224 201 226 197Q229 193 234 189Q240 184 247 180Q254 176 261 174Q268 171 273 171Q284 171 291 179Q298 186 297 198L296 249Q296 254 298 258Q300 261 304 261Q309 261 312 258Q313 257 314 257Q315 257 315 258Q316 259 316 260Q316 263 312 267Q308 271 303 273Q299 275 294 275Q281 275 274 262H273Q265 269 259 272Q252 275 245 275ZM258 261Q261 261 263 260Q266 259 268 257Q268 256 269 254Q270 253 270 250L270 234Q270 232 270 231Q269 230 268 230Q268 230 267 231Q266 231 265 231Q256 235 252 239Q248 243 248 249Q248 256 251 259Q255 261 258 261ZM358 275Q344 275 336 268Q329 260 329 246V191Q329 189 327 188Q326 188 321 187H319Q317 187 316 185Q315 183 315 181Q315 180 316 179Q316 179 317 178Q322 176 328 172Q334 168 339 163Q344 159 347 156Q348 155 350 154Q351 153 352 153Q354 153 355 154Q356 154 356 157L354 170Q354 173 355 174Q357 175 360 175H388Q388 175 389 176Q390 178 390 179Q390 182 389 185Q388 188 387 188H365Q359 188 357 189Q355 190 355 194V239Q355 250 359 255Q363 260 370 260Q377 260 381 259Q384 258 387 256Q387 256 388 256Q389 256 390 257Q390 258 390 260Q390 261 386 265Q381 269 374 272Q366 275 358 275ZM394 273Q389 273 389 270Q389 267 395 265Q398 264 401 262Q404 261 404 256V141Q404 135 402 130Q400 125 394 124Q392 124 392 120Q392 118 394 117Q399 116 405 114Q411 112 417 110Q423 108 427 106Q429 106 429 106Q431 106 431 106Q432 107 432 108Q432 109 431 112Q431 114 430 118Q430 122 430 130V180Q430 183 430 184Q431 186 431 187Q435 184 440 181Q445 177 452 174Q459 171 466 171Q479 171 487 180Q495 189 495 204V255Q495 260 498 262Q501 264 504 265Q506 266 508 267Q509 268 509 270Q509 273 504 273Q499 273 496 272Q492 272 490 272Q487 272 482 272Q477 272 474 272Q472 272 469 272Q466 273 461 273Q455 273 455 269Q455 268 457 267Q458 266 460 265Q464 264 466 262Q469 260 469 255V208Q469 203 466 198Q464 194 460 191Q456 189 451 189Q448 189 443 190Q438 191 434 194Q432 196 431 198Q430 200 430 205V256Q430 260 433 262Q435 264 438 265Q441 266 442 267Q443 268 443 269Q443 273 439 273Q434 273 431 272Q427 272 424 272Q421 272 417 272Q413 272 409 272Q406 272 402 272Q399 273 394 273Z" /><path className="brand-word-pilot" d="M483 273Q481 273 480 272Q478 271 478 270Q478 268 481 267Q483 266 486 265Q495 263 500 260Q504 257 507 249L539 143Q542 135 540 131Q537 127 527 125Q524 125 523 123Q522 122 522 121Q522 119 525 118Q527 118 529 118Q533 118 538 118Q543 118 548 118Q554 119 558 118Q561 118 566 118Q571 118 576 117Q582 117 587 117Q603 117 614 123Q626 128 632 138Q638 148 638 161Q638 173 632 183Q627 193 617 200Q608 207 596 211Q583 215 570 215Q565 215 562 214Q559 213 559 211Q559 209 561 209Q562 208 564 207Q567 207 570 207Q572 206 575 206Q586 203 593 196Q601 190 605 180Q609 170 609 159Q609 147 606 140Q602 132 596 129Q589 125 581 125Q579 125 577 126Q575 128 574 131Q572 134 570 141L537 247Q535 256 538 259Q541 263 550 265Q553 266 555 267Q556 268 556 270Q556 271 553 272Q551 273 548 273Q543 273 537 272Q531 272 526 272Q520 272 516 272Q508 272 500 272Q491 273 483 273ZM639 275Q634 275 630 272Q626 268 626 264Q626 263 626 262Q626 261 627 259Q635 243 641 227Q647 212 653 198Q653 197 651 197Q650 197 647 198Q644 199 641 201Q638 202 635 204Q633 206 632 205Q630 204 630 202Q630 201 633 198Q636 195 640 191Q645 188 650 184Q655 180 661 177Q666 174 671 172Q674 171 677 172Q680 174 682 177Q684 179 683 181L656 248Q655 249 655 250Q655 251 655 252Q655 253 655 254Q656 255 657 255Q659 255 664 252Q668 249 673 245Q678 241 682 237Q682 236 683 236Q683 236 684 237Q685 238 685 239Q685 243 680 249Q675 255 668 261Q661 267 653 271Q645 275 639 275ZM683 152Q679 152 676 149Q673 145 673 140Q673 133 678 128Q683 122 690 122Q695 122 698 126Q701 130 701 135Q701 142 696 147Q691 152 683 152ZM697 275Q692 275 688 271Q684 267 684 263Q684 261 685 259L727 138Q729 131 729 128Q728 125 726 123Q723 122 722 120Q721 119 719 118Q719 117 718 116Q718 115 720 114Q723 113 728 112Q732 111 736 110Q740 109 742 108Q744 107 748 107Q751 106 755 106Q758 105 759 105Q760 105 761 106Q762 108 762 109Q761 111 761 113Q760 116 759 118L714 246Q714 247 714 248Q714 250 714 250Q714 254 716 254Q719 254 723 251Q727 248 731 244Q735 240 738 237Q739 236 739 235Q740 234 741 234Q742 234 743 235Q743 236 743 237Q743 241 740 246Q737 251 731 257Q726 262 719 266Q713 270 707 273Q701 275 697 275ZM779 275Q771 275 764 271Q758 267 753 260Q749 253 749 244Q749 233 754 221Q758 208 767 197Q775 186 787 178Q799 171 814 171Q828 171 837 180Q845 189 845 203Q845 214 841 226Q836 239 828 250Q819 261 807 268Q795 275 779 275ZM784 267Q789 267 794 262Q799 256 804 248Q808 240 812 230Q816 219 818 209Q820 199 820 191Q820 186 818 182Q816 179 811 179Q807 179 802 184Q797 189 792 198Q787 206 783 216Q779 226 777 236Q775 246 775 255Q775 261 777 264Q780 267 784 267ZM861 275Q858 275 855 273Q852 271 850 268Q848 265 848 263Q848 260 849 258Q850 256 851 252L873 191Q875 188 874 187Q872 186 871 186L860 186Q856 185 856 184Q855 183 855 181Q855 181 856 179Q858 177 860 176Q862 174 865 174H876Q879 174 880 173Q881 172 883 169L889 156Q891 153 894 150Q897 147 900 145Q903 143 905 143Q909 143 909 146Q910 149 909 152L904 170Q903 173 904 173Q905 174 907 174Q911 174 915 175Q919 175 923 176Q927 176 928 178Q929 179 929 180Q929 181 928 182Q927 184 924 184Q920 184 916 185Q912 185 908 185Q904 185 902 186Q900 187 899 190L880 241Q879 246 879 248Q879 250 880 251Q881 252 883 252Q886 252 890 249Q894 246 898 242Q903 239 905 236Q907 235 908 235Q909 235 909 235Q909 236 909 237Q909 239 909 241Q907 245 903 249Q899 254 894 258Q888 263 883 267Q877 271 871 273Q866 275 861 275Z" /></g>
    <path className="brand-word-arrow" d="M556 332C656 348 856 336 960 312M940 308 968 308 952 332" fill="none" strokeWidth="7.2" />
  </svg>;
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
  const [grading, setGrading] = useState<{ userId: string; count: number } | null>(null);
  const userId = user?.id;
  const gradingCount = userId && grading?.userId === userId ? grading.count : 0;
  const sectionTitle = active ? { library: copy.navPublic, basket: copy.navBasket, handouts: copy.navHandouts, students: copy.navStudents, tools: copy.navTools }[active] : copy.navPublic;
  const trailTitle = trail?.length ? [...new Set([trail[trail.length - 1].label, trail[0].label])].join(" · ") : "";
  const browserTitle = `${title?.trim() || trailTitle || sectionTitle} · MathPilot`;
  const accountLabel = user?.local ? copy.localAdmin : user?.email ?? copy.guestBrowse;

  useEffect(() => { document.title = browserTitle; }, [browserTitle]);
  useEffect(() => {
    if (!userId) return;
    let current = true, reading = false;
    const refresh = async () => {
      if (document.hidden || reading) return;
      reading = true;
      try {
        const result = await homeworkApi.gradingCount();
        if (current) setGrading({ userId, count: result.count });
      } catch { /* Keep the last confirmed count until the next refresh. */ }
      finally { reading = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 4000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { current = false; window.clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [userId]);
  useEffect(() => {
    navigation.current?.querySelector<HTMLElement>(".active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, basketCount, gradingCount, locale, signOutStatus, user?.id]);

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
      {entry("students", "/?view=wrong-book", <>{copy.navStudents}{gradingCount > 0 && <i title={`${gradingCount} 份作业正在批改`} aria-label={`${gradingCount} 份作业正在批改`}>{gradingCount}</i>}</>)}
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
