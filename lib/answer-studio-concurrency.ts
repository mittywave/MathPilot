/** Request scheduling for one Studio run, not a global provider quota bypass. */
export const STUDIO_TEXT_CONCURRENCY = 4;
export const STUDIO_DRAWING_CONCURRENCY = 2;
export const STUDIO_CONCURRENCY_CHOICES = [1, 2, 4, 6] as const;
const retryStatuses = new Set([408, 429, 500, 502, 503, 504]);

export class StudioRequestError extends Error {
  constructor(message: string, public status = 0, public retryAfterMs = 0,
    public retryable = retryStatuses.has(status)) {
    super(message);
    this.name = 'StudioRequestError';
  }
}

export function studioRetryAfter(value: string | null | undefined, now = Date.now()): number {
  if (!value?.trim()) return 0;
  const text = value.trim();
  const delay = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) * 1000
    : /^[A-Za-z]{3},/.test(text) ? Date.parse(text) - now : 0;
  return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}

export function studioConcurrency(value: unknown, fallback = STUDIO_TEXT_CONCURRENCY, max = 6) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? Math.min(value, max) : fallback;
}
export type StudioConcurrencyState = { limit: number; cooldownUntil: number };
export function studioConcurrencyState(value: unknown, fallback = STUDIO_TEXT_CONCURRENCY, max = 6): StudioConcurrencyState {
  return { limit: studioConcurrency(value, fallback, max), cooldownUntil: 0 };
}
export type StudioRetryRuntime = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
};
const runtime: StudioRetryRuntime = {
  now: Date.now,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  random: Math.random,
};
export type StudioRetryNotice = { attempt: number; limit: number; delayMs: number; status: number };

/** Bounded windows, settled results in INPUT order, at most two retries.
 * Workers must return values, not mutate the shared draft or write checkpoints.
 * All in-flight work settles before return, including on partial failure.
 */
export async function runStudioWindow<T, R>(
  items: readonly T[], worker: (item: T) => Promise<R>, state: StudioConcurrencyState,
  onRetry: (notice: StudioRetryNotice) => void = () => {}, clock = runtime,
): Promise<PromiseSettledResult<R>[]> {
  const outcomes = new Array<PromiseSettledResult<R>>(items.length);
  let pending = items.map((_, index) => index);
  for (let attempt = 0; pending.length && attempt <= 2; attempt++) {
    const retry: number[] = [];
    for (let offset = 0; offset < pending.length;) {
      const delay = Math.max(0, state.cooldownUntil - clock.now());
      if (delay) await clock.sleep(delay);
      const indexes = pending.slice(offset, offset + state.limit);
      offset += indexes.length;
      const settled = await Promise.allSettled(indexes.map(index => Promise.resolve().then(() => worker(items[index]))));
      let slowDown = false, retryDelay = 0, retryStatus = 0;
      settled.forEach((outcome, position) => {
        const index = indexes[position];
        outcomes[index] = outcome;
        if (outcome.status !== 'rejected') return;
        const error = outcome.reason;
        if (!(error instanceof StudioRequestError) || !error.retryable) return;
        slowDown ||= error.status === 429 || error.status === 503;
        // Do not sleep for hours or retry EARLIER than a long Retry-After.
        // Leave this task failed for a later user-initiated continuation instead.
        if (attempt === 2 || error.retryAfterMs > 60_000) return;
        retry.push(index);
        retryStatus = error.status;
        retryDelay = Math.max(retryDelay, error.retryAfterMs, 1000 * 2 ** attempt + Math.floor(clock.random() * 250));
      });
      if (slowDown) state.limit = Math.max(1, Math.floor(state.limit / 2));
      if (retryDelay) {
        state.cooldownUntil = Math.max(state.cooldownUntil, clock.now() + retryDelay);
        onRetry({ attempt: attempt + 1, limit: state.limit, delayMs: retryDelay, status: retryStatus });
      }
    }
    pending = retry;
  }
  return outcomes;
}

/** Preserve HTTP status and Retry-After; do not turn auth/schema errors into retries. */
export async function studioApi<T>(url: string, body: unknown): Promise<T> {
  const payload = JSON.stringify(body);
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
  } catch (error) {
    // An explicit cancellation is never retried.
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new StudioRequestError(error instanceof Error ? error.message : 'Network request failed', 0, 0, true);
  }
  const data = await response.json().catch(() => ({ error: `HTTP ${response.status}: invalid JSON response` }));
  if (!response.ok) throw new StudioRequestError(
    typeof data?.error === 'string' ? data.error : `HTTP ${response.status}`,
    response.status, studioRetryAfter(response.headers.get('retry-after')),
    typeof data?.retryable === 'boolean' ? data.retryable : retryStatuses.has(response.status),
  );
  if (data?.error && !data?.records) throw new StudioRequestError(data.error, response.status, 0, false);
  return data as T;
}

// The AI engine marks every failure terminal, so ordinary callers never re-send a request
// that may already be billed. A Studio request only reads a page or a figure, so a timeout,
// a dropped connection, a gateway 5xx (including 524), a rate limit or an empty reply is
// retried by the scheduler instead of stopping the whole run. Its text drops the engine's
// "未自动重试" note, which would no longer be true.
const transientMessages: Record<string, string> = {
  UPSTREAM_TIMEOUT: 'AI 请求超时', UPSTREAM_TRANSPORT: '与 AI 服务的连接中断', UPSTREAM_FAILED: 'AI 服务暂时出错',
  UPSTREAM_RATE_LIMITED: 'AI 服务限流', UPSTREAM_INVALID_RESPONSE: 'AI 服务返回了无法解析的响应', OUTPUT_EMPTY: 'AI 服务返回空结果',
};
type StudioUpstreamResult = { status: number; error?: string; retryAfter?: string | null; terminal?: boolean; code?: string };
export function studioUpstreamError(result: StudioUpstreamResult, fallback: string) {
  const status = result.status >= 400 && result.status <= 599 ? result.status : 502;
  const transient = result.code ? transientMessages[result.code] : undefined;
  const retryable = result.code ? !!transient : !result.terminal && result.status >= 400 && retryStatuses.has(status);
  return new StudioRequestError(transient ? `${transient}（HTTP ${status}）` : result.error || fallback, status, studioRetryAfter(result.retryAfter), retryable);
}

/** Used only by Studio routes; ordinary question-bank API responses stay unchanged. */
export function studioUpstreamFailure(result: StudioUpstreamResult, fallback: string) {
  const error = studioUpstreamError(result, fallback);
  return Response.json({ error: error.message, retryable: error.retryable }, {
    status: error.status, headers: result.retryAfter ? { 'Retry-After': result.retryAfter } : undefined,
  });
}

export function studioCaughtFailure(error: unknown, fallback: string) {
  if(error instanceof Error&&error.name==='AbortError')return Response.json({error:"Recognition cancelled",retryable:false},{status:499});
  const network = error instanceof TypeError && /fetch|network|socket|ECONN|timeout/i.test(error.message);
  return Response.json({ error: error instanceof Error ? error.message : fallback, retryable: network }, { status: network ? 502 : 500 });
}

/** Rolling, bounded-lookahead execution with an ordered commit barrier.
 * Completion of a fast page refills a free slot; a slow peer does not impose a
 * whole-window barrier. Once ANY task/commit fails, launch no new work, drain
 * existing requests and persist their successes before propagating the error.
 * commit runs before refilling its released slot, leaving room for one
 * sequential context-review request without exceeding the concurrency limit.
 */
export async function runStudioOrdered<T,R>(
  items:readonly T[], worker:(item:T)=>Promise<R>, state:StudioConcurrencyState,
  commit:(item:T,value:R)=>Promise<void>, settled:(item:T,value:R)=>Promise<void> = async()=>{},
):Promise<void> {
  const active=new Map<number,Promise<void>>();
  const ready=new Map<number,PromiseSettledResult<R>>();
  const lookahead=Math.max(1,state.limit*2);
  let launch=0,cursor=0,halted=false;
  const start=(index:number)=>{
    const task=Promise.resolve().then(()=>worker(items[index])).then(async value=>{
      await settled(items[index],value);
      ready.set(index,{status:'fulfilled',value});
    }).catch((reason:unknown)=>{halted=true;ready.set(index,{status:'rejected',reason});})
      .finally(()=>{active.delete(index);});
    active.set(index,task);
  };
  try {
    while(cursor<items.length){
      while(ready.has(cursor)){
        const outcome=ready.get(cursor)!;ready.delete(cursor);
        if(outcome.status==='rejected')throw outcome.reason;
        await commit(items[cursor],outcome.value);cursor++;
      }
      while(!halted&&launch<items.length&&launch<cursor+lookahead&&active.size<state.limit)start(launch++);
      if(active.size)await Promise.race(active.values());
      else if(cursor<items.length&&!ready.has(cursor))throw new Error('Ordered scheduler stopped without a result');
    }
  } finally {
    halted=true;
    await Promise.all(active.values());
  }
}
