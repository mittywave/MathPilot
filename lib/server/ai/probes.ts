import { aiFetch, AiTimeoutError, readAiBody, withAiDeadline } from '../ai-http';
import { providerEndpoint } from '../../ai-provider-presets';
import type { ProviderDiagnostic } from '../../ai-provider-types';
import { object, parseCatalog } from './capabilities';
import { assertTrustedDestination } from './endpoint-policy';
import { ProviderError } from './errors';
import { diagnostics, findProvider, providerKey, readCenter, recordDiagnostic, saveCatalog, saveProbeEvidence } from './provider-repository';
import { authentication, checkProbeModel, executeTargets } from './engine';
import type { ConcreteProtocol } from './adapters/types';
import { visionChallenge } from './vision-probe';
export const PROBE_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVQIHWP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
export async function discoverModels(id: string, expectedFingerprint: unknown, signal: AbortSignal) {
    const state = await readCenter(), p = findProvider(state, id);
    if (expectedFingerprint !== p.fingerprint)
        throw new ProviderError('REVISION_CONFLICT', '连接版本已变化，请重新加载。', 409);
    if (!p.endpoints.models)
        throw new ProviderError('CATALOG_UNAVAILABLE', '本入口未配置目录 API，可以手动添加模型。', 422);
    assertTrustedDestination(p.baseUrl);
    const key = await providerKey(state, p), endpoint = providerEndpoint(p.baseUrl, p.endpoints.models)!, start = Date.now();
    let status = 0, code = 'OK';
    try {
        const models = await withAiDeadline(async (bounded) => {
            const response = await aiFetch(endpoint, { headers: authentication(p, key), signal: bounded });
            status = response.status;
            const raw = await readAiBody(response, 2000000);
            if (status === 401 || status === 403)
                throw new ProviderError('UPSTREAM_AUTH_FAILED', '目录鉴权失败，请检查 Key 和分组。', status);
            if (status === 429)
                throw new ProviderError('UPSTREAM_RATE_LIMITED', '目录接口限流，未尝试其他入口。', 429, undefined, response.headers.get('retry-after'));
            if (!response.ok)
                throw new ProviderError('CATALOG_UNAVAILABLE', `目录接口不可用（HTTP ${status}），可以手动添加模型。`, 422);
            if (raw.includes(key))
                throw new ProviderError('UPSTREAM_INVALID_RESPONSE', '目录响应含敏感数据，已拒绝返回。', 502);
            let parsed: unknown;
            try {
                parsed = JSON.parse(raw);
            }
            catch {
                throw new ProviderError('CATALOG_UNAVAILABLE', '目录未返回有效 JSON，可以手动添加模型。', 422);
            }
            const found = parseCatalog(parsed, p.fingerprint);
            if (!found.length)
                throw new ProviderError('CATALOG_UNAVAILABLE', '目录没有有效模型，可以手动添加模型；已有模型未删除。', 422);
            return found;
        }, p.catalogTimeoutMs, signal);
        signal.throwIfAborted();
        await saveCatalog(id, p.fingerprint, models);
        return { count: models.length, message: '目录已刷新；尚未测试这些模型的推理能力。', diagnostics: await diagnostics(id) };
    }
    catch (error) {
        if (signal.aborted) {
            code = 'CANCELLED';
            throw signal.reason;
        }
        code = error instanceof ProviderError ? error.code : error instanceof AiTimeoutError ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_TRANSPORT';
        if (error instanceof ProviderError)
            throw error;
        throw new ProviderError(code, code === 'UPSTREAM_TIMEOUT' ? '目录请求超时。' : '目录网络请求失败；没有跟随重定向。', 502);
    }
    finally {
        try {
            await recordDiagnostic({ providerId: id, modelId: null, protocol: p.wireApi, fingerprint: p.fingerprint, providerRevision: p.revision, credentialRevision: p.credentialRevision, kind: 'catalog', endpoint, status, code, latencyMs: Date.now() - start, attempts: 1, fallbackUsed: false });
        }
        catch { /* Do not expose body or credentials in logs. */ }
    }
}
export async function testModel(id: string, value: unknown, signal: AbortSignal) {
    const input = object(value), state = await readCenter(), p = findProvider(state, id);
    if (input.fingerprint !== p.fingerprint)
        throw new ProviderError('REVISION_CONFLICT', '请先保存并刷新当前连接配置。', 409);
    if (input.consent !== true)
        throw new ProviderError('TEST_CONSENT_REQUIRED', '测试会发送合成内容并可能计费，请明确确认。');
    if (!['text', 'vision', 'structured'].includes(String(input.kind)))
        throw new ProviderError('INVALID_INPUT', '请选择文本、图片或结构化测试。');
    const model = p.models.find(m => m.id === input.modelId);
    if (!model)
        throw new ProviderError('INVALID_INPUT', '请选择此提供方的一个已保存模型。', 400, 'modelId');
    const protocol = input.protocol;
    if (!['responses', 'chat_completions', 'gemini_generate_content', 'anthropic_messages'].includes(String(protocol)) || p.wireApi !== 'auto' && protocol !== p.wireApi || p.wireApi === 'auto' && !['responses', 'chat_completions'].includes(String(protocol)))
        throw new ProviderError('INVALID_INPUT', '测试协议必须属于当前配置的接口范围。');
    checkProbeModel(p, model, input.kind === 'vision');
    const key = await providerKey(state, p), kind = input.kind as ProviderDiagnostic['kind'];
    const challenge = kind === 'vision' ? visionChallenge() : null;
    const schema = challenge?.schema || { type: 'object', properties: { ok: { const: true, type: 'boolean' } }, required: ['ok'], additionalProperties: false };
    const result = await executeTargets({ provider: p, model, key }, null, {
        role: 'text', prompt: challenge?.prompt || 'This is a synthetic connection test. Return JSON {"ok":true}.',
        schema, schemaName: 'ai_connection_probe', images: challenge?.images || [],
        validateOutput: challenge?.validateOutput, maxTokens: 512, signal,
        timeoutMs: Math.min(30000, p.timeoutMs),
    }, { kind, maxAttempts: 1, protocol: protocol as ConcreteProtocol });
    signal.throwIfAborted();
    if (result.code === 'OK')
        await saveProbeEvidence(id, model.id, p.fingerprint, kind === 'vision' ? ['text', 'vision'] : kind === 'structured' ? ['text', 'structured'] : ['text'], model.updatedAt);
    // Never return the generated body (and never a saved or supplied key).
    const { text: _text, ...safe } = result;
    void _text;
    return { result: safe, notice: '仅验证此配置和合成样本；不等于复杂题库质量验收。' };
}
