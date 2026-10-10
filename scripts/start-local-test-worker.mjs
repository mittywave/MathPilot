/** Start the real compiled Worker and local bindings without Wrangler's hot-reload
 * reverse proxy. Never a mocked application server and never a remote binding.
 * The browser suite still separately verifies `wrangler dev` itself.
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { unstable_getMiniflareWorkerOptions } from 'wrangler';
const require = createRequire(import.meta.url);
// Use exactly the Miniflare version locked by the project's direct Wrangler dependency.
const { Miniflare, Log, LogLevel } = createRequire(require.resolve('wrangler'))('miniflare');
const [configValue, portValue, stateValue, varsValue] = process.argv.slice(2);
if (!configValue || !stateValue || !varsValue || !/^\d+$/.test(portValue || '')) throw Error('Expected compiled config, port, isolated state and synthetic bindings.');
const configPath = resolve(configValue), persist = resolve(stateValue);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
for (const group of ['d1_databases', 'r2_buckets', 'kv_namespaces', 'services']) {
  if ((config[group] || []).some(binding => binding.remote === true)) throw Error('Remote bindings are forbidden in local tests.');
}
const vars = JSON.parse(varsValue);
if (!vars || Array.isArray(vars) || typeof vars !== 'object' || Object.values(vars).some(v => typeof v !== 'string')) throw Error('Synthetic bindings must be a string record.');
const { workerOptions, main, externalWorkers } = unstable_getMiniflareWorkerOptions(configPath);
if (!main || externalWorkers.length) throw Error('Expected one compiled application Worker.');
const moduleRoot = dirname(main);
// Vinext emits dynamic imports. Provide the complete compiled module inventory,
// as Wrangler does, rather than trying to statically trace dynamic specifiers.
const modules = [{ type: 'ESModule', path: main }, ...readdirSync(moduleRoot, { recursive: true })
  .filter(path => /\.(?:m?js)$/.test(path) && resolve(moduleRoot, path) !== main)
  .map(path => ({ type: 'ESModule', path: resolve(moduleRoot, path) }))];
const mf = new Miniflare({
  ...workerOptions, modules, modulesRoot: moduleRoot,
  // Discard any .dev.vars discovered by Wrangler: tests only use explicit fixtures.
  bindings: { HOMEWORK_GRADING_ENABLED: 'true', HOMEWORK_AUTO_PUBLISH_ENABLED: 'false', ...vars },
  host: '127.0.0.1', port: Number(portValue), cf: false,
  d1Persist: join(persist, 'v3/d1'), r2Persist: join(persist, 'v3/r2'),
  durableObjectsPersist: join(persist, 'v3/do'), cachePersist: join(persist, 'v3/cache'),
  log: new Log(LogLevel.INFO),
});
let closing = false;
async function close() { if (closing) return; closing = true; await mf.dispose(); process.exit(0); }
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
await mf.ready;
console.log(`Local compiled Worker ready on http://127.0.0.1:${portValue}`);
