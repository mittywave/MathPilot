import { requireSameOrigin, requireUser } from '../auth';
import { readAiBody } from '../ai-http';
import { errorResponse, ProviderError } from './errors';
export async function adminRequest(request: Request, write = false) {
    if (write) {
        const origin = request.headers.get('origin');
        if (origin) {
            let valid = false;
            try {
                valid = new URL(origin).origin === new URL(request.url).origin;
            }
            catch { /* Invalid origins are never trusted. */ }
            if (!valid)
                throw new ProviderError('FORBIDDEN', '请求来源不受信任。', 403);
        }
    }
    if (write) requireSameOrigin(request);
    const user = await requireUser(request);
    if (user.role !== 'admin')
        throw new ProviderError('FORBIDDEN', '仅管理员可管理 AI 配置。', 403);
    return user;
}
export async function jsonBody(request: Request) {
    if (!request.headers.get('content-type')?.includes('application/json'))
        throw new ProviderError('INVALID_INPUT', '请求格式必须为 application/json。');
    let raw: string;
    try {
        raw = await readAiBody(new Response(request.body, { headers: request.headers }), 64000);
    }
    catch {
        throw new ProviderError('INVALID_INPUT', '请求体过大或读取中断。', 413);
    }
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new ProviderError('INVALID_INPUT', '请求必须为 JSON 对象。');
    return parsed as Record<string, unknown>;
}
export function publicJson(data: unknown, status = 200) { return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } }); }
export async function handle(request: Request, write: boolean, fn: (userId: string) => Promise<unknown>) {
    try {
        const user = await adminRequest(request, write);
        const result = await fn(user.id);
        return publicJson(result);
    }
    catch (error) {
        if (request.signal.aborted)
            return publicJson({ error: { code: 'CANCELLED', message: '请求已取消。', retryable: false } }, 499);
        return errorResponse(error);
    }
}
export type IdContext = {
    params: Promise<{
        id: string;
    }> | {
        id: string;
    };
};
