"use client";

import { useEffect } from "react";

/** Escape follows the top dialog's close button, including its busy state. */
export function DialogEscape() {
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return;
      let top: HTMLElement | null = null;
      let topLayer = -Infinity;
      for (const dialog of document.querySelectorAll<HTMLElement>('.modal-backdrop [role="dialog"]')) {
        const backdrop = dialog.closest(".modal-backdrop");
        const layer = backdrop ? Number.parseInt(getComputedStyle(backdrop).zIndex, 10) || 0 : 0;
        // Equal layers follow DOM order: the last dialog is painted on top.
        if (layer >= topLayer) { top = dialog; topLayer = layer; }
      }
      const menu = top?.querySelector<HTMLDetailsElement>('details[open]:has([role="menu"])');
      if (menu) {
        event.preventDefault();
        menu.open = false;
        menu.querySelector("summary")?.focus();
        return;
      }
      const button = top?.querySelector<HTMLButtonElement>("button.close");
      if (!button || button.disabled) return;
      event.preventDefault();
      button.click();
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, []);

  return null;
}
