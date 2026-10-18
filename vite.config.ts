import { sites } from "@openai/sites-vite-plugin";
import vinext from "vinext";
import { defineConfig } from "vite";
import { join } from "node:path";
import hostingConfig from "./.openai/hosting.json";
import { cdnAdapter } from "@vinext/cloudflare/cache/cdn-adapter";
import { cloudflare } from "@cloudflare/vite-plugin";
import { preparePdfWorker } from "./scripts/prepare-pdf-worker.mjs";
import { ensureLocalBindings } from "./scripts/local-binding-config.mjs";
import { latexDevPlugin } from "./scripts/latex-dev-plugin.mjs";
import { lanSharePlugin, localNetworkName } from "./scripts/lan-share.mjs";

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

export default defineConfig(async ({ command }) => {
  await preparePdfWorker();
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Colleagues may open the site by this Mac's Bonjour name (共享办公), which survives IP changes.
  const networkName = localNetworkName();
  return {
    // Preview dependency rebundling must not replace chunks used by the live dev server.
    cacheDir: join(process.env.STUDIO_TEST_STATE ?? ".", "node_modules", ".vite", command),
    server: {
      allowedHosts: [networkName],
      ...(isCodexSeatbeltSandbox ? { watch: { useFsEvents: false, usePolling: true } } : {}),
    },
    plugins: [
      lanSharePlugin({ name: networkName }),
      latexDevPlugin(),
      vinext({
        cache: { cdn: cdnAdapter() },
      }),
      sites(),
      cloudflare({
        ...(process.env.STUDIO_TEST_STATE ? { persistState: { path: process.env.STUDIO_TEST_STATE }, remoteBindings: false } : {}),
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config(config) { ensureLocalBindings(config, hostingConfig); },
      }),
    ],
  };
});
