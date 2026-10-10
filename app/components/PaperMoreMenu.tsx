"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

export function PaperMoreMenu({ children, className = "", label = "组卷更多操作" }: { children: ReactNode; className?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: globalThis.PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const focusOutside = (event: FocusEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      menuRef.current?.querySelector("button")?.focus();
    };
    const choose = (event: MouseEvent) => {
      const target = event.target as Element;
      if (menuRef.current?.querySelector(".more-panel")?.contains(target) && target.closest("button")) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", focusOutside);
    document.addEventListener("keydown", escape);
    document.addEventListener("click", choose);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", focusOutside);
      document.removeEventListener("keydown", escape);
      document.removeEventListener("click", choose);
    };
  }, [open]);

  return <div ref={menuRef} className={`basket-more ${className}`.trim()}>
    <button className="more-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>更多</button>
    {open && <div className="more-panel" role="group" aria-label={label}>{children}</div>}
  </div>;
}
