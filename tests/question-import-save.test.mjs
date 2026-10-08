import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { saveQuestionImportBatch } from '../lib/question-import-save.mjs';

test('partial imports settle every request and retry only unsuccessful drafts', async () => {
  const drafts = Array.from({ length: 20 }, (_, id) => ({ id }));
  const calls = []; let active = 0; let maxActive = 0;
  const first = await saveQuestionImportBatch(drafts, async draft => {
    calls.push(draft.id); active++; maxActive = Math.max(maxActive, active);
    try { await delay(draft.id === 0 ? 1 : 5); if (draft.id === 0) throw Error('暂时失败'); return { ...draft, stored: true }; }
    finally { active--; }
  });
  assert.equal(active, 0, 'in-flight successes must finish before retry becomes available');
  assert.equal(maxActive, 3);
  assert.deepEqual(first.saved.map(x => x.draft.id), drafts.slice(1).map(x => x.id));
  assert.deepEqual(first.failed, [{ draft: drafts[0], error: '暂时失败' }]);
  const retry = await saveQuestionImportBatch(first.failed.map(x => x.draft), async draft => { calls.push(draft.id); return draft; });
  assert.equal(retry.saved.length, 1); assert.equal(retry.failed.length, 0);
  assert.deepEqual(calls, [...drafts.map(x => x.id), 0]);
});

test('successful and empty imports preserve draft order without duplicating saves', async () => {
  const drafts = [{ id: 'formula' }, { id: 'table' }, { id: 'image' }];
  const result = await saveQuestionImportBatch(drafts, async draft => { await delay(draft.id === 'formula' ? 10 : 1); return draft; }, 2);
  assert.deepEqual(result.saved.map(x => x.question), drafts);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(await saveQuestionImportBatch([], () => { throw Error('must not run'); }), { saved: [], failed: [] });
});

test('all failed imports stay retryable and invalid concurrency cannot drop drafts', async () => {
  const drafts = [1, 2, 3];
  const result = await saveQuestionImportBatch(drafts, async () => { throw 'network failure'; }, 0);
  assert.deepEqual(result.saved, []);
  assert.deepEqual(result.failed.map(x => x.draft), drafts);
  assert.equal((await saveQuestionImportBatch(drafts, async x => x, NaN)).saved.length, 3);
});
