'use client';
import { useEffect, useRef, type ReactNode } from 'react';
import type { ProviderConfig, ProviderWrite } from '../../../../lib/ai-provider-types';
export function providerDraft(p: ProviderConfig): ProviderWrite { return { name: p.name, kind: p.kind, baseUrl: p.baseUrl, wireApi: p.wireApi, endpoints: { ...p.endpoints }, enabled: p.enabled, timeoutMs: p.timeoutMs, catalogTimeoutMs: p.catalogTimeoutMs, outputStrategy: p.outputStrategy, reasoningEffort: p.reasoningEffort, expectedRevision: p.revision, credential: { action: 'keep' } }; }
export async function api<T>(path: string, body?: unknown, method = 'GET', signal?: AbortSignal): Promise<T> {
    const response = await fetch(path, { method, signal, cache: 'no-store', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    const data = await response.json();
    if (!response.ok) {
        const envelope = data && typeof data === 'object' && 'error' in data ? data.error : null;
        const detail = envelope && typeof envelope === 'object' ? envelope as Record<string, unknown> : {};
        const error = new Error(typeof detail.message === 'string' ? detail.message : typeof envelope === 'string' ? envelope : '操作失败') as Error & {
            field?: string;
            code?: string;
            diagnosticId?: string;
        };
        error.field = typeof detail.field === 'string' ? detail.field : undefined;
        error.code = typeof detail.code === 'string' ? detail.code : undefined;
        error.diagnosticId = typeof detail.diagnosticId === 'string' ? detail.diagnosticId : undefined;
        if (error.diagnosticId) error.message += `（诊断 ${error.diagnosticId}）`;
        throw error;
    }
    return data as T;
}
export function ConfirmDialog({ title, children, accept, cancel, action = '确认' }: {
    title: string;
    children: ReactNode;
    accept: () => void;
    cancel: () => void;
    action?: string;
}) {
    const ref = useRef<HTMLDialogElement>(null);
    useEffect(() => { const previous = document.activeElement as HTMLElement | null; const dialog = ref.current; dialog?.showModal(); return () => { dialog?.close(); previous?.focus(); }; }, []);
    return <dialog ref={ref} aria-labelledby="ai-dialog-title" onCancel={event => { event.preventDefault(); cancel(); }}><h2 id="ai-dialog-title">{title}</h2><div>{children}</div><div className="ai-dialog-actions"><button type="button" onClick={cancel}>取消</button><button type="button" data-primary onClick={accept}>{action}</button></div></dialog>;
}
export const time = (value: number) => value ? new Date(value).toLocaleString('zh-CN') : '未测试';
