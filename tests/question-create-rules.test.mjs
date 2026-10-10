import assert from 'node:assert/strict';
import test from 'node:test';
import { questionCreationContent } from '../lib/question-create-rules.mjs';

const question = { id: 'import-id', stem: '计算 $\\frac{3}{4}$', options: ['1', '2'], answer: 'B', analysis: '保持原解析', stemDocxXml: ['<w:p/>'], createdAt: 1, updatedAt: 1 };

test('creation retries ignore server metadata and object order, preserving user content', () => {
  const retry = { ...question, code: '0001', updatedAt: 99, createdAt: 5, createdBy: 'local-admin', canEdit: true, createdByEmail: 'localhost', taxonomyKeys: ['inferred'] };
  assert.equal(questionCreationContent(question), questionCreationContent(retry));
  assert.equal(questionCreationContent({ ...question, assets: { b: 2, a: 1 } }), questionCreationContent({ ...retry, assets: { a: 1, b: 2 } }));
});

test('an existing ID with different text, answers, options or Word structure must conflict', () => {
  for (const change of [{ stem: '另一题' }, { answer: 'A' }, { analysis: '另一解析' }, { options: ['2', '1'] }, { stemDocxXml: ['<w:tbl/>'] }]) {
    assert.notEqual(questionCreationContent(question), questionCreationContent({ ...question, ...change }));
  }
});

test('identical image bytes may use different asset IDs during concurrent creation', () => {
  const a = '11111111-1111-1111-1111-111111111111';
  const b = '22222222-2222-2222-2222-222222222222';
  const hash = new Map([[a, 'same-image-sha256'], [b, 'same-image-sha256']]);
  const first = { ...question, contentImages: [`/api/assets/${a}`], stemDocxAssets: { rId1: { dataUrl: `/api/assets/${a}` } } };
  const retry = { ...question, contentImages: [`/api/assets/${b}`], stemDocxAssets: { rId1: { dataUrl: `/api/assets/${b}` } } };
  assert.equal(questionCreationContent(first, hash), questionCreationContent(retry, hash));
  hash.set(b, 'different-image-sha256');
  assert.notEqual(questionCreationContent(first, hash), questionCreationContent(retry, hash));
});
