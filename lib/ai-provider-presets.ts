import type { EndpointProfile, ProviderKind, ProviderWrite, WireProtocol } from './ai-provider-types';
export const KIND_LABELS: Record<ProviderKind, string> = { openai_compatible: 'OpenAI 兼容', deepseek: 'DeepSeek 官方', sub2api: 'Sub2API', custom: '自定义' };
export const PROTOCOL_LABELS: Record<WireProtocol, string> = { auto: '自动 · 仅 OpenAI 两种格式', responses: 'Responses', chat_completions: 'Chat Completions', gemini_generate_content: 'Gemini generateContent', anthropic_messages: 'Claude / Anthropic Messages' };
// Preset endpoints adapted from yetone/magpie internal/provider/presets.go (MIT).
// Keep them as form defaults: saved connections still use their exact URL and protocol.
export const PROVIDER_PRESETS = {
    openai_compatible: { name: 'OpenAI', kind: 'openai_compatible', baseUrl: 'https://api.openai.com/v1', wireApi: 'auto', auth: 'bearer' },
    deepseek: { name: 'DeepSeek', kind: 'deepseek', baseUrl: 'https://api.deepseek.com', wireApi: 'chat_completions', auth: 'bearer' },
    sub2api: { name: 'Sub2API / 中转网关', kind: 'sub2api', baseUrl: '', wireApi: 'auto', auth: 'bearer' },
    anthropic: { name: 'Claude / Anthropic', kind: 'custom', baseUrl: 'https://api.anthropic.com/v1', wireApi: 'anthropic_messages', auth: 'x-api-key' },
    gemini: { name: 'Google Gemini', kind: 'custom', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', wireApi: 'gemini_generate_content', auth: 'x-goog-api-key' },
    openrouter: { name: 'OpenRouter', kind: 'openai_compatible', baseUrl: 'https://openrouter.ai/api/v1', wireApi: 'chat_completions', auth: 'bearer' },
    custom: { name: '其他兼容接口', kind: 'custom', baseUrl: '', wireApi: 'auto', auth: 'bearer' },
} as const;
export function defaultEndpoints(protocol: WireProtocol = 'auto'): EndpointProfile {
    return { models: protocol === 'anthropic_messages' ? null : 'models', responses: 'responses', chat: 'chat/completions', gemini: 'models/{model}:generateContent', messages: 'messages', auth: 'bearer' };
}
export function newProvider(preset: keyof typeof PROVIDER_PRESETS = 'openai_compatible'): ProviderWrite {
    const p = PROVIDER_PRESETS[preset];
    return { expectedRevision: 0, name: p.name, kind: p.kind, baseUrl: p.baseUrl,
        wireApi: p.wireApi, endpoints: { ...defaultEndpoints(p.wireApi), models: 'models', auth: p.auth }, enabled: false,
        timeoutMs: 180000, catalogTimeoutMs: 15000, outputStrategy: 'auto', reasoningEffort: '', credential: { action: 'keep' } };
}
/** V2 NEVER adds a version or gateway prefix. A Base URL means exactly that base. */
export function normalizeProviderBase(value: string) {
    if (typeof value !== 'string' || !value.trim() || /[\\\s]/.test(value.trim()) || /%(?:2e|2f|5c|25)/i.test(value) || /\/(?:\.|\.\.)(?:\/|$)/.test(value))
        throw new Error('INVALID_BASE');
    const url = new URL(value.trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
        throw new Error('INVALID_BASE');
    return url.toString().replace(/\/+$/, '');
}
export function providerEndpoint(base: string, path: string | null, model = ''): string | null {
    if (path === null)
        return null;
    if (typeof path !== 'string' || !path || path.length > 200 || path.startsWith('/') || /[\\%?#\s]/.test(path) || path.includes('//') || path.split('/').some(p => p === '.' || p === '..') || /:/.test(path.replace('{model}:generateContent', 'model')))
        throw new Error('INVALID_ENDPOINT');
    if (!/^[\w/{}:.-]+$/.test(path) || /[{}]/.test(path.replace('{model}', '')))
        throw new Error('INVALID_ENDPOINT');
    const normalized = normalizeProviderBase(base);
    const suffix = path.replace('{model}', encodeURIComponent(model));
    const url = new URL(`${normalized}/${suffix}`);
    if (url.origin !== new URL(normalized).origin || !url.href.startsWith(`${normalized}/`))
        throw new Error('INVALID_ENDPOINT');
    return url.href;
}
export function credentialScope(base: string, endpoints: EndpointProfile) {
    return JSON.stringify([normalizeProviderBase(base), endpoints.auth, endpoints.models, endpoints.responses, endpoints.chat, endpoints.gemini, endpoints.messages]);
}

export type Sub2ApiMode = 'openai' | 'antigravity_gemini' | 'antigravity_claude';
export const SUB2API_MODES = {
    openai: { label: 'OpenAI 兼容', protocol: 'auto', suffix: '/v1' },
    antigravity_gemini: { label: 'Antigravity → Gemini', protocol: 'gemini_generate_content', suffix: '/antigravity/v1beta' },
    antigravity_claude: { label: 'Antigravity → Claude', protocol: 'anthropic_messages', suffix: '/antigravity/v1' },
} as const;
export function sub2ApiMode(protocol: WireProtocol): Sub2ApiMode {
    return protocol === 'gemini_generate_content' ? 'antigravity_gemini' : protocol === 'anthropic_messages' ? 'antigravity_claude' : 'openai';
}
/** Preview only. Applying this suggestion is a separate, explicit user action. */
export function suggestedSub2ApiBase(base: string, mode: Sub2ApiMode) {
    const normalized = normalizeProviderBase(base);
    return normalized.replace(/\/(?:antigravity\/v1beta|antigravity\/v1|v1beta|v1)$/, '') + SUB2API_MODES[mode].suffix;
}
export function withSub2ApiMode(draft: ProviderWrite, mode: Sub2ApiMode): ProviderWrite {
    const wireApi = SUB2API_MODES[mode].protocol;
    const previous = defaultEndpoints(draft.wireApi), defaults = defaultEndpoints(wireApi);
    const endpoints = { ...draft.endpoints,
        models: draft.endpoints.models === previous.models ? defaults.models : draft.endpoints.models };
    const scopeChanged = JSON.stringify(endpoints) !== JSON.stringify(draft.endpoints);
    return { ...draft, wireApi, endpoints,
        credential: scopeChanged && draft.credential.action === 'replace' ? { action: 'replace', value: '' } : draft.credential };
}
