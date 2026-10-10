import type { AiTaskRole, ProviderConfig, ProviderModel } from '../../ai-provider-types';
import { defaultEndpoints, normalizeProviderBase } from '../../ai-provider-presets';
import { normalizeAiProviderApiBase, aiProviderModelsUrl } from '../../ai-provider-rules.mjs';
import { unknownCapabilities } from './capabilities';
import { setting } from './credentials';
import { assertTrustedDestination } from './endpoint-policy';
import { checkedTarget, fingerprint, providerKey, type CenterState } from './provider-repository';
export interface RuntimeTarget {
    provider: ProviderConfig;
    model: ProviderModel;
    key: string;
}
function environmentModel(role: AiTaskRole) { const vision = setting('OPENAI_VISION_MODEL') || 'gemini-3.8-flash-high'; return role === 'text' ? setting('OPENAI_TEXT_MODEL') || vision : role === 'grading' ? setting('HOMEWORK_GRADING_MODEL') || vision : vision; }
function safeEnvironmentBase() {
    try {
        return normalizeProviderBase(setting('OPENAI_BASE_URL') || 'https://api.openai.com/v1');
    }
    catch {
        return '环境地址配置无效（已隐藏）';
    }
}
export function environmentSummary() { return { configured: Boolean(setting('OPENAI_API_KEY')), baseUrl: safeEnvironmentBase(), wireApi: setting('OPENAI_API_MODE') || 'auto', recognitionModel: environmentModel('recognition'), textModel: environmentModel('text'), gradingModel: environmentModel('grading') }; }
/** Environment is explicit read-only fallback. Never reread the old global row. */
async function environmentRuntime(role: AiTaskRole): Promise<RuntimeTarget | null> {
    const key = setting('OPENAI_API_KEY');
    if (!key)
        return null;
    const mode = setting('OPENAI_API_MODE') || 'auto', gemini = mode === 'antigravity_gemini';
    const wireApi = gemini ? 'gemini_generate_content' : ['responses', 'chat_completions'].includes(mode) ? mode as 'responses' | 'chat_completions' : 'auto';
    const root = setting('OPENAI_BASE_URL') || 'https://api.openai.com/v1';
    const baseUrl = gemini ? aiProviderModelsUrl(root, 'antigravity_gemini').replace(/\/models$/, '') : normalizeAiProviderApiBase(root);
    // The environment endpoint is trusted server configuration, not browser input.
    assertTrustedDestination(baseUrl);
    const model: ProviderModel = { id: environmentModel(role), displayName: environmentModel(role), capabilities: unknownCapabilities(), metadata: {}, catalogPresent: false, manual: false, legacyCompatible: true, updatedAt: 0 };
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    const provider: ProviderConfig = { id: 'environment', name: '环境变量（只读）', kind: 'custom', baseUrl, wireApi, endpoints: defaultEndpoints(wireApi), enabled: true, hasApiKey: true, credentialRevision: 0, revision: 0, timeoutMs: Number(setting('AI_REQUEST_TIMEOUT_MS')) || 180000, catalogTimeoutMs: 15000, outputStrategy: 'auto', reasoningEffort: '', legacy: true, fingerprint: '', referenceCount: 0, models: [model], createdAt: 0, updatedAt: 0 };
    provider.fingerprint = `${await fingerprint(provider)}:${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')}`;
    return { provider, model, key };
}
export async function resolveRoute(state: CenterState, role: AiTaskRole, images: boolean) {
    const route = state.routing.routes.find(r => r.role === role)!;
    const primary = route.primary || (images ? state.routing.defaultVisionTarget : state.routing.defaultTextTarget);
    if (!primary)
        return { primary: state.routing.allowEnvironmentFallback ? await environmentRuntime(role) : null, fallback: null };
    const checked = checkedTarget(state, primary, images, true);
    const target = { ...checked, key: await providerKey(state, checked.provider) };
    // Validate backup modality before the first paid request, without sending data.
    const backup = route.fallbackEnabled && route.fallback ? checkedTarget(state, route.fallback, images) : null;
    return { primary: target, fallback: backup ? { ...backup, key: await providerKey(state, backup.provider) } : null };
}
