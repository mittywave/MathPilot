import type { ProviderConfig, ProviderModel, WireProtocol } from '../../../ai-provider-types';
export type ConcreteProtocol = Exclude<WireProtocol, 'auto'>;
export interface AdapterInput {
    prompt: string;
    images?: string[];
    schema: Record<string, unknown>;
    schemaName: string;
    maxTokens?: number;
}
export interface AdapterOptions {
    format: 'schema' | 'json' | 'prompt';
    reasoning: boolean;
    effort?: string;
    tokenLimit?: 'completion' | 'legacy';
}
export interface AdapterContext {
    provider: ProviderConfig;
    model: ProviderModel;
    input: AdapterInput;
    options: AdapterOptions;
}
export type Json = Record<string, unknown>;
export interface DecodedOutput {
    text: string;
    terminal?: boolean;
}
export const obj = (x: unknown): Json => x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Json : {};
export const list = (x: unknown): Json[] => Array.isArray(x) ? x.map(obj) : [];
export function jsonPrompt(input: AdapterInput) { return `${input.prompt}\n\nReturn only a JSON value matching the following schema. Do not include Markdown or reasoning.\n${JSON.stringify(input.schema)}`; }
/** Image conversion must fail rather than silently losing the user's picture. */
export function imageData(image: string) {
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
    if (!match || match[2].length > 28000000 || match[2].length % 4 !== 0)
        throw new Error('IMAGE_INPUT_INVALID');
    return { mimeType: match[1], data: match[2] };
}
export function finalResponse(payload: Json): DecodedOutput {
    const messages = list(payload.output).filter(item => item.type === 'message');
    const content = messages.flatMap(item => list(item.content));
    return { text: content.filter(part => part.type === 'output_text').map(part => typeof part.text === 'string' ? part.text : '').join('') || (typeof payload.output_text === 'string' ? payload.output_text : ''),
        terminal: ['incomplete', 'failed', 'in_progress', 'cancelled'].includes(String(payload.status)) || messages.some(m => m.status && m.status !== 'completed') || content.some(part => part.type === 'refusal') };
}
export function finalChat(payload: Json): DecodedOutput {
    const choice = list(payload.choices)[0] || {}, message = obj(choice.message);
    return { text: typeof message.content === 'string' ? message.content : list(message.content).filter(p => p.type === 'text').map(p => p.text || '').join(''),
        terminal: Boolean(message.refusal) || Boolean(choice.finish_reason && choice.finish_reason !== 'stop') };
}
