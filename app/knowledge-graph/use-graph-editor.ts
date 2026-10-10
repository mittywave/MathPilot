"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { KnowledgeGraphRequestError, knowledgeGraphApi, type PublishKnowledgeGraphResult } from "../../lib/knowledge-graph-api-client";
import type { KnowledgeGraphDocument, PublishedKnowledgeGraph } from "../../lib/types";

export type SaveState = "idle" | "pending" | "saving" | "saved" | "error";
type Session = { published: PublishedKnowledgeGraph; document: KnowledgeGraphDocument; hasDraft: boolean };
type History = { past: KnowledgeGraphDocument[]; future: KnowledgeGraphDocument[] };

const SAVE_DELAY = 700;
const HISTORY_LIMIT = 80;

// One shared draft on the server; every edit is applied locally first, kept in an
// undo stack and autosaved with optimistic revision checks.
export function useGraphEditor(active: boolean, onConflict: (message: string) => void) {
  const [session, setSession] = useState<Session | null>(null);
  const [history, setHistory] = useState<History>({ past: [], future: [] });
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState("");
  const [loadError, setLoadError] = useState("");
  const documentRef = useRef<KnowledgeGraphDocument | null>(null);
  const revisionRef = useRef(0);
  const savedJsonRef = useRef("");
  const savingRef = useRef<Promise<void> | null>(null);
  const timerRef = useRef<number>(0);
  const coalesceRef = useRef<{ key: string; at: number } | null>(null);
  const conflictRef = useRef(onConflict);
  useEffect(() => { conflictRef.current = onConflict; }, [onConflict]);

  const load = useCallback(async () => {
    window.clearTimeout(timerRef.current);
    try {
      const state = await knowledgeGraphApi.editor();
      const document = state.draft?.document ?? state.published.document;
      documentRef.current = document; revisionRef.current = state.revision; savedJsonRef.current = JSON.stringify(document);
      setSession({ published: state.published, document, hasDraft: Boolean(state.draft) });
      setHistory({ past: [], future: [] }); setSaveState(state.draft ? "saved" : "idle"); setSaveError(""); setLoadError("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "图谱草稿读取失败");
    }
  }, []);

  useEffect(() => {
    if (!active || session) return;
    const frame = requestAnimationFrame(() => { void load(); });
    return () => cancelAnimationFrame(frame);
  }, [active, load, session]);

  const saveRef = useRef<() => Promise<void>>(async () => undefined);
  const save = useCallback(async (): Promise<void> => {
    while (savingRef.current) await savingRef.current;
    const document = documentRef.current; if (!document) return;
    const json = JSON.stringify(document);
    if (json === savedJsonRef.current) { setSaveState("saved"); return; }
    setSaveState("saving");
    let saved = false;
    const run = (async () => {
      try {
        const result = await knowledgeGraphApi.saveDraft(revisionRef.current, document);
        revisionRef.current = result.revision; savedJsonRef.current = json; setSaveError(""); saved = true;
        setSession((current) => current && { ...current, hasDraft: true });
        setSaveState(JSON.stringify(documentRef.current) === json ? "saved" : "pending");
      } catch (error) {
        if (error instanceof KnowledgeGraphRequestError && error.status === 409) {
          conflictRef.current(error.message); setSession(null); return;
        }
        setSaveState("error"); setSaveError(error instanceof Error ? error.message : "草稿保存失败");
      }
    })();
    savingRef.current = run;
    try { await run; } finally { savingRef.current = null; }
    // Edits made while the request was in flight get their own save; failures wait for the next edit.
    if (saved && documentRef.current && JSON.stringify(documentRef.current) !== savedJsonRef.current) {
      window.clearTimeout(timerRef.current); timerRef.current = window.setTimeout(() => { void saveRef.current(); }, SAVE_DELAY);
    }
  }, []);
  useEffect(() => { saveRef.current = save; }, [save]);

  const schedule = useCallback(() => {
    setSaveState("pending"); window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => { void save(); }, SAVE_DELAY);
  }, [save]);

  const apply = useCallback((next: KnowledgeGraphDocument, coalesce?: string) => {
    const previous = documentRef.current; if (!previous) return;
    const now = Date.now(); const last = coalesceRef.current;
    const merge = Boolean(coalesce && last && last.key === coalesce && now - last.at < 1600);
    coalesceRef.current = coalesce ? { key: coalesce, at: now } : null;
    if (!merge) setHistory((current) => ({ past: [...current.past, previous].slice(-HISTORY_LIMIT), future: [] }));
    documentRef.current = next;
    setSession((current) => current && { ...current, document: next });
    schedule();
  }, [schedule]);

  const step = useCallback((direction: "undo" | "redo") => {
    const current = documentRef.current; if (!current) return;
    const source = direction === "undo" ? history.past : history.future;
    const target = source[source.length - 1]; if (!target) return;
    setHistory(direction === "undo"
      ? { past: history.past.slice(0, -1), future: [...history.future, current] }
      : { past: [...history.past, current], future: history.future.slice(0, -1) });
    coalesceRef.current = null; documentRef.current = target;
    setSession((value) => value && { ...value, document: target });
    schedule();
  }, [history, schedule]);

  const flush = useCallback(async () => { window.clearTimeout(timerRef.current); await save(); }, [save]);

  const discard = useCallback(async () => {
    await flush();
    await knowledgeGraphApi.discardDraft(revisionRef.current);
    await load();
  }, [flush, load]);

  const publish = useCallback(async (note: string): Promise<PublishKnowledgeGraphResult> => {
    await flush();
    const result = await knowledgeGraphApi.publish(revisionRef.current, note);
    await load();
    return result;
  }, [flush, load]);

  const restore = useCallback(async (version: number) => {
    await flush();
    await knowledgeGraphApi.restore(version, revisionRef.current);
    await load();
  }, [flush, load]);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  return {
    session, saveState, saveError, loadError, apply, flush, discard, publish, restore, reload: load,
    canUndo: history.past.length > 0, canRedo: history.future.length > 0, undo: () => step("undo"), redo: () => step("redo"),
  };
}
