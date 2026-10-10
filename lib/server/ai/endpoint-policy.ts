import { normalizeProviderBase } from '../../ai-provider-presets';
import { localMode, setting } from './credentials';
import { ProviderError } from './errors';

function host(value: string) {
    return value.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
}

function unsafeIpv4(value: string) {
    const parts = value.split('.').map(Number);
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255))
        return false;
    const [a, b] = parts;
    return a === 0 || a === 10 || a === 127 || a >= 224
        || a === 100 && b >= 64 && b <= 127
        || a === 169 && b === 254
        || a === 172 && b >= 16 && b <= 31
        || a === 192 && b === 168
        || a === 198 && (b === 18 || b === 19);
}

function unsafeIpv6(value: string) {
    if (!value.includes(':'))
        return false;
    if (value === '::' || value === '::1' || value.startsWith('::ffff:'))
        return true;
    const first = Number.parseInt(value.split(':')[0] || '0', 16);
    return Number.isFinite(first)
        && ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0);
}

function unsafeProductionHost(value: string) {
    const valueHost = host(value);
    if (['localhost', 'metadata.google.internal', 'metadata', '100.100.100.200', '169.254.169.254'].includes(valueHost)
        || valueHost.endsWith('.localhost') || valueHost.endsWith('.local') || valueHost.endsWith('.internal'))
        return true;
    return unsafeIpv4(valueHost) || unsafeIpv6(valueHost);
}

/**
 * Custom public HTTPS endpoints are usable immediately after an administrator
 * enters a Base URL and API key. No separate server allowlist is required.
 *
 * We still reject obvious local/private/metadata destinations in production and
 * aiFetch refuses redirects. This is a practical SSRF guardrail, not DNS pinning:
 * a public hostname can still resolve to different addresses after validation.
 *
 * AI_PROVIDER_LOCAL_HTTP exists only for isolated loopback integration fixtures.
 */
export function assertTrustedDestination(value: string) {
    const base = normalizeProviderBase(value), url = new URL(base);
    const loopbackHttpTest = setting('AI_PROVIDER_LOCAL_HTTP') === 'true'
        && ['127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !localMode() && !loopbackHttpTest)
        throw new ProviderError('DESTINATION_NOT_ALLOWED', '生产环境只允许 HTTPS 接入地址。', 400, 'baseUrl');
    if (!localMode() && !loopbackHttpTest && unsafeProductionHost(url.hostname))
        throw new ProviderError('DESTINATION_NOT_ALLOWED', '生产环境不允许访问本机、私有网络或云元数据地址。', 400, 'baseUrl');
    return base;
}
