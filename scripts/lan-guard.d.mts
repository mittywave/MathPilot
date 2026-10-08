export function isLoopbackAddress(address: string | null | undefined): boolean;
export function isPrivateAddress(address: string | null | undefined): boolean;
export function forgedLocalRequest(request: { remoteAddress?: string | null; host?: string | null; url?: string | null }): boolean;
