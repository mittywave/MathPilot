import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
/** Read the real D1 backing database, never spin up a second workerd while the
 * tested Worker owns it. No writes, no mocks, no retry or weakened assertions. */
export function localD1Rows(persistTo, sql, parameters = []) {
    const root = join(persistTo, 'v3', 'd1');
    const candidates = readdirSync(root, { recursive: true }).filter(p => String(p).endsWith('.sqlite'));
    for (const path of candidates) {
        const db = new DatabaseSync(join(root, String(path)), { readOnly: true });
        try {
            db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=3000;');
            if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='homework_assignments'").get()) continue;
            return db.prepare(sql).all(...parameters);
        } finally { db.close(); }
    }
    throw new Error('The real local D1 homework database was not found.');
}
