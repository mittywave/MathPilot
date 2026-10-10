/** Public contracts only. Never import credential-bearing server records here. */
export const AI_ROLES = ['recognition', 'text', 'diagram', 'grading'] as const;
export type AiTaskRole = typeof AI_ROLES[number];
export type ProviderKind = 'openai_compatible' | 'deepseek' | 'sub2api' | 'custom';
export type WireProtocol = 'auto' | 'responses' | 'chat_completions' | 'gemini_generate_content' | 'anthropic_messages';
export type CapabilityState = 'supported' | 'unsupported' | 'unknown';
export type CapabilityName = 'text' | 'vision' | 'structured';
export interface CapabilityEvidence {
    state: CapabilityState;
    source: 'catalog' | 'documentation' | 'probe' | 'manual' | 'legacy';
    observedAt: number;
    configurationFingerprint: string;
}
export type ModelCapabilities = Record<CapabilityName, CapabilityEvidence>;
export interface ProviderModel {
    id: string;
    displayName: string;
    capabilities: ModelCapabilities;
    metadata: {
        inputModalities?: string[];
        outputModalities?: string[];
        effortLevels?: string[];
        defaultEffort?: string;
        /** Administrator override; empty means upstream default, missing inherits provider default. */
        reasoningEffort?: string;
        apiCapabilities?: Record<string, unknown>;
    };
    catalogPresent: boolean;
    manual: boolean;
    legacyCompatible: boolean;
    updatedAt: number;
}
export interface EndpointProfile {
    models: string | null;
    responses: string;
    chat: string;
    gemini: string;
    messages: string;
    auth: 'bearer' | 'x-api-key' | 'x-goog-api-key';
}
export interface ProviderConfig {
    id: string;
    name: string;
    kind: ProviderKind;
    baseUrl: string;
    wireApi: WireProtocol;
    endpoints: EndpointProfile;
    enabled: boolean;
    hasApiKey: boolean;
    credentialRevision: number;
    revision: number;
    timeoutMs: number;
    catalogTimeoutMs: number;
    outputStrategy: 'auto' | 'schema' | 'json' | 'prompt';
    reasoningEffort: string;
    legacy: boolean;
    fingerprint: string;
    referenceCount: number;
    models: ProviderModel[];
    createdAt: number;
    updatedAt: number;
}
export interface ModelTarget {
    providerId: string;
    modelId: string;
}
export interface AiTaskRoute {
    role: AiTaskRole;
    primary: ModelTarget | null;
    fallback: ModelTarget | null;
    fallbackEnabled: boolean;
}
export interface AiRoutingConfig {
    revision: number;
    defaultTextTarget: ModelTarget | null;
    defaultVisionTarget: ModelTarget | null;
    allowEnvironmentFallback: boolean;
    routes: AiTaskRoute[];
}
export type CredentialOperation = {
    action: 'keep' | 'clear';
} | {
    action: 'replace';
    value: string;
};
export type ProviderWrite = Pick<ProviderConfig, 'name' | 'kind' | 'baseUrl' | 'wireApi' | 'endpoints' | 'enabled' | 'timeoutMs' | 'catalogTimeoutMs' | 'outputStrategy' | 'reasoningEffort'> & {
    expectedRevision: number;
    credential: CredentialOperation;
    confirmDisable?: boolean;
};
export interface ProviderDiagnostic {
    id: string;
    providerId: string;
    modelId: string | null;
    protocol: WireProtocol;
    fingerprint: string;
    providerRevision: number;
    credentialRevision: number;
    kind: 'catalog' | 'text' | 'vision' | 'structured' | 'task';
    role?: AiTaskRole;
    endpoint: string;
    status: number;
    code: string;
    latencyMs: number;
    attempts: number;
    upperAttempt?: number;
    fallbackUsed: boolean;
    createdAt: number;
    stale?: boolean;
}
export interface AiCenterPublic {
    providers: ProviderConfig[];
    routing: AiRoutingConfig;
    encryptionReady: boolean;
    migrationState: string;
    environmentFallback: {
        configured: boolean;
        baseUrl: string;
        wireApi: string;
        recognitionModel: string;
        textModel: string;
        gradingModel: string;
    };
}
