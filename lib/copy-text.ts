// navigator.clipboard only exists on secure origins, and colleagues use a plain-http LAN
// address, so this falls back to selecting a hidden textarea and the legacy copy command.
export async function copyText(text: string) {
  try {
    if (window.isSecureContext && navigator.clipboard) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* falls back below */ }
  const area = document.createElement("textarea");
  area.value = text; area.setAttribute("readonly", "");
  Object.assign(area.style, { position: "fixed", top: "0", left: "0", opacity: "0" });
  document.body.appendChild(area); area.select();
  try { return document.execCommand("copy"); } finally { area.remove(); }
}
