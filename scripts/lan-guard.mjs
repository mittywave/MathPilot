// npm run dev listens on the LAN (0.0.0.0) so colleagues can use the site. The app grants the
// local administrator to requests whose URL host is a loopback name, and in the dev server that
// URL comes from the Host header the client sends. Only the Node layer sees the real peer
// address, so lan-share.mjs and latex-dev-plugin.mjs refuse LAN requests that claim a loopback host.
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export const isLoopbackAddress = (address) => LOOPBACK_ADDRESSES.has(address ?? "");

// Private IPv4 ranges (10/8, 172.16/12, 192.168/16, link-local 169.254/16), also in their
// IPv4-mapped IPv6 form, plus IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
export function isPrivateAddress(address) {
  const value = String(address ?? "").toLowerCase().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
  const ipv4 = value.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return /^f[cd][0-9a-f]{2}:/.test(value) || /^fe[89ab][0-9a-f]:/.test(value);
}

function loopbackHostname(hostname) {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1" || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

// A request from another machine must name a real host in origin form. A missing Host or an
// absolute request target could let the app fall back to a loopback URL.
export function forgedLocalRequest({ remoteAddress, host, url }) {
  if (isLoopbackAddress(remoteAddress)) return false;
  if (!host || !String(url ?? "").startsWith("/")) return true;
  try { return loopbackHostname(new URL(`http://${host}`).hostname.toLowerCase().replace(/^\[|\]$/g, "")); }
  catch { return true; }
}
