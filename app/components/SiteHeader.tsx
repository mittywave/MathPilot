"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { AppearancePicker } from "./AppearancePicker";
import { ALEVEL_PAGE_COPY, type AlevelPageLocale } from "../../lib/alevel-page-locale.mjs";
import { logout } from "../../lib/api-client";
import type { AuthUser } from "../../lib/types";

// MathPilot wordmark ("01 editorial" design): "Math" upright in the ink colour, "Pilot" italic in a soft accent,
// a flight-path arrow beneath. The letters are EB Garamond (SIL OFL) outlines thickened by a round stroke, so the
// brand looks the same on every computer without a web font.
export function BrandWordmark() {
  return <svg className="brand-word" viewBox="9 97 964 256" role="img" aria-label="MathPilot" fill="currentColor" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
    <g strokeWidth="12"><path d="M23 273Q20 273 18 273Q16 272 16 271Q16 269 18 268Q20 267 24 266Q30 265 34 261Q38 256 39 248Q42 227 44 207Q46 188 47 173Q49 157 49 147Q49 146 49 143Q49 141 48 140Q48 138 48 136Q47 134 45 132Q41 128 37 127Q33 126 27 125Q25 124 23 123Q22 122 22 120Q22 118 24 118Q26 117 30 117Q32 117 37 118Q42 118 48 118Q53 119 58 119Q63 119 65 119Q67 119 68 120Q69 121 70 123Q71 127 72 132Q73 137 75 141L112 236Q113 238 115 238Q117 238 118 237L164 140Q165 136 167 131Q168 126 168 122Q169 119 171 119H179Q186 119 194 118Q202 117 206 117Q207 117 209 118Q211 118 211 120Q211 121 210 122Q209 123 205 124Q202 126 198 127Q194 129 191 130Q189 131 187 133Q185 135 185 138Q185 154 186 169Q187 184 187 197Q188 210 189 223Q190 236 191 250Q191 257 195 261Q200 265 208 266Q212 267 214 268Q216 269 216 271Q216 272 214 273Q212 273 209 273Q203 273 199 273Q195 272 191 272Q187 272 182 272Q177 272 174 272Q171 272 167 273Q163 273 157 273Q154 273 152 273Q150 272 150 271Q150 269 152 268Q154 267 158 266Q165 265 167 261Q170 258 170 249Q170 232 170 219Q169 205 168 192Q168 178 167 162Q167 160 166 160Q164 160 163 162L109 273Q109 274 107 274Q105 275 105 273Q96 245 85 219Q75 192 61 161Q61 160 60 160Q58 160 58 161Q56 177 54 191Q53 205 52 218Q51 232 51 248Q51 254 55 260Q59 265 66 266Q70 267 72 268Q74 269 74 271Q74 272 72 273Q70 273 67 273Q61 273 57 273Q54 272 52 272Q49 272 45 272Q41 272 38 272Q36 272 33 273Q30 273 23 273ZM248 275Q243 275 239 272Q235 269 232 264Q229 259 229 255Q229 247 233 243Q237 239 245 235L269 226Q274 224 275 222Q276 221 276 216L277 201Q277 195 273 190Q269 186 263 186Q259 186 256 187Q252 188 250 190Q248 191 248 193Q247 195 247 197Q247 198 247 199Q248 200 248 201Q248 202 245 204Q242 206 238 208Q234 209 232 209Q231 209 230 209Q229 208 229 207Q229 204 232 199Q234 195 239 191Q244 186 251 182Q257 179 263 176Q269 174 274 174Q282 174 288 180Q294 186 293 195L292 252Q292 257 294 260Q297 263 301 263Q307 263 309 260Q311 259 311 259Q312 259 313 260Q314 261 314 262Q314 264 311 267Q307 271 303 273Q299 275 295 275Q284 275 278 263H277Q269 269 262 272Q255 275 248 275ZM259 264Q263 264 267 262Q270 261 273 258Q274 257 275 255Q275 253 276 249L276 237Q276 234 276 233Q275 232 274 232Q273 232 272 232Q271 233 269 233Q257 238 252 243Q247 247 247 251Q247 258 251 261Q254 264 259 264ZM359 275Q347 275 341 268Q334 261 334 247V192Q334 191 333 190Q331 189 327 189H325Q324 189 323 187Q322 186 322 184Q322 184 323 183Q324 182 324 182Q329 178 333 175Q336 172 340 169Q343 165 345 163Q346 162 347 161Q348 160 349 160Q350 160 351 160Q352 161 352 162L351 173Q351 176 352 177Q353 178 357 178H383Q384 178 385 179Q386 181 386 183Q386 185 385 187Q384 189 383 189H360Q354 189 352 190Q351 191 351 196V242Q351 251 355 257Q359 262 366 262Q373 262 377 261Q381 260 384 258Q384 258 385 258Q386 258 386 259Q386 260 386 261Q386 262 382 266Q379 269 372 272Q366 275 359 275ZM397 273Q393 273 393 270Q393 268 398 266Q402 265 405 263Q408 261 408 257V138Q408 132 406 127Q404 122 398 121Q396 121 396 118Q396 116 398 115Q401 114 406 113Q410 111 415 110Q420 108 424 106Q425 106 425 106Q426 106 426 106Q427 107 427 107Q427 109 426 111Q426 114 425 120Q425 127 425 139V180Q425 184 425 186Q425 188 426 189Q430 186 436 183Q441 179 448 177Q455 174 462 174Q474 174 482 183Q489 192 489 206V256Q489 261 492 263Q495 265 499 266Q501 267 503 268Q504 269 504 270Q504 273 500 273Q495 273 492 272Q490 272 488 272Q485 272 481 272Q477 272 475 272Q472 272 470 272Q467 273 463 273Q458 273 458 270Q458 268 459 268Q461 267 463 266Q467 265 470 263Q473 261 473 256V208Q473 202 469 197Q466 192 461 189Q456 187 451 187Q446 187 440 188Q434 189 431 192Q427 195 426 198Q425 201 425 209V257Q425 261 428 263Q430 265 434 266Q437 267 438 268Q439 269 439 270Q439 273 434 273Q430 273 427 272Q425 272 423 272Q421 272 417 272Q412 272 410 272Q408 272 405 272Q402 273 397 273Z" /><path className="brand-word-pilot" d="M490 273Q487 273 486 273Q484 272 484 271Q484 269 486 268Q489 267 493 266Q501 265 507 261Q512 257 514 248L546 145Q549 135 546 130Q543 125 532 124Q528 124 527 123Q526 122 526 120Q526 119 528 118Q530 118 533 118Q534 118 538 118Q542 118 546 118Q551 118 554 118Q557 118 562 118Q567 118 572 117Q577 117 580 117Q595 117 606 122Q618 128 624 137Q630 147 630 161Q630 172 625 181Q620 191 611 198Q602 205 590 208Q578 212 566 212Q564 212 560 211Q556 211 556 209Q556 208 558 207Q559 206 561 206Q565 205 568 205Q571 204 574 204Q585 201 593 195Q601 189 605 180Q610 171 610 159Q610 149 606 141Q602 133 594 128Q586 123 574 123Q572 123 571 124Q570 125 569 128Q568 130 567 133L533 246Q530 255 532 260Q535 264 544 266Q547 267 549 268Q550 269 550 271Q550 272 548 273Q546 273 543 273Q537 273 533 273Q529 272 526 272Q523 272 519 272Q510 272 505 272Q499 273 490 273ZM633 275Q629 275 627 273Q624 270 624 267Q624 266 624 265Q624 264 625 264Q634 244 641 227Q648 209 653 196Q654 193 652 193Q650 193 647 195Q644 196 640 198Q636 200 633 202Q632 203 631 203Q630 202 630 201Q630 200 631 198Q633 196 636 193Q640 190 644 187Q648 184 654 180Q659 177 665 175Q667 174 669 175Q671 176 673 179Q674 181 674 182L645 250Q644 252 643 254Q643 255 643 257Q643 259 644 259Q646 260 647 260Q650 260 654 257Q659 253 663 249Q668 244 673 240Q673 239 674 239Q674 239 675 240Q675 240 675 240Q675 244 671 250Q666 256 659 261Q653 267 646 271Q639 275 633 275ZM681 151Q677 151 675 148Q673 145 673 142Q673 136 676 132Q680 127 686 127Q690 127 692 131Q694 134 694 137Q694 143 690 147Q686 151 681 151ZM694 275Q691 275 687 272Q684 269 684 265Q684 264 684 262L729 134Q730 131 731 128Q731 125 731 122Q731 120 729 118Q727 116 724 115Q721 115 720 114Q718 113 718 112Q718 112 718 111Q719 111 719 110Q719 110 720 110Q724 108 731 107Q737 106 743 106Q748 105 750 105Q751 105 752 106Q753 106 753 108Q753 110 752 111Q752 113 751 115L704 251Q703 253 703 254Q703 256 703 258Q703 261 705 261Q708 261 713 258Q718 254 723 249Q727 244 730 240Q732 238 733 236Q735 234 736 234Q737 234 737 235Q737 236 737 237Q737 242 734 247Q731 252 726 257Q721 263 715 267Q709 271 703 273Q698 275 694 275ZM774 275Q768 275 763 272Q758 268 756 262Q753 255 753 249Q753 238 757 225Q761 212 769 200Q777 189 787 182Q797 174 809 174Q821 174 827 182Q834 190 834 202Q834 213 830 225Q825 238 818 249Q810 261 799 268Q788 275 774 275ZM778 268Q783 268 789 263Q795 258 800 250Q806 242 810 233Q814 223 816 213Q819 204 819 196Q819 189 817 185Q815 181 809 181Q803 181 798 186Q792 190 786 198Q781 205 777 215Q773 224 770 234Q768 244 768 254Q768 261 770 265Q773 268 778 268ZM853 275Q851 275 849 274Q847 272 845 270Q844 268 844 267Q844 263 845 260Q846 257 847 253L869 190Q870 189 869 188Q868 188 867 188L858 187Q855 187 854 186Q853 185 853 184Q853 183 855 182Q856 181 857 179Q859 178 861 178H870Q872 178 873 177Q874 176 876 174L881 162Q882 160 885 158Q887 155 890 154Q893 152 894 152Q896 152 896 154Q897 157 896 159L890 175Q889 177 890 177Q891 178 893 178Q897 178 902 178Q907 179 910 179Q914 180 915 181Q916 182 916 183Q916 184 915 185Q914 186 911 186Q906 186 901 186Q897 187 892 187Q888 187 886 188Q885 189 884 191L863 249Q862 251 862 254Q862 256 864 257Q865 258 868 258Q871 258 875 256Q878 253 882 250Q885 247 888 245Q890 242 892 242Q894 243 894 244Q894 246 893 248Q892 250 890 252Q886 256 882 259Q878 263 874 266Q869 269 865 271Q861 273 858 274Q855 275 853 275Z" /></g>
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
