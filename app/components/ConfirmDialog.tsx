"use client";

import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";

type ConfirmOptions = {
  title: string;
  body?: ReactNode;
  items?: ReactNode[];
  confirmLabel: string;
  danger?: boolean;
  typeToConfirm?: string;
};

function ConfirmDialog({ options, finish }: { options: ConfirmOptions; finish: (confirmed: boolean) => void }) {
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const needsText = options.typeToConfirm !== undefined;
  const ready = !needsText || value === options.typeToConfirm;

  useEffect(() => { (input.current ?? cancel.current)?.focus(); }, []);

  return <div className="modal-backdrop modal-backdrop-raised">
    {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- The modal keeps Tab focus inside its controls. */}
    <section className="modal delete-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} data-danger={options.danger || undefined}
      onKeyDown={(event) => {
        if (event.key !== "Tab" || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.defaultPrevented) return;
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')]
          .filter((element) => element.getClientRects().length > 0);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <div className="modal-head"><h2 id={titleId}>{options.title}</h2><button type="button" className="close" aria-label="关闭" onClick={() => finish(false)}>×</button></div>
      {(options.items?.length || options.body) && <div className="delete-summary">
        {!!options.items?.length && <ul>{options.items.map((item, index) => <li key={index}>{item}</li>)}</ul>}
        {options.body && <div>{options.body}</div>}
      </div>}
      {needsText && <label className="field">输入“{options.typeToConfirm}”<input ref={input} value={value} autoComplete="off" onChange={(event) => setValue(event.target.value)} /></label>}
      <div className="modal-actions"><small>Esc 取消</small><button ref={cancel} type="button" className="secondary" onClick={() => finish(false)}>取消</button>
        <button type="button" className={options.danger ? "danger-button" : "primary-button"} disabled={!ready} onClick={() => { if (ready) finish(true); }}>{options.confirmLabel}</button></div>
    </section>
  </div>;
}

/** A single pending confirmation; duplicate calls cancel themselves and unmount cancels the outstanding promise. */
export function useConfirm(): [ReactNode, (options: ConfirmOptions) => Promise<boolean>] {
  const [request, setRequest] = useState<{ id: number; options: ConfirmOptions } | null>(null);
  const pending = useRef<{ resolve: (confirmed: boolean) => void; origin: HTMLElement | null } | null>(null);
  const sequence = useRef(0);
  const mounted = useRef(false);
  const restoreFrame = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelAnimationFrame(restoreFrame.current);
      const current = pending.current;
      pending.current = null;
      current?.resolve(false);
    };
  }, []);

  const finish = useCallback((confirmed: boolean) => {
    const current = pending.current;
    if (!current) return;
    pending.current = null;
    setRequest(null);
    restoreFrame.current = requestAnimationFrame(() => {
      if (mounted.current && !pending.current && current.origin?.isConnected) current.origin.focus();
    });
    current.resolve(confirmed);
  }, []);

  const confirm = useCallback((options: ConfirmOptions) => {
    if (!mounted.current || pending.current) return Promise.resolve(false);
    cancelAnimationFrame(restoreFrame.current);
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // A menu item disappears when chosen; its toggle remains a usable return point.
    const origin = active?.closest(".basket-more")?.querySelector<HTMLElement>("button.more-toggle") ?? active;
    return new Promise<boolean>((resolve) => {
      pending.current = { resolve, origin };
      setRequest({ id: ++sequence.current, options });
    });
  }, []);

  return [request ? <ConfirmDialog key={request.id} options={request.options} finish={finish} /> : null, confirm];
}
