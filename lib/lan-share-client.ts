// Talks to the dev server's 共享开关 (scripts/lan-share.mjs). A deployed site has no such
// route, so the status comes back null and the page leaves the switch out.
export type ShareStatus = {
  sharing: boolean;
  local: boolean;
  keepAwake: boolean;
  network: { label: string; address: string } | null;
  autoHere: boolean;
  remembered: { id: string; label: string; rememberedAt: number; current: boolean }[];
  addresses: string[];
};

const ROUTE = "/__mitty/share/";

export async function fetchShareStatus(): Promise<ShareStatus | null> {
  try {
    const response = await fetch(`${ROUTE}status`, { cache: "no-store" });
    if (!response.ok || !response.headers.get("Content-Type")?.includes("application/json")) return null;
    return await response.json() as ShareStatus;
  } catch { return null; }
}

async function post(path: string, body: unknown) {
  const response = await fetch(`${ROUTE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => ({})) as ShareStatus & { error?: string };
  if (!response.ok) throw new Error(payload.error || "共享设置失败");
  return payload;
}

export const setSharing = (sharing: boolean, remember: boolean) => post("set", { sharing, remember });
export const forgetSharedNetwork = (id: string) => post("forget", { id });
