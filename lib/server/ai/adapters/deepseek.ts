import { jsonPrompt, type AdapterContext, type Json } from './types';
/** Official non-streaming contracts checked 2026-09-27.
 * Keep this independent of OpenAI: adding an OpenAI field must not change
 * DeepSeek requests. Capabilities and effort are resolved for the actual model.
 */
export function deepSeekBody(protocol: 'responses' | 'chat_completions', ctx: AdapterContext): Json {
    const { input, model, options } = ctx;
    const effort = options.effort;
    if (protocol === 'chat_completions') {
        const content: Json[] = [{ type: 'text', text: jsonPrompt(input) }];
        for (const image of input.images || [])
            content.push({ type: 'image_url', image_url: { url: image } });
        const body: Json = { model: model.id, stream: false,
            messages: [{ role: 'user', content }], max_tokens: input.maxTokens || 32768 };
        if (options.format !== 'prompt') body.response_format = { type: 'json_object' };
        if (options.reasoning && effort) {
            body.thinking = { type: effort === 'none' ? 'disabled' : 'enabled' };
            if (effort !== 'none') body.reasoning_effort = effort;
        }
        return body;
    }
    const content: Json[] = [{ type: 'input_text', text: jsonPrompt(input) }];
    for (const image of input.images || []) content.push({ type: 'input_image', image_url: image });
    const body: Json = { model: model.id, stream: false,
        input: [{ role: 'user', content }], max_output_tokens: input.maxTokens || 32768 };
    if (options.format !== 'prompt') body.text = { format: options.format === 'schema'
        ? { type: 'json_schema', name: input.schemaName, schema: input.schema }
        : { type: 'json_object' } };
    if (options.reasoning && effort) body.reasoning = { effort };
    return body;
}
