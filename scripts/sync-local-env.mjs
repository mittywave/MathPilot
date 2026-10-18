import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const localPath = resolve(".env.local");
const workerPath = resolve(".dev.vars");

function readEnvironment(path) {
  if (!existsSync(path)) return new Map();
  const values = new Map();
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match) values.set(match[1], match[2]);
  }
  return values;
}

const workerValues = readEnvironment(workerPath);
const localValues = readEnvironment(localPath);
const merged = new Map([...workerValues, ...localValues]);
merged.set("LOCAL_ADMIN_MODE", "true");
if (!merged.size) process.exit(0);

const content = `${[...merged].map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
// Replacing this watched file restarts the running Worker and aborts its requests.
if (existsSync(workerPath) && readFileSync(workerPath, "utf8") === content) {
  if ((statSync(workerPath).mode & 0o777) !== 0o600) chmodSync(workerPath, 0o600);
  process.stdout.write("本地 Worker 配置未变化，跳过写入。\n");
  process.exit(0);
}

const temporaryPath = `${workerPath}.tmp-${process.pid}`;
writeFileSync(temporaryPath, content, { mode: 0o600 });
renameSync(temporaryPath, workerPath);
chmodSync(workerPath, 0o600);
process.stdout.write(`已同步 ${merged.size} 项本地 Worker 配置。\n`);
