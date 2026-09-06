import assert from 'node:assert/strict';
import test from 'node:test';

import { PersistentVoteQueue, hasUsableImageUrl, normalizeRow, prepareRows } from '../app.js';

function memoryStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    value(key) { return values.get(key); },
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('only rows with usable HTTP(S) image URLs enter the model deck and counts', () => {
  const input = [
    { Kimlik: 'a', Model: 'Visible', 'Görsel URL': 'https://images.example/a.jpg' },
    { Kimlik: 'b', Model: 'Missing', 'Görsel URL': '' },
    { Kimlik: 'c', Model: 'Placeholder', 'Görsel URL': 'görsel yok' },
    { Kimlik: 'd', Model: 'Unsafe', 'Görsel URL': 'javascript:alert(1)' },
    { Kimlik: 'e', Model: 'Malformed', 'Görsel URL': 'not a url' },
  ];
  const result = prepareRows(input);
  assert.deepEqual(result.rows.map((row) => row.id), ['a']);
  assert.equal(result.sourceCount, 5);
  assert.equal(result.excludedCount, 4);
  assert.equal(hasUsableImageUrl('http://example.test/image.png'), true);
  assert.equal(hasUsableImageUrl('https://drive.google.com/thumbnail?id=abc&sz=w400'), true);
  assert.equal(hasUsableImageUrl('https://'), false);
});

test('frontend calculates cost-based markup without changing the Sheet schema', () => {
  const row = normalizeRow({ Kimlik: 'markup', Model: 'Markup test', 'Maliyet TL/adet': '10', 'Satış fiyatı TL': '20', 'Net kâr TL': '10', Marj: '50%' }, 0);
  assert.equal(row.markup, 100);
});

test('enqueue is immediate, durable, and does not wait for the network write', async () => {
  const storage = memoryStorage();
  let release;
  const send = () => new Promise((resolve) => { release = resolve; });
  const queue = new PersistentVoteQueue({ storage, send });
  const operation = queue.enqueue({ mode: 'personal', participant: 'Ada', id: 'm1', vote: 'like' });
  assert.equal(operation.payload.vote, 'like');
  assert.equal(JSON.parse(storage.value('print-lab-write-queue-v2')).length, 1);
  assert.equal(queue.snapshot().total, 1);
  await tick();
  release({ ok: true });
  await tick();
  assert.equal(queue.snapshot().total, 0);
});

test('offline queue deduplicates the latest vote for one participant and model', () => {
  const storage = memoryStorage();
  const queue = new PersistentVoteQueue({ storage, send: async () => {} });
  queue.setOnline(false);
  queue.enqueue({ mode: 'personal', participant: 'Ada', id: 'm1', vote: 'like' });
  queue.enqueue({ mode: 'personal', participant: 'Ada', id: 'm1', vote: 'dislike' });
  assert.equal(queue.snapshot().total, 1);
  assert.equal(queue.snapshot().items[0].payload.vote, 'dislike');
});

test('server readback clears queue entries already reflected in the Sheet', () => {
  const storage = memoryStorage();
  const queue = new PersistentVoteQueue({ storage, send: async () => {}, });
  queue.setOnline(false);
  queue.enqueue({ mode: 'personal', participant: 'Ada', id: 'm1', vote: 'like' });
  queue.enqueue({ action: 'undo', mode: 'personal', participant: 'Ada', id: 'm2' });
  queue.reconcileVotes({ m1: 'like' });
  assert.equal(queue.snapshot().total, 0);
});

test('a failed write remains persisted and is safely retried after reload', async () => {
  const storage = memoryStorage();
  const permanent = new Error('rejected'); permanent.retryable = false;
  const queue = new PersistentVoteQueue({ storage, send: async () => { throw permanent; } });
  queue.enqueue({ mode: 'personal', participant: 'Ada', id: 'm2', vote: 'like' });
  await tick(); await tick();
  assert.equal(queue.snapshot().failed, 1);
  assert.equal(JSON.parse(storage.value('print-lab-write-queue-v2'))[0].status, 'failed');

  let writes = 0;
  const restored = new PersistentVoteQueue({ storage, send: async () => { writes += 1; } });
  assert.equal(restored.snapshot().pending, 1);
  await restored.pump(); await tick();
  assert.equal(writes, 1);
  assert.equal(restored.snapshot().total, 0);
});

test('retry uses exponential backoff and keeps the operation id stable', async () => {
  const storage = memoryStorage();
  let now = 100;
  let scheduled;
  const seen = [];
  const queue = new PersistentVoteQueue({
    storage,
    now: () => now,
    random: () => 0,
    schedule: (callback, delay) => { scheduled = { callback, delay }; return 1; },
    send: async (payload) => { seen.push(payload.operationId); if (seen.length === 1) throw new Error('temporary'); },
  });
  queue.enqueue({ mode: 'shared', participant: '', id: 'm3', vote: 'like' });
  await tick(); await tick();
  assert.equal(scheduled.delay, 1000);
  assert.equal(queue.snapshot().pending, 1);
  now += 1000; scheduled.callback();
  await tick(); await tick();
  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1]);
  assert.equal(queue.snapshot().total, 0);
});
