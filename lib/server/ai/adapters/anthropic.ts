import { imageData, jsonPrompt, list, type AdapterContext, type DecodedOutput, type Json } from './types';
export function anthropicBody(ctx: AdapterContext): Json {
    const content: Json[] = [{ type: 'text', text: jsonPrompt(ctx.input) }];
    for (const image of ctx.input.images || []) {
        const { mimeType, data } = imageData(image);
        content.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data } });
    }
    const body: Json = { model: ctx.model.id, stream: false, max_tokens: ctx.input.maxTokens || 32768, messages: [{ role: 'user', content }] };
    if (ctx.options.format === 'schema')
        body.output_config = { format: { type: 'json_schema', schema: ctx.input.schema } };
    return body;
}
export function finalAnthropic(payload: Json): DecodedOutput {
    const content = list(payload.content);
    return { text: content.filter(part => part.type === 'text').map(part => typeof part.text === 'string' ? part.text : '').join(''),
        terminal: content.some(part => part.type === 'refusal') || Boolean(payload.stop_reason && payload.stop_reason !== 'end_turn') };
}
