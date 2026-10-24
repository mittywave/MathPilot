"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

type ToastOptions = { text: string; tone: "success" | "error" | "progress"; action?: { label: string; run: () => void | Promise<void> } };

/**
 * Results share one place; failures stay until dismissed and recoverable changes can be undone there.
 * Work in progress spins in the same place until its result replaces it.
 */
export function useToast(locale: "zh" | "en" = "zh"): [ReactNode, (options: ToastOptions) => void] {
  const [message, setMessage] = useState<(ToastOptions & { id: number }) | null>(null);
  const [acting, setActing] = useState<number | null>(null);
  const pendingAction = useRef<number | null>(null);
  const sequence = useRef(0), remaining = useRef(6000), started = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);

  const show = useCallback((options: ToastOptions) => {
    if (mounted.current) setMessage({ ...options, id: ++sequence.current });
  }, []);
  const pause = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (started.current) remaining.current = Math.max(0, remaining.current - (Date.now() - started.current));
    started.current = 0;
  }, []);
  const resume = useCallback(() => {
    if (!message || message.tone !== "success" || timer.current || pendingAction.current === message.id || root.current?.matches(":hover") || root.current?.contains(document.activeElement)) return;
    started.current = Date.now();
    timer.current = setTimeout(() => {
      timer.current = null; started.current = 0;
      setMessage(current => current?.id === message.id ? null : current);
    }, remaining.current);
  }, [message]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; pause(); };
  }, [pause]);
  useEffect(() => {
    remaining.current = 6000; started.current = 0;
    resume();
    return pause;
  }, [message, pause, resume]);

  // Progress updates rewrite one toast in place, so its spinner keeps turning between steps.
  const node = message && <div key={message.tone === "progress" ? "progress" : message.id} ref={root} className={`app-toast ${message.tone}`} role={message.tone === "error" ? "alert" : "status"}
    onMouseEnter={pause} onMouseLeave={resume} onFocusCapture={pause} onBlurCapture={resume}>
    <svg className="toast-symbol" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {message.tone === "error" ? <><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M12 6v7m0 4v1" fill="none" stroke="currentColor" strokeWidth="2" /></>
        : message.tone === "progress" ? <><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" opacity=".3" /><path d="M12 3a9 9 0 0 1 9 9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></>
        : <path d="m5 12 4 4 10-10" fill="none" stroke="currentColor" strokeWidth="2" />}
    </svg>
    <span>{message.text}</span>
    {message.action && <button className="toast-action" type="button" disabled={acting === message.id} onClick={async () => {
      if (pendingAction.current === message.id) return;
      pendingAction.current = message.id;
      pause();
      setActing(message.id);
      try {
        await message.action!.run();
        if (mounted.current) setMessage(current => current?.id === message.id ? null : current);
      } catch (error) {
        show({ text: error instanceof Error ? error.message : locale === "en" ? "Action failed. Please retry." : "操作失败，请重试", tone: "error", action: { label: locale === "en" ? "Retry" : "重试", run: message.action!.run } });
      } finally {
        if (pendingAction.current === message.id) pendingAction.current = null;
        if (mounted.current) setActing(current => current === message.id ? null : current);
      }
    }}>{message.action.label}</button>}
    <button className="toast-close" type="button" aria-label={locale === "en" ? "Close notification" : "关闭提示"} onClick={() => setMessage(null)}>×</button>
  </div>;
  return [node, show];
}
