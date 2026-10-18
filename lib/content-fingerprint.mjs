// crypto.subtle exists only on secure origins (https, localhost). A colleague who opens the site
// at a plain-http LAN address still needs a stable page identity for caching and de-duplication,
// so this falls back to a 106-bit non-cryptographic fingerprint (two cyrb53 lanes). Browser
// storage is per origin, so the two kinds of fingerprint never meet. Never use it for security.
function cyrb53(text, seed) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** @param {string} text @param {Crypto | null} [cryptoSource] Pass null for one stable identity across secure and LAN origins. */
export async function contentFingerprint(text, cryptoSource = globalThis.crypto) {
  if (cryptoSource?.subtle) {
    const bytes = await cryptoSource.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `c53-${cyrb53(text, 0).toString(16).padStart(14, "0")}${cyrb53(text, 1).toString(16).padStart(14, "0")}`;
}
