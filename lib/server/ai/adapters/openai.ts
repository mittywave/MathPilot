import { finalChat, finalResponse, jsonPrompt, type AdapterContext, type Json } from './types';
export function openAiBody(protocol: 'responses' | 'chat_completions', ctx: AdapterContext): Json {
    const { model, input, options } = ctx, responses = protocol === 'responses';
    const content: Json[] = [{ type: responses ? 'input_text' : 'text', text: jsonPrompt(input) }];
    for (const image of input.images || [])
        content.push(responses ? { type: 'input_image', image_url: image, detail: 'high' } : { type: 'image_url', image_url: { url: image, detail: 'high' } });
    const body: Json = responses ? { model: model.id, stream: false, store: false, input: [{ role: 'user', content }], max_output_tokens: input.maxTokens || 32768 } : { model: model.id, stream: false, messages: [{ role: 'user', content }], max_completion_tokens: input.maxTokens || 32768 };
    if (!responses && options.tokenLimit === 'legacy') {
        delete body.max_completion_tokens;
        body.max_tokens = input.maxTokens || 32768;
    }
    const schema = { name: input.schemaName, strict: true, schema: input.schema };
    if (options.format !== 'prompt') {
        const format = options.format === 'schema' ? { type: 'json_schema', ...schema } : { type: 'json_object' };
        if (responses)
            body.text = { format };
        else
            body.response_format = options.format === 'schema' ? { type: 'json_schema', json_schema: schema } : format;
    }
    if (options.reasoning && options.effort)
        body[responses ? 'reasoning' : 'reasoning_effort'] = responses ? { effort: options.effort } : options.effort;
    return body;
}
export { finalChat, finalResponse };
