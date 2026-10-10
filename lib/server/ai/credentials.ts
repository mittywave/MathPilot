import { env } from 'cloudflare:workers';
import { ProviderError } from './errors';
const LEGACY_LOCAL_SECRET = 'zhiti-local-ai-provider-development-key-v1-only';
export function setting(name: string): string { return String((env as unknown as Record<string, unknown>)[name] || process.env[name] || '').trim(); }
export function localMode() { return (env as unknown as {
    LOCAL_ADMIN_MODE?: string;
}).LOCAL_ADMIN_MODE === 'true'; }
export function encryptionReady() { return Boolean(setting('AI_PROVIDER_ENCRYPTION_KEY')) || localMode(); }
async function key() {
    const secret = setting('AI_PROVIDER_ENCRYPTION_KEY') || (localMode() ? LEGACY_LOCAL_SECRET : '');
    if (!secret)
        throw new ProviderError('ENCRYPTION_NOT_READY', '保存密钥前请配置 AI_PROVIDER_ENCRYPTION_KEY Worker Secret。', 503, 'apiKey');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
    return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
const b64 = (bytes: Uint8Array) => btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
const bytes = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));
export async function sealCredential(value: string, providerId: string) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`zhiti-ai-v2:${providerId}`) }, await key(), new TextEncoder().encode(value));
    return JSON.stringify({ v: 2, iv: b64(iv), data: b64(new Uint8Array(encrypted)) });
}
export async function openCredential(ciphertext: string, providerId: string) {
    const encryptionKey = await key();
    try {
        const payload = JSON.parse(ciphertext) as {
            v: number;
            iv: string;
            data: string;
        };
        if (![1, 2].includes(payload.v) || typeof payload.iv !== 'string' || typeof payload.data !== 'string')
            throw new Error('cipher format');
        const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(payload.iv), ...(payload.v === 2 ? { additionalData: new TextEncoder().encode(`zhiti-ai-v2:${providerId}`) } : {}) }, encryptionKey, bytes(payload.data));
        return new TextDecoder().decode(plaintext);
    }
    catch {
        throw new ProviderError('CREDENTIAL_DECRYPT_FAILED', '密钥无法解密。请确认仍使用原加密 Secret，或重新输入该提供方的 Key。', 422, 'apiKey');
    }
}
