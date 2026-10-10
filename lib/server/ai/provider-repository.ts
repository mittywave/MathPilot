import { env } from 'cloudflare:workers';
import { AI_ROLES, type AiRoutingConfig, type AiTaskRole, type EndpointProfile, type ModelTarget, type ProviderConfig, type ProviderDiagnostic, type ProviderModel, type ProviderWrite } from '../../ai-provider-types';
import { credentialScope, defaultEndpoints, normalizeProviderBase, providerEndpoint } from '../../ai-provider-presets';
import { aiProviderModelsUrl, normalizeAiProviderApiBase, normalizeAiProviderWireApi, selectAiProviderRoleModel } from '../../ai-provider-rules.mjs';
import { CAPABILITIES, mergeCatalog, object, requireCapabilities, unknownCapabilities } from './capabilities';
import { encryptionReady, openCredential, sealCredential } from './credentials';
import { assertTrustedDestination } from './endpoint-policy';
import { conflict, invalid, ProviderError } from './errors';
import { modelReasoningEffort, modelConfigurationFingerprint, normalizeEffort } from './model-options';
type Row = Record<string, string | number | null>;
export interface CenterState {
    providers: ProviderConfig[];
    routing: AiRoutingConfig;
    secrets: Map<string, string>;
    migrationState: string;
}
export function database(): D1Database { return (env as unknown as {
    DB: D1Database;
}).DB; }
const stmt = (sql: string, ...values: (string | number | null)[]) => database().prepare(sql).bind(...values);
const json = <T>(value: unknown, fallback: T): T => { try {
    return JSON.parse(String(value)) as T;
}
catch {
    return fallback;
} };
const target = (provider: unknown, model: unknown): ModelTarget | null => provider && model ? { providerId: String(provider), modelId: String(model) } : null;
export const sameTarget = (a: ModelTarget | null, b: ModelTarget | null) => a?.providerId === b?.providerId && a?.modelId === b?.modelId;
export async function fingerprint(provider: Pick<ProviderConfig, 'id' | 'baseUrl' | 'endpoints' | 'wireApi' | 'kind' | 'credentialRevision' | 'revision' | 'outputStrategy' | 'reasoningEffort'>) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([provider.id, provider.baseUrl, provider.endpoints, provider.wireApi, provider.kind, provider.credentialRevision, provider.revision, provider.outputStrategy, provider.reasoningEffort])));
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
export async function hasV2Schema() {
    try {
        const row = await stmt("SELECT migration_state FROM ai_routing_settings WHERE id='global'").first<Row>();
        return row?.migration_state === 'pending' || row?.migration_state === 'complete';
    }
    catch (error) {
        if (error instanceof Error && /no such table:\s*ai_routing_settings/i.test(error.message))
            return false;
        throw error;
    }
}
/** Global epoch + throwing guard protects the whole batch, including cross-table
 * references. A zero-row conditional UPDATE is NOT treated as a transaction lock. */
async function atomic(epoch: number, writes: D1PreparedStatement[]) {
    const token = crypto.randomUUID();
    try {
        await database().batch([
            stmt("INSERT INTO ai_v2_write_guard(id,valid) VALUES (?,CASE WHEN (SELECT configuration_revision FROM ai_routing_settings WHERE id='global')=? THEN 1 ELSE 0 END)", token, epoch),
            ...writes,
            stmt("UPDATE ai_routing_settings SET configuration_revision=configuration_revision+1 WHERE id='global'"),
            stmt('DELETE FROM ai_v2_write_guard WHERE id=?', token),
        ]);
    }
    catch (error) {
        if (error instanceof Error && /CHECK constraint failed.*(?:valid|ai_v2_write_guard)/i.test(error.message))
            conflict();
        throw error;
    }
}
function modelWrite(providerId: string, models: ProviderModel[]) {
    const serialized = JSON.stringify(models);
    if (new TextEncoder().encode(serialized).byteLength > 1000000)
        invalid('模型目录过大，请缩小上游分组。');
    // One set-based SQL statement keeps large catalog updates within D1 query budgets.
    return stmt(`INSERT INTO ai_provider_models(provider_id,model_id,display_name,capabilities_json,metadata_json,catalog_present,manual,legacy_compatible,updated_at)
    SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.displayName'),json_extract(value,'$.capabilities'),json_extract(value,'$.metadata'),json_extract(value,'$.catalogPresent'),json_extract(value,'$.manual'),json_extract(value,'$.legacyCompatible'),json_extract(value,'$.updatedAt') FROM json_each(?) WHERE true
    ON CONFLICT(provider_id,model_id) DO UPDATE SET display_name=excluded.display_name,capabilities_json=excluded.capabilities_json,metadata_json=excluded.metadata_json,catalog_present=excluded.catalog_present,manual=excluded.manual,legacy_compatible=excluded.legacy_compatible,updated_at=excluded.updated_at`, providerId, serialized);
}
async function ensureMigration() {
    const settings = await stmt("SELECT * FROM ai_routing_settings WHERE id='global'").first<Row>();
    if (!settings)
        throw new ProviderError('MIGRATION_REQUIRED', '请先安装经授权的 0015 数据库迁移。', 503);
    if (settings.migration_state === 'complete')
        return;
    const old = await stmt("SELECT * FROM ai_provider_config WHERE id='global'").first<Row>();
    const writes: D1PreparedStatement[] = [], actual: Partial<Record<AiTaskRole, string>> = {};
    if (old) {
        const oldProtocol = normalizeAiProviderWireApi(old.wire_api);
        const protocol = oldProtocol === 'antigravity_gemini' ? 'gemini_generate_content' : oldProtocol;
        const baseUrl = oldProtocol === 'antigravity_gemini' ? aiProviderModelsUrl(String(old.base_url), oldProtocol).replace(/\/models$/, '') : normalizeAiProviderApiBase(String(old.base_url));
        const config = { recognitionModel: String(old.recognition_model || ''), textModel: String(old.text_model || ''), diagramModel: String(old.diagram_model || ''), gradingModel: String(old.grading_model || '') };
        for (const role of AI_ROLES)
            actual[role] = selectAiProviderRoleModel(config, role);
        const now = Number(old.updated_at) || Date.now(), models = new Map<string, string>();
        const saved = json<{
            id?: string;
            displayName?: string;
        }[]>(old.model_catalog_json, []);
        for (const m of Array.isArray(saved) ? saved : [])
            if (typeof m.id === 'string' && m.id)
                models.set(m.id, m.displayName || m.id);
        for (const id of Object.values(actual))
            if (id)
                models.set(id, models.get(id) || id);
        writes.push(stmt(`INSERT INTO ai_providers(id,name,kind,base_url,wire_api,endpoint_config_json,enabled,api_key_encrypted,cipher_version,credential_revision,revision,legacy,created_at,updated_at)
      VALUES ('legacy-global',?,'custom',?,?,?,?,?,1,1,1,1,?,?)`, String(old.name), baseUrl, protocol, JSON.stringify(defaultEndpoints(protocol)), Number(old.enabled), String(old.api_key_encrypted || ''), now, now));
        writes.push(modelWrite('legacy-global', [...models].map(([id, name]) => ({ id, displayName: name, capabilities: unknownCapabilities('legacy'), metadata: {}, catalogPresent: false, manual: true, legacyCompatible: Object.values(actual).includes(id), updatedAt: now }))));
    }
    for (const role of AI_ROLES) {
        const model = old?.enabled ? actual[role] || null : null;
        writes.push(stmt('INSERT INTO ai_task_routes(role,primary_provider,primary_model) VALUES (?,?,?)', role, model ? 'legacy-global' : null, model));
    }
    writes.push(stmt("UPDATE ai_routing_settings SET migration_state='complete',allow_environment_fallback=? WHERE id='global'", old?.enabled ? 0 : 1));
    try {
        await atomic(Number(settings.configuration_revision), writes);
    }
    catch (error) {
        if (!(error instanceof ProviderError && error.code === 'REVISION_CONFLICT'))
            throw error;
        if ((await stmt("SELECT migration_state FROM ai_routing_settings WHERE id='global'").first<Row>())?.migration_state !== 'complete')
            throw error;
    }
}
export async function readCenter(): Promise<CenterState> {
    try {
        await ensureMigration();
    }
    catch (error) {
        if (error instanceof Error && /no such table:/.test(error.message))
            throw new ProviderError('MIGRATION_REQUIRED', 'V2 数据库迁移尚未安装；旧配置未改写。', 503);
        throw error;
    }
    const result = await database().batch<Row>([stmt('SELECT * FROM ai_providers ORDER BY created_at,id'), stmt('SELECT * FROM ai_provider_models ORDER BY provider_id,model_id COLLATE BINARY'), stmt("SELECT * FROM ai_routing_settings WHERE id='global'"), stmt('SELECT * FROM ai_task_routes')]);
    const settings = result[2].results[0], rows = result[3].results;
    const routing: AiRoutingConfig = { revision: Number(settings.configuration_revision), defaultTextTarget: target(settings.default_text_provider, settings.default_text_model), defaultVisionTarget: target(settings.default_vision_provider, settings.default_vision_model), allowEnvironmentFallback: Boolean(settings.allow_environment_fallback), routes: AI_ROLES.map(role => {
            const r = rows.find((r: Row) => r.role === role);
            return { role, primary: target(r?.primary_provider, r?.primary_model), fallback: target(r?.fallback_provider, r?.fallback_model), fallbackEnabled: Boolean(r?.fallback_enabled) };
        }) };
    const secrets = new Map<string, string>();
    const providers = await Promise.all(result[0].results.map(async (row: Row) => {
        const provider: ProviderConfig = { id: String(row.id), name: String(row.name), kind: row.kind as ProviderConfig['kind'], baseUrl: String(row.base_url), wireApi: row.wire_api as ProviderConfig['wireApi'], endpoints: json<EndpointProfile>(row.endpoint_config_json, defaultEndpoints()), enabled: Boolean(row.enabled), hasApiKey: Boolean(row.api_key_encrypted), credentialRevision: Number(row.credential_revision), revision: Number(row.revision), timeoutMs: Number(row.timeout_ms), catalogTimeoutMs: Number(row.catalog_timeout_ms), outputStrategy: row.output_strategy as ProviderConfig['outputStrategy'], reasoningEffort: String(row.reasoning_effort || ''), legacy: Boolean(row.legacy), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), fingerprint: '', referenceCount: 0,
            models: result[1].results.filter((m: Row) => m.provider_id === row.id).map((m: Row) => ({ id: String(m.model_id), displayName: String(m.display_name), capabilities: json(m.capabilities_json, unknownCapabilities()), metadata: json(m.metadata_json, {}), catalogPresent: Boolean(m.catalog_present), manual: Boolean(m.manual), legacyCompatible: Boolean(m.legacy_compatible), updatedAt: Number(m.updated_at) })) };
        provider.fingerprint = await fingerprint(provider);
        provider.referenceCount = referencedTargets(routing).filter(t => t.providerId === provider.id).length;
        secrets.set(provider.id, String(row.api_key_encrypted || ''));
        return provider;
    }));
    return { providers, routing, secrets, migrationState: String(settings.migration_state) };
}
export function publicCenter(state: CenterState) { return { providers: state.providers, routing: state.routing, encryptionReady: encryptionReady(), migrationState: state.migrationState }; }
export function findProvider(state: CenterState, id: string) { const provider = state.providers.find(p => p.id === id); if (!provider)
    throw new ProviderError('PROVIDER_NOT_FOUND', '提供方不存在。', 404); return provider; }
export async function providerKey(state: CenterState, provider: ProviderConfig) { const ciphertext = state.secrets.get(provider.id); if (!ciphertext)
    throw new ProviderError('PROVIDER_CREDENTIAL_MISSING', '请保存此提供方的 API Key。', 422, 'apiKey'); return openCredential(ciphertext, provider.id); }
export function referencedTargets(routing: AiRoutingConfig): ModelTarget[] { return [routing.defaultTextTarget, routing.defaultVisionTarget, ...routing.routes.flatMap(r => [r.primary, r.fallback])].filter((t): t is ModelTarget => Boolean(t)); }
export function checkedTarget(state: CenterState, target: ModelTarget, images: boolean, allowLegacy = false) {
    const provider = findProvider(state, target.providerId), model = provider.models.find(m => m.id === target.modelId);
    if (!provider.enabled || !provider.hasApiKey || !model)
        throw new ProviderError('ROUTE_UNAVAILABLE', '已配置目标被停用、缺少密钥或模型；不会静默改用其他提供方。', 422);
    assertTrustedDestination(provider.baseUrl);
    requireCapabilities(provider, model, images, allowLegacy);
    return { provider, model };
}
function text(value: unknown, field: string, max: number, empty = false) {
    if (typeof value !== 'string' || value.length > max || [...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) || !empty && !value.trim())
        invalid(`${field} 格式无效。`, field);
    return value.trim();
}
function integer(value: unknown, field: string, min: number, max: number) { if (!Number.isInteger(value) || Number(value) < min || Number(value) > max)
    invalid(`${field} 必须是 ${min}–${max} 的整数。`, field); return Number(value); }
export function validateProviderWrite(value: unknown): ProviderWrite {
    const input = object(value), credential = object(input.credential), rawEndpoints = object(input.endpoints);
    if (!['openai_compatible', 'deepseek', 'sub2api', 'custom'].includes(String(input.kind)))
        invalid('接入类型无效。', 'kind');
    if (!['auto', 'responses', 'chat_completions', 'gemini_generate_content', 'anthropic_messages'].includes(String(input.wireApi)))
        invalid('协议无效。', 'wireApi');
    if (!['auto', 'schema', 'json', 'prompt'].includes(String(input.outputStrategy)))
        invalid('输出策略无效。', 'outputStrategy');
    if (typeof input.enabled !== 'boolean')
        invalid('启用状态无效。', 'enabled');
    let baseUrl: string;
    try {
        baseUrl = normalizeProviderBase(text(input.baseUrl, 'baseUrl', 2048));
    }
    catch {
        return invalid('请输入不含凭据、查询参数或路径逃逸的 HTTP(S) Base URL。', 'baseUrl');
    }
    if (!['bearer', 'x-api-key', 'x-goog-api-key'].includes(String(rawEndpoints.auth)))
        invalid('认证方式无效。', 'auth');
    const endpoints = { auth: rawEndpoints.auth } as EndpointProfile;
    for (const name of ['models', 'responses', 'chat', 'gemini', 'messages'] as const) {
        if (name === 'models' && rawEndpoints[name] === null) {
            endpoints.models = null;
            continue;
        }
        try {
            if (typeof rawEndpoints[name] !== 'string')
                throw new Error('path');
            providerEndpoint(baseUrl, rawEndpoints[name] as string, 'preview-model');
            endpoints[name] = rawEndpoints[name] as string;
        }
        catch {
            invalid(`端点 ${name} 必须为 Base URL 内的安全相对路径。`, name);
        }
    }
    if (!['keep', 'replace', 'clear'].includes(String(credential.action)))
        invalid('请明确保留、替换或清除密钥。', 'apiKey');
    const operation = credential.action === 'replace' ? { action: 'replace' as const, value: text(credential.value, 'apiKey', 4096) } : { action: credential.action as 'keep' | 'clear' };
    return { expectedRevision: integer(input.expectedRevision, 'expectedRevision', 0, Number.MAX_SAFE_INTEGER), name: text(input.name, 'name', 80), kind: input.kind as ProviderWrite['kind'], baseUrl, wireApi: input.wireApi as ProviderWrite['wireApi'], endpoints, enabled: input.enabled,
        timeoutMs: integer(input.timeoutMs, 'timeoutMs', 1000, 600000), catalogTimeoutMs: integer(input.catalogTimeoutMs, 'catalogTimeoutMs', 1000, 60000), outputStrategy: input.outputStrategy as ProviderWrite['outputStrategy'], reasoningEffort: text(input.reasoningEffort ?? '', 'reasoningEffort', 40, true), credential: operation, confirmDisable: input.confirmDisable === true };
}
export async function saveProvider(id: string | null, value: unknown) {
    const input = validateProviderWrite(value), state = await readCenter(), existing = id ? findProvider(state, id) : undefined;
    if ((existing?.revision ?? 0) !== input.expectedRevision)
        conflict();
    if (!existing && state.providers.length >= 30)
        invalid('最多保存 30 个提供方。');
    const providerId = id || crypto.randomUUID(), sameScope = existing && credentialScope(existing.baseUrl, existing.endpoints) === credentialScope(input.baseUrl, input.endpoints);
    if (existing?.hasApiKey && !sameScope && input.credential.action === 'keep')
        throw new ProviderError('PROVIDER_CREDENTIAL_SCOPE_CHANGED', '地址、租户前缀或认证范围已变化，请重新输入此地址的 API Key。', 400, 'apiKey');
    if (existing?.referenceCount && !input.enabled && !input.confirmDisable)
        throw new ProviderError('PROVIDER_IN_USE', `此提供方被 ${existing.referenceCount} 处引用。请确认停用将使相关任务不可用，或先重新分配。`, 409);
    let ciphertext = existing ? state.secrets.get(existing.id) || '' : '', keyRevision = existing?.credentialRevision || 0;
    if (input.credential.action === 'replace') {
        ciphertext = await sealCredential(input.credential.value, providerId);
        keyRevision++;
    }
    if (input.credential.action === 'clear') {
        ciphertext = '';
        keyRevision++;
    }
    const legacy = Boolean(existing?.legacy && sameScope);
    if (input.enabled) {
        if (!ciphertext)
            invalid('启用前请保存 API Key。', 'apiKey');
        assertTrustedDestination(input.baseUrl);
    }
    const now = Date.now();
    await atomic(state.routing.revision, [stmt(`INSERT INTO ai_providers(id,name,kind,base_url,wire_api,endpoint_config_json,enabled,api_key_encrypted,cipher_version,credential_revision,revision,timeout_ms,catalog_timeout_ms,output_strategy,reasoning_effort,legacy,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,base_url=excluded.base_url,wire_api=excluded.wire_api,endpoint_config_json=excluded.endpoint_config_json,enabled=excluded.enabled,api_key_encrypted=excluded.api_key_encrypted,cipher_version=excluded.cipher_version,credential_revision=excluded.credential_revision,revision=excluded.revision,timeout_ms=excluded.timeout_ms,catalog_timeout_ms=excluded.catalog_timeout_ms,output_strategy=excluded.output_strategy,reasoning_effort=excluded.reasoning_effort,legacy=excluded.legacy,updated_at=excluded.updated_at`, providerId, input.name, input.kind, input.baseUrl, input.wireApi, JSON.stringify(input.endpoints), Number(input.enabled), ciphertext, json<{
            v?: number;
        }>(ciphertext, {}).v || 2, keyRevision, (existing?.revision || 0) + 1, input.timeoutMs, input.catalogTimeoutMs, input.outputStrategy, input.reasoningEffort, Number(legacy), existing?.createdAt || now, now)]);
    return findProvider(await readCenter(), providerId);
}
export async function deleteProvider(id: string, expectedRevision: number) {
    const state = await readCenter(), provider = findProvider(state, id);
    if (provider.revision !== expectedRevision)
        conflict();
    if (provider.referenceCount)
        throw new ProviderError('PROVIDER_IN_USE', '请先移除任务、备用和默认目标对该提供方的引用。', 409);
    await atomic(state.routing.revision, [stmt('DELETE FROM ai_providers WHERE id=?', id)]);
}
export async function saveCatalog(id: string, expectedFingerprint: string, models: ProviderModel[]) {
    const state = await readCenter(), provider = findProvider(state, id);
    if (provider.fingerprint !== expectedFingerprint)
        conflict('连接配置已变化，已丢弃过期目录结果。');
    const referenced = new Set(referencedTargets(state.routing).filter(t => t.providerId === id).map(t => t.modelId));
    const merged = mergeCatalog(provider.models, models, expectedFingerprint, referenced);
    if (merged.length > 1500)
        invalid('目录超过 1500 项，请缩小上游分组。');
    // Keep the database aligned with the latest upstream snapshot. Models that
    // vanished upstream are removed unless they are manual or still referenced.
    const keptIds = JSON.stringify(merged.map(model => model.id));
    await atomic(state.routing.revision, [
        modelWrite(id, merged),
        stmt("DELETE FROM ai_provider_models WHERE provider_id=? AND model_id NOT IN (SELECT value FROM json_each(?))", id, keptIds),
    ]);
    return findProvider(await readCenter(), id);
}
export async function saveManualModel(id: string, value: unknown) {
    const input = object(value), state = await readCenter(), provider = findProvider(state, id);
    if (input.expectedRevision !== provider.revision || input.expectedConfigurationRevision !== state.routing.revision)
        conflict();
    const modelId = text(input.id, 'modelId', 200), existing = provider.models.find(m => m.id === modelId);
    if (existing && input.update !== true)
        throw new ProviderError('MODEL_EXISTS', '该模型 ID 已存在（区分大小写），请编辑现有项。', 409, 'modelId');
    if (!existing && provider.models.length >= 1500)
        invalid('模型数量已达上限。');
    const capabilities = { ...(existing?.capabilities || unknownCapabilities()) }, now = Date.now();
    for (const name of CAPABILITIES) {
        const annotation = object(input.capabilities)[name];
        if (annotation === undefined)
            continue;
        if (!['unknown', 'supported', 'unsupported'].includes(String(annotation)))
            invalid('能力状态无效。');
        capabilities[name] = { state: annotation as 'unknown' | 'supported' | 'unsupported', source: 'manual', observedAt: now, configurationFingerprint: provider.fingerprint };
    }
    const model: ProviderModel = { id: modelId, displayName: text(input.displayName || modelId, 'displayName', 200), capabilities, metadata: existing?.metadata || {}, catalogPresent: existing?.catalogPresent || false, manual: true, legacyCompatible: existing?.legacyCompatible || false, updatedAt: now };
    if (input.reasoningEffort === null) {
        model.metadata = { ...model.metadata };
        delete model.metadata.reasoningEffort;
    } else if (input.reasoningEffort !== undefined) {
        const effort = normalizeEffort(provider.kind, text(input.reasoningEffort, 'reasoningEffort', 40, true));
        model.metadata = { ...model.metadata, reasoningEffort: effort };
        modelReasoningEffort(provider, model, provider.wireApi === 'auto' ? 'responses' : provider.wireApi);
    }
    await atomic(state.routing.revision, [modelWrite(id, [model])]);
    return model;
}
export async function deleteModel(id: string, value: unknown) {
    const input = object(value), state = await readCenter(), provider = findProvider(state, id);
    if (input.expectedConfigurationRevision !== state.routing.revision || input.expectedRevision !== provider.revision)
        conflict();
    const modelId = text(input.id, 'modelId', 200);
    if (referencedTargets(state.routing).some(t => t.providerId === id && t.modelId === modelId))
        throw new ProviderError('PROVIDER_IN_USE', '请先移除此模型的路由引用。', 409);
    await atomic(state.routing.revision, [stmt('DELETE FROM ai_provider_models WHERE provider_id=? AND model_id=?', id, modelId)]);
}
export async function saveProbeEvidence(id: string, modelId: string, expectedFingerprint: string, names: readonly ('text' | 'vision' | 'structured')[], expectedModelTime?: number) {
    const state = await readCenter(), provider = findProvider(state, id), model = provider.models.find(m => m.id === modelId);
    if (!model || provider.fingerprint !== expectedFingerprint || expectedModelTime !== undefined && model.updatedAt !== expectedModelTime)
        conflict('配置或模型证据已变化，探测结果不再用于能力判定。');
    for (const name of names)
        model.capabilities[name] = { state: 'supported', source: 'probe', observedAt: Date.now(), configurationFingerprint: provider.fingerprint };
    model.updatedAt = Date.now();
    await atomic(state.routing.revision, [modelWrite(id, [model])]);
}
function parseTarget(value: unknown): ModelTarget | null { if (value === null)
    return null; const v = object(value); return { providerId: text(v.providerId, 'providerId', 100), modelId: text(v.modelId, 'modelId', 200) }; }
export async function saveRouting(value: unknown) {
    const input = object(value), state = await readCenter();
    if (input.revision !== state.routing.revision)
        conflict();
    if (!Array.isArray(input.routes) || input.routes.length !== 4 || typeof input.allowEnvironmentFallback !== 'boolean')
        invalid('请提交完整的四类任务路由。');
    const next: AiRoutingConfig = { revision: state.routing.revision, defaultTextTarget: parseTarget(input.defaultTextTarget), defaultVisionTarget: parseTarget(input.defaultVisionTarget), allowEnvironmentFallback: input.allowEnvironmentFallback,
        routes: input.routes.map(item => { const r = object(item); if (!AI_ROLES.includes(r.role as AiTaskRole) || typeof r.fallbackEnabled !== 'boolean')
            invalid('任务路由格式无效。'); return { role: r.role as AiTaskRole, primary: parseTarget(r.primary), fallback: parseTarget(r.fallback), fallbackEnabled: r.fallbackEnabled }; }) };
    if (new Set(next.routes.map(r => r.role)).size !== 4)
        invalid('角色不能重复。');
    if (next.defaultTextTarget)
        checkedTarget(state, next.defaultTextTarget, false);
    if (next.defaultVisionTarget)
        checkedTarget(state, next.defaultVisionTarget, true);
    for (const route of next.routes) {
        const prior = state.routing.routes.find(r => r.role === route.role)!;
        const vision = route.role === 'recognition' || route.role === 'diagram';
        if (route.primary)
            checkedTarget(state, route.primary, vision, sameTarget(route.primary, prior.primary));
        if (route.fallback)
            checkedTarget(state, route.fallback, vision);
        if (route.fallbackEnabled && !route.fallback)
            invalid('启用备用时必须选择备用目标。');
        const primaries = route.primary ? [route.primary] : [next.defaultTextTarget, next.defaultVisionTarget].filter((t): t is ModelTarget => Boolean(t));
        if (route.fallback && primaries.some(t => sameTarget(t, route.fallback)))
            invalid('主目标与备用目标不能相同。');
    }
    await atomic(state.routing.revision, [
        ...next.routes.map(r => stmt('UPDATE ai_task_routes SET primary_provider=?,primary_model=?,fallback_provider=?,fallback_model=?,fallback_enabled=? WHERE role=?', r.primary?.providerId || null, r.primary?.modelId || null, r.fallback?.providerId || null, r.fallback?.modelId || null, Number(r.fallbackEnabled), r.role)),
        stmt("UPDATE ai_routing_settings SET default_text_provider=?,default_text_model=?,default_vision_provider=?,default_vision_model=?,allow_environment_fallback=? WHERE id='global'", next.defaultTextTarget?.providerId || null, next.defaultTextTarget?.modelId || null, next.defaultVisionTarget?.providerId || null, next.defaultVisionTarget?.modelId || null, Number(next.allowEnvironmentFallback)),
    ]);
    return (await readCenter()).routing;
}
export async function diagnostics(id: string) {
    const provider = findProvider(await readCenter(), id), rows = (await stmt('SELECT * FROM ai_provider_diagnostics WHERE provider_id=? ORDER BY created_at DESC,id LIMIT 50', id).all<Row>()).results;
    return rows.map((row: Row): ProviderDiagnostic => ({ id: String(row.id), providerId: id, modelId: row.model_id === null ? null : String(row.model_id), protocol: row.protocol as ProviderDiagnostic['protocol'], fingerprint: String(row.fingerprint), providerRevision: Number(row.provider_revision), credentialRevision: Number(row.credential_revision), kind: row.kind as ProviderDiagnostic['kind'], role: row.role ? row.role as AiTaskRole : undefined, endpoint: String(row.endpoint), status: Number(row.status), code: String(row.code), latencyMs: Number(row.latency_ms), attempts: Number(row.attempts), upperAttempt: Number(row.upper_attempt) || 1, fallbackUsed: Boolean(row.fallback_used), createdAt: Number(row.created_at), stale: row.fingerprint !== (row.model_id === null ? provider.fingerprint : (() => { const model = provider.models.find(m => m.id === row.model_id); return model ? modelConfigurationFingerprint(provider, model) : ''; })()) }));
}
export async function recordDiagnostic(d: Omit<ProviderDiagnostic, 'id' | 'createdAt'>) {
    const id = crypto.randomUUID(), now = Date.now();
    await database().batch([
        stmt('INSERT INTO ai_provider_diagnostics(id,provider_id,model_id,protocol,fingerprint,provider_revision,credential_revision,kind,role,endpoint,status,code,latency_ms,attempts,upper_attempt,fallback_used,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM ai_providers WHERE id=?)', id, d.providerId, d.modelId, d.protocol, d.fingerprint, d.providerRevision, d.credentialRevision, d.kind, d.role || null, d.endpoint, d.status, d.code, d.latencyMs, d.attempts, d.upperAttempt || 1, Number(d.fallbackUsed), now, d.providerId),
        stmt('DELETE FROM ai_provider_diagnostics WHERE provider_id=? AND id NOT IN (SELECT id FROM ai_provider_diagnostics WHERE provider_id=? ORDER BY created_at DESC,id LIMIT 100)', d.providerId, d.providerId),
    ]);
    return { ...d, id, createdAt: now };
}
export async function limitProbe(userId: string) {
    const window = Math.floor(Date.now() / 60000) * 60000;
    const row = await stmt(`INSERT INTO ai_probe_rate_limits(user_id,window_start,requests) VALUES (?,?,1) ON CONFLICT(user_id) DO UPDATE SET window_start=excluded.window_start,requests=CASE WHEN window_start=excluded.window_start THEN requests+1 ELSE 1 END RETURNING requests`, userId, window).first<Row>();
    if (Number(row?.requests) > 12)
        throw new ProviderError('UPSTREAM_RATE_LIMITED', '管理探测每分钟最多 12 次，请稍后再试。', 429);
}
