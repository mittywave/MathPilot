/** Preserve explicit homework queue recovery for transient service errors, but do
 * not replay refused/invalid output, invalid credentials, or uncertain transport.
 * This is an outer delivery budget; it is distinct from the gateway's 3 attempts. */
export class AiQueueFailure extends Error {
    readonly retryable: boolean;
    readonly retryAfterSeconds: number;
    constructor(result: {
        error?: string;
        code?: string;
        status: number;
        terminal?: boolean;
        retryAfter?: string | null;
    }, now = Date.now()) {
        super(result.error || 'AI 批改失败');
        this.name = 'AiQueueFailure';
        this.retryable = result.code ? ['UPSTREAM_FAILED', 'UPSTREAM_RATE_LIMITED'].includes(result.code) : !result.terminal && [429, 500, 502, 503, 504].includes(result.status);
        const seconds = Number(result.retryAfter), date = Date.parse(result.retryAfter || '');
        this.retryAfterSeconds = result.retryAfter ? Math.max(0, Math.ceil(Number.isFinite(seconds) ? seconds : Number.isFinite(date) ? (date - now) / 1000 : 0)) : 0;
    }
}
export function queueRetryDelay(error: unknown, attempt: number, maxAttempts: number, baseSeconds: number): number | null {
    if (attempt >= maxAttempts)
        return null;
    if (error instanceof AiQueueFailure && (!error.retryable || error.retryAfterSeconds > 300))
        return null;
    const backoff = Math.min(300, baseSeconds * 2 ** Math.max(0, attempt - 1));
    return Math.max(backoff, error instanceof AiQueueFailure ? error.retryAfterSeconds : 0);
}
