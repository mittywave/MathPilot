import type { ProviderConfig, ProviderModel, WireProtocol } from '../../ai-provider-types';
import { ProviderError } from './errors';
const aliases: Record<string, string> = { minimal: 'low', medium: 'high', xhigh: 'high' };
export function normalizeEffort(kind: ProviderConfig['kind'], value: string) {
    return kind === 'deepseek' ? aliases[value] || value : value;
}
/** A provider default is not evidence that every model supports that setting. */
export function modelReasoningEffort(provider: ProviderConfig, model: ProviderModel, protocol: WireProtocol) {
    if (!['responses', 'chat_completions'].includes(protocol)) return '';
    const explicit = model.metadata.reasoningEffort !== undefined;
    const effort = normalizeEffort(provider.kind, explicit ? model.metadata.reasoningEffort! : provider.reasoningEffort);
    if (!effort) return '';
    const levels = model.metadata.effortLevels;
    const supported = provider.kind === 'deepseek'
        ? effort === 'none' || ['low', 'high', 'max'].includes(effort) && Boolean(levels?.includes(effort))
        : !levels || levels.includes(effort);
    if (!supported && explicit)
        throw new ProviderError('CAPABILITY_MISMATCH', '此模型目录未声明所选思考档位，请刷新目录或选择上游默认。', 422, 'reasoningEffort');
    return supported ? effort : '';
}
/** Model options are configuration; editing them invalidates probes/cache too. */
export function modelConfigurationFingerprint(provider: ProviderConfig, model: ProviderModel) {
    return `${provider.fingerprint}:${JSON.stringify([model.id, model.metadata.reasoningEffort ?? null])}`;
}
