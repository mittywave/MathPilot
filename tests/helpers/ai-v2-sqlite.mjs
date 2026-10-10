import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
/** Actual SQLite SQL/constraints/rollback, wrapped with the D1 method shape.
 * Separate Worker/browser tests exercise Cloudflare's actual local D1 binding. */
export function sqliteD1({v2 = true} = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON;');
  sqlite.exec(readFileSync('migrations/0014_ai_provider_config.sql', 'utf8'));
  if(v2) sqlite.exec(readFileSync('migrations/0015_ai_provider_center_v2.sql', 'utf8'));
  const db = {sqlite, failNextBatch: false, beforeBatch: null,
    prepare(sql) { let args=[]; const statement = {
      bind(...values) { args=values; return statement; },
      async first() { return sqlite.prepare(sql).get(...args) || null; },
      async all() { return {success:true, results:sqlite.prepare(sql).all(...args)}; },
      async run() { const result=sqlite.prepare(sql).run(...args); return {success:true, meta:{changes:result.changes}}; },
      execute() { const s=sqlite.prepare(sql); const results=s.columns().length ? s.all(...args) : (s.run(...args), []); return {success:true,results}; },
    }; return statement; },
    async batch(statements) { if(db.beforeBatch) await db.beforeBatch(); sqlite.exec('BEGIN'); try { const results=statements.map(s=>s.execute()); if(db.failNextBatch){db.failNextBatch=false;throw new Error('injected rollback');} sqlite.exec('COMMIT');return results; } catch(e) {sqlite.exec('ROLLBACK');throw e;} },
  }; return db;
}
export async function legacyCipher(secret, text) {
  const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(secret));
  const key=await crypto.subtle.importKey('raw',digest,'AES-GCM',false,['encrypt']);
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const data=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(text));
  return JSON.stringify({v:1,iv:Buffer.from(iv).toString('base64'),data:Buffer.from(data).toString('base64')});
}
export function insertLegacy(db,cipher,{enabled=1,recognition='Vision-A',text='',diagram='',grading='',wire='auto',base='https://fixture.invalid/prefix',catalog=[]}={}) {
  db.sqlite.prepare('INSERT INTO ai_provider_config VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('global','Legacy',base,cipher,wire,JSON.stringify(catalog),recognition,text,diagram,grading,enabled,123456);
}
