import type { AiTaskRole, ProviderConfig, ProviderDiagnostic, ProviderModel } from '../../ai-provider-types';
import { providerEndpoint } from '../../ai-provider-presets';
import { aiFetch, AiTimeoutError, aiTimeoutMs, readAiBody, withAiDeadline } from '../ai-http';
import { aiSchemaIssue } from '../ai-schema';
import { setting } from './credentials';
import { modelReasoningEffort, modelConfigurationFingerprint } from './model-options';
import { assertTrustedDestination } from './endpoint-policy';
import { ProviderError } from './errors';
import { readCenter, recordDiagnostic } from './provider-repository';
import { resolveRoute, type RuntimeTarget } from './routing';
import { openAiBody } from './adapters/openai';
import { deepSeekBody } from './adapters/deepseek';
import { geminiBody, finalGemini } from './adapters/gemini';
import { anthropicBody, finalAnthropic } from './adapters/anthropic';
import { finalChat, finalResponse, imageData, obj, type AdapterInput, type AdapterOptions, type ConcreteProtocol, type Json } from './adapters/types';
export interface EngineInput extends AdapterInput {
    upperAttempt?: number;
    /** Server-only postcondition for synthetic probes; never accepted from HTTP input. */
    validateOutput?: (value: unknown) => boolean;
    role: AiTaskRole;
    signal?: AbortSignal;
    timeoutMs?: number;
    missingMessage?: string;
}
export interface EngineResult {
    status: number;
    text?: string;
    error?: string;
    retryAfter?: string | null;
    terminal?: boolean;
    code: string;
    attempts: number;
    fallbackUsed: boolean;
    providerId?: string;
    modelId?: string;
    protocol?: ConcreteProtocol;
    diagnosticId?: string;
}
const messages: Record<string, string> = {
    UPSTREAM_AUTH_FAILED: '上游鉴权或权限失败，请检查密钥与分组。', UPSTREAM_QUOTA: '上游余额或配额不足，请检查服务账户。',
    MODEL_NOT_FOUND: '上游模型不存在或当前分组无权使用。', UPSTREAM_RATE_LIMITED: '上游限流；请遵守 Retry-After，未轮换提供方。',
    UPSTREAM_NOT_FOUND: '上游资源不存在；请检查模型映射、账户及分组可用性。目录列出模型不代表可以调用。',
    UPSTREAM_TIMEOUT: '请求超时；上游是否执行不确定，未自动重试。', UPSTREAM_TRANSPORT: '传输中断或重定向被拒绝；上游是否执行不确定，未自动重试。',
    OUTPUT_INVALID: '上游正文不符合所需数据结构，已拒绝使用。', OUTPUT_INCOMPLETE: '上游拒绝或输出未完成，未自动重复请求。',
    OUTPUT_EMPTY: '上游返回空正文；再次请求可能重复计费。', UPSTREAM_INVALID_RESPONSE: '上游返回非 JSON 或不支持的流式响应。',
    UPSTREAM_FAILED: '上游服务失败；再次请求可能重复计费。', UPSTREAM_REJECTED: '上游拒绝参数或请求，请检查协议、模型和结构设置。',
    ENDPOINT_UNSUPPORTED: '所选端点不受上游支持，请核对实例路径。', REQUEST_BUDGET_EXHAUSTED: '本次任务已达到最多三次上游尝试的上限。',
    IMAGE_INPUT_INVALID: '图片必须是有效的 PNG、JPEG、WebP 或 GIF base64 数据，未发送请求。',
};
const failure = (code: string, status: number, attempts = 0): EngineResult => ({ code, status, attempts, fallbackUsed: false, terminal: true, error: messages[code] || 'AI 请求未完成。' });
const unsupported = (s: string) => /unsupported|not supported|does not support|unknown (?:parameter|field)|unrecognized (?:parameter|field)|不支持/i.test(s);
function classify(status: number, payload: Json): string {
    const error = obj(payload.error), detail = `${error.type || ''} ${error.code || ''} ${error.message || ''}`;
    if (status === 429)
        return 'UPSTREAM_RATE_LIMITED';
    if (status === 401 || status === 403)
        return 'UPSTREAM_AUTH_FAILED';
    if (status === 402 || /insufficient_quota|insufficient.*(?:balance|credit)|余额不足|quota_exceeded/i.test(detail))
        return 'UPSTREAM_QUOTA';
    if (/model_not_found|model.*(?:not found|not exist)|模型.*不存在/i.test(detail))
        return 'MODEL_NOT_FOUND';
    // Gemini's resource-level NOT_FOUND is not evidence of a missing HTTP route.
    // Do not negotiate a different protocol for this response.
    if (status === 404 && error.status === 'NOT_FOUND')
        return 'UPSTREAM_NOT_FOUND';
    if ([404, 405, 501].includes(status) || [400, 422].includes(status) && unsupported(detail) && /endpoint|responses|chat\/completions/i.test(detail))
        return 'ENDPOINT_UNSUPPORTED';
    return status >= 500 ? 'UPSTREAM_FAILED' : 'UPSTREAM_REJECTED';
}
export function authentication(provider: ProviderConfig, key: string, protocol?: ConcreteProtocol): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (provider.endpoints.auth === 'bearer')
        headers.Authorization = `Bearer ${key}`;
    else
        headers[provider.endpoints.auth] = key;
    if (protocol === 'anthropic_messages')
        headers['anthropic-version'] = '2023-06-01';
    return headers;
}
export function inferenceEndpoint(provider: ProviderConfig, protocol: ConcreteProtocol, modelId: string) {
    const path = protocol === 'responses' ? provider.endpoints.responses : protocol === 'chat_completions' ? provider.endpoints.chat : protocol === 'gemini_generate_content' ? provider.endpoints.gemini : provider.endpoints.messages;
    return providerEndpoint(provider.baseUrl, path, modelId)!;
}
function initialOptions(provider: ProviderConfig, model: ProviderModel, protocol: ConcreteProtocol): AdapterOptions {
    // Gemini's native protocol supports responseSchema. Gateways often omit
    // capability metadata; absence must not silently disable that constraint.
    const advertised = model.metadata.apiCapabilities?.structured_outputs;
    const native = advertised === true || protocol === 'gemini_generate_content' && advertised !== false;
    let format: AdapterOptions['format'] = provider.outputStrategy === 'auto' ? native ? 'schema' : protocol === 'anthropic_messages' ? 'prompt' : 'json' : provider.outputStrategy;
    if (provider.kind === 'deepseek' && protocol === 'chat_completions' && format === 'schema')
        format = 'json';
    const effort = modelReasoningEffort(provider, model, protocol);
    return { format, reasoning: Boolean(effort), effort };
}
function requestBody(protocol: ConcreteProtocol, runtime: RuntimeTarget, input: AdapterInput, options: AdapterOptions) {
    const context = { provider: runtime.provider, model: runtime.model, input, options };
    if (protocol === 'gemini_generate_content')
        return geminiBody(context);
    if (protocol === 'anthropic_messages')
        return anthropicBody(context);
    return runtime.provider.kind === 'deepseek' ? deepSeekBody(protocol, context) : openAiBody(protocol, context);
}
const cache = new Map<string, ConcreteProtocol>(); // Endpoint success only, not a claim of business quality.
interface Budget {
    used: number;
    max: number;
}
async function invoke(runtime: RuntimeTarget, input: EngineInput, budget: Budget, signal: AbortSignal, fixed?: ConcreteProtocol): Promise<EngineResult> {
    const p = runtime.provider, cacheKey = modelConfigurationFingerprint(p, runtime.model);
    assertTrustedDestination(p.baseUrl);
    const order: ConcreteProtocol[] = fixed ? [fixed] : p.wireApi === 'auto' ? ['responses', 'chat_completions'] : [p.wireApi];
    const remembered = cache.get(cacheKey);
    if (remembered && order.includes(remembered))
        order.sort(a => a === remembered ? -1 : 1);
    for (const protocol of order) {
        const options = initialOptions(p, runtime.model, protocol);
        while (true) {
            signal.throwIfAborted();
            if (budget.used >= budget.max)
                return failure('REQUEST_BUDGET_EXHAUSTED', 422, budget.used);
            const body = requestBody(protocol, runtime, input, options), endpoint = inferenceEndpoint(p, protocol, runtime.model.id);
            budget.used++;
            const response = await aiFetch(endpoint, { method: 'POST', headers: authentication(p, runtime.key, protocol), body: JSON.stringify(body), signal });
            const retryAfter = response.headers.get('retry-after');
            const contentType = response.headers.get('content-type') || '';
            const raw = await readAiBody(response, input.maxTokens ? 128000 : 20000000);
            let payload: Json;
            try {
                // Some gateways retain the SSE header on a JSON error response.
                // Decode those errors, while still rejecting successful streams.
                if (response.ok && /text\/event-stream/i.test(contentType))
                    throw new Error('SSE unsupported');
                payload = obj(JSON.parse(raw));
            }
            catch {
                return { ...failure(response.ok ? 'UPSTREAM_INVALID_RESPONSE' : classify(response.status, {}), response.ok ? 502 : response.status, budget.used), protocol, retryAfter };
            }
            if (!response.ok || payload.error) {
                const code = classify(response.ok ? 502 : response.status, payload), error = obj(payload.error), detail = `${error.message || ''} ${error.param || ''}`;
                const result = { ...failure(code, response.ok ? 502 : response.status, budget.used), protocol, retryAfter };
                if (retryAfter || code === 'UPSTREAM_RATE_LIMITED')
                    return result;
                // Reject-only negotiation: never replay a successful, refused or truncated output.
                if (['UPSTREAM_REJECTED', 'ENDPOINT_UNSUPPORTED'].includes(code) && [400, 422].includes(response.status) && unsupported(detail) && budget.used < budget.max) {
                    if (protocol === 'chat_completions' && p.kind !== 'deepseek' && options.tokenLimit !== 'legacy' && /max_completion_tokens/i.test(detail)) {
                        options.tokenLimit = 'legacy';
                        continue;
                    }
                    if (options.reasoning && /reasoning|thinking/i.test(detail)) {
                        options.reasoning = false;
                        continue;
                    }
                    if (options.format !== 'prompt' && /response_format|text\.format|json_schema|json_object|strict|responseSchema|output_config/i.test(detail)) {
                        options.format = options.format === 'schema' ? 'json' : 'prompt';
                        continue;
                    }
                }
                if (code === 'ENDPOINT_UNSUPPORTED' && order.indexOf(protocol) < order.length - 1 && budget.used < budget.max) {
                    cache.delete(cacheKey);
                    break;
                }
                return result;
            }
            const output = protocol === 'responses' ? finalResponse(payload) : protocol === 'chat_completions' ? finalChat(payload) : protocol === 'gemini_generate_content' ? finalGemini(payload) : finalAnthropic(payload);
            if (output.terminal)
                return { ...failure('OUTPUT_INCOMPLETE', 422, budget.used), protocol, retryAfter };
            if (runtime.key && output.text.includes(runtime.key))
                return { ...failure('UPSTREAM_INVALID_RESPONSE', 502, budget.used), protocol, retryAfter };
            if (!output.text.trim())
                return { ...failure('OUTPUT_EMPTY', 502, budget.used), protocol, retryAfter };
            let parsed: unknown;
            try {
                parsed = JSON.parse(output.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
            }
            catch {
                return { ...failure('OUTPUT_INVALID', 422, budget.used), error: '上游正文不是有效 JSON（可能包含未转义的公式或额外说明），已拒绝使用', protocol, retryAfter };
            }
            let issue = aiSchemaIssue(parsed, input.schema);
            if (!issue) {
                try {
                    if (input.validateOutput?.(parsed) === false) issue = '结果未通过业务校验';
                } catch { issue = '结果未通过业务校验'; }
            }
            if (issue)
                return { ...failure('OUTPUT_INVALID', 422, budget.used), error: `上游正文结构校验失败：${issue}，已拒绝使用`, protocol, retryAfter };
            if (cache.size >= 64)
                cache.delete(cache.keys().next().value!);
            cache.set(cacheKey, protocol);
            return { status: 200, text: JSON.stringify(parsed), code: 'OK', attempts: budget.used, fallbackUsed: false, protocol, retryAfter };
        }
    }
    return failure('ENDPOINT_UNSUPPORTED', 502, budget.used);
}
async function diagnostic(runtime: RuntimeTarget, result: EngineResult, input: EngineInput, kind: ProviderDiagnostic['kind'], start: number) {
    if (runtime.provider.id === 'environment')
        return;
    const p = runtime.provider, protocol = result.protocol || (p.wireApi === 'auto' ? 'responses' : p.wireApi);
    const d = await recordDiagnostic({ providerId: p.id, modelId: runtime.model.id, protocol, fingerprint: modelConfigurationFingerprint(p, runtime.model), providerRevision: p.revision, credentialRevision: p.credentialRevision, kind, role: kind === 'task' ? input.role : undefined,
        endpoint: inferenceEndpoint(p, protocol, runtime.model.id), status: result.status, code: result.code, latencyMs: Date.now() - start, attempts: result.attempts, upperAttempt: Math.max(1, Math.min(20, input.upperAttempt || 1)), fallbackUsed: result.fallbackUsed });
    result.diagnosticId = d.id;
}
/** One deadline and hard attempt budget for the whole invocation, including fallback. */
export async function executeTargets(primary: RuntimeTarget, backup: RuntimeTarget | null, input: EngineInput, options: {
    kind?: ProviderDiagnostic['kind'];
    maxAttempts?: number;
    protocol?: ConcreteProtocol;
} = {}): Promise<EngineResult> {
    input.signal?.throwIfAborted();
    try {
        for (const image of input.images || [])
            imageData(image);
    }
    catch {
        return failure('IMAGE_INPUT_INVALID', 400);
    }
    const budget = { used: 0, max: Math.max(1, Math.min(3, options.maxAttempts || 3)) }, start = Date.now();
    let active = primary, result: EngineResult;
    try {
        result = await withAiDeadline(async (signal) => {
            let output = await invoke(primary, input, budget, signal, options.protocol);
            // Explicit backup is never a means of evading limits, rejections, or uncertain billing.
            if (backup && !output.retryAfter && ['UPSTREAM_FAILED', 'OUTPUT_EMPTY'].includes(output.code) && budget.used < budget.max) {
                try { await diagnostic(primary, output, input, options.kind || 'task', start); }
                catch { /* Recording failures cannot change the authorized request policy. */ }
                signal.throwIfAborted();
                active = backup;
                output = await invoke(backup, input, budget, signal, options.protocol);
                output.fallbackUsed = true;
            }
            return output;
        }, Math.min(aiTimeoutMs(input.timeoutMs || setting('AI_REQUEST_TIMEOUT_MS'), 180000), primary.provider.timeoutMs, backup?.provider.timeoutMs || 600000), input.signal);
    }
    catch (error) {
        if (input.signal?.aborted)
            throw input.signal.reason;
        result = error instanceof ProviderError ? { ...failure(error.code, error.status, budget.used), error: error.message } : failure(error instanceof AiTimeoutError ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_TRANSPORT', error instanceof AiTimeoutError ? 504 : 502, budget.used);
        result.fallbackUsed = active !== primary;
    }
    result.providerId = active.provider.id;
    result.modelId = active.model.id;
    // Diagnostics cannot turn a billed success into a retryable business failure.
    try {
        await diagnostic(active, result, input, options.kind || 'task', start);
    }
    catch { /* No request data or keys are logged. */ }
    return result;
}
export async function callV2(input: EngineInput): Promise<EngineResult> {
    input.signal?.throwIfAborted();
    try {
        const state = await readCenter(), targets = await resolveRoute(state, input.role, Boolean(input.images?.length));
        if (!targets.primary)
            return { ...failure('ROUTE_UNAVAILABLE', 503), error: input.missingMessage || '尚未配置此任务的 AI 目标。' };
        return executeTargets(targets.primary, targets.fallback, input);
    }
    catch (error) {
        if (input.signal?.aborted)
            throw input.signal.reason;
        return error instanceof ProviderError ? { ...failure(error.code, error.status), error: error.message } : failure('INTERNAL_ERROR', 500);
    }
}
/** Capability labels are advisory only; probes always exercise the selected model directly. */
export function checkProbeModel(p: ProviderConfig, model: ProviderModel, images: boolean) {
    void p;
    void model;
    void images;
}
