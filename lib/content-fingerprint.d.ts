export function contentFingerprint(text: string, cryptoSource?: Pick<Crypto, "subtle"> | Record<string, never> | undefined): Promise<string>;
