import { imageData, jsonPrompt, list, obj, type AdapterContext, type DecodedOutput, type Json } from './types';
/** Only the supported wire subset is transformed; original schema is always checked locally. */
export function geminiSchema(value: unknown): unknown {
    if (Array.isArray(value))
        return value.map(geminiSchema);
    if (!value || typeof value !== 'object')
        return value;
    const source = obj(value), output: Json = {};
    for (const key of ['type', 'description', 'enum', 'required', 'items', 'minItems', 'maxItems', 'minimum', 'maximum', 'format'])
        if (source[key] !== undefined)
            output[key] = geminiSchema(source[key]);
    if (source.properties)
        output.properties = Object.fromEntries(Object.entries(obj(source.properties)).map(([key, val]) => [key, geminiSchema(val)]));
    if (Array.isArray(source.type)) {
        output.nullable = source.type.includes('null');
        output.type = source.type.find(t => t !== 'null');
    }
    if (Array.isArray(source.anyOf)) {
        const alternatives = source.anyOf.map(obj), real = alternatives.filter(x => x.type !== 'null');
        if (real.length === 1 && alternatives.length === 2)
            return { ...obj(geminiSchema(real[0])), nullable: true };
        output.anyOf = real.map(geminiSchema);
    }
    return output;
}
export function geminiBody(ctx: AdapterContext): Json {
    const parts: Json[] = [{ text: jsonPrompt(ctx.input) }];
    for (const image of ctx.input.images || [])
        parts.push({ inlineData: imageData(image) });
    const generationConfig: Json = { maxOutputTokens: ctx.input.maxTokens || 32768 };
    if (ctx.options.format !== 'prompt') {
        generationConfig.responseMimeType = 'application/json';
        if (ctx.options.format === 'schema')
            generationConfig.responseSchema = geminiSchema(ctx.input.schema);
    }
    // Thinking parameters vary by generation. Do not derive them from a model name.
    return { contents: [{ role: 'user', parts }], generationConfig };
}
export function finalGemini(payload: Json): DecodedOutput {
    const candidate = list(payload.candidates)[0] || {};
    return { text: list(obj(candidate.content).parts).filter(part => part.thought !== true && typeof part.text === 'string').map(part => part.text).join(''),
        terminal: Boolean(obj(payload.promptFeedback).blockReason) || Boolean(candidate.finishReason && candidate.finishReason !== 'STOP') };
}
