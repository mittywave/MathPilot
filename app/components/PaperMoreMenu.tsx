"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

export function PaperMoreMenu({ children, className = "", label = "组卷更多操作" }: { children: ReactNode; className?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>(".more-panel button:not(:disabled), .more-panel a[href]")?.focus();
    const dismiss = (event: globalThis.PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const focusOutside = (event: FocusEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        menuRef.current?.querySelector("button")?.focus();
        return;
      }
      const panel = menuRef.current?.querySelector(".more-panel");
      if (!panel?.contains(document.activeElement) || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const controls = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]')].filter(item => item.getClientRects().length);
      if (!controls.length) return;
      event.preventDefault();
      const current = controls.indexOf(document.activeElement as HTMLElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? controls.length - 1 : event.key === "ArrowDown" ? (current + 1) % controls.length : current < 0 ? controls.length - 1 : (current + controls.length - 1) % controls.length;
      controls[next].focus();
    };
    const choose = (event: MouseEvent) => {
      const target = event.target as Element;
      const panel = menuRef.current?.querySelector(".more-panel");
      if (panel?.contains(target) && target.closest("button")) {
        if (panel.contains(document.activeElement)) menuRef.current?.querySelector("button")?.focus();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", focusOutside);
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("click", choose);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", focusOutside);
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("click", choose);
    };
  }, [open]);

  return <div ref={menuRef} className={`basket-more ${className}`.trim()}>
    <button type="button" className="more-toggle icon-button" aria-label={label} title={label} aria-expanded={open} onClick={() => setOpen(!open)}><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="2" fill="currentColor" /><circle cx="12" cy="12" r="2" fill="currentColor" /><circle cx="19" cy="12" r="2" fill="currentColor" /></svg></button>
    {open && <div className="more-panel" role="group" aria-label={label}>{children}</div>}
  </div>;
}
