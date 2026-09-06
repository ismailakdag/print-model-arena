import assert from 'node:assert/strict';
import test from 'node:test';

const originalEnv = { ...process.env };

function responseMock() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    json(body) { this.body = body; return this; },
  };
}

async function loadHandler() {
  return (await import(`../api/rate.js?test=${Date.now()}-${Math.random()}`)).default;
}

test.afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  globalThis.fetch = undefined;
});

test('status reports exactly which non-secret proxy settings are missing', async () => {
  delete process.env.SHEET_WRITE_URL;
  delete process.env.SHEET_WRITE_SECRET;
  const handler = await loadHandler();
  const res = responseMock();
  await handler({ method: 'GET', query: { status: '1' } }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'proxy_not_configured');
  assert.deepEqual(res.body.config, { endpointConfigured: false, secretConfigured: false });
  assert.ok(!JSON.stringify(res.body).includes('test-secret'));
});

test('status verifies the Apps Script contract without exposing credentials', async () => {
  process.env.SHEET_WRITE_URL = 'https://script.google.com/macros/s/deployment/exec';
  process.env.SHEET_WRITE_SECRET = 'test-secret';
  globalThis.fetch = async (url) => {
    assert.match(String(url), /action=status/);
    assert.match(String(url), /secret=test-secret/);
    return { ok: true, status: 200, async text() { return JSON.stringify({ ok: true, service: 'sheet-write' }); } };
  };
  const handler = await loadHandler();
  const res = responseMock();
  await handler({ method: 'GET', query: { status: '1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.upstream.status, 'ok');
  assert.ok(!JSON.stringify(res.body).includes('test-secret'));
});

test('upstream failures have a precise safe diagnostic', async () => {
  process.env.SHEET_WRITE_URL = 'https://script.google.com/macros/s/deployment/exec';
  process.env.SHEET_WRITE_SECRET = 'test-secret';
  globalThis.fetch = async () => { throw new Error('network detail must not leak'); };
  const handler = await loadHandler();
  const res = responseMock();
  await handler({ method: 'POST', body: { mode: 'personal', participant: 'tester', id: 'm1', vote: 'like' } }, res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.code, 'upstream_unreachable');
  assert.match(res.body.message, /Apps Script/);
  assert.ok(!JSON.stringify(res.body).includes('network detail'));
});

test('personal undo payload reaches Apps Script without requiring a vote value', async () => {
  process.env.SHEET_WRITE_URL = 'https://script.google.com/macros/s/deployment/exec';
  process.env.SHEET_WRITE_SECRET = 'test-secret';
  globalThis.fetch = async (url, options) => {
    const payload = JSON.parse(options.body);
    assert.equal(payload.action, 'undo');
    assert.equal(payload.vote, undefined);
    assert.equal(payload.mode, 'personal');
    return { ok: true, status: 200, async text() { return JSON.stringify({ ok: true, undone: true }); } };
  };
  const handler = await loadHandler();
  const res = responseMock();
  await handler({ method: 'POST', body: { action: 'undo', mode: 'personal', participant: 'tester', id: 'm1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.undone, true);
});

test('optimistic queue contract forwards operation id and contract version', async () => {
  process.env.SHEET_WRITE_URL = 'https://script.google.com/macros/s/deployment/exec';
  process.env.SHEET_WRITE_SECRET = 'test-secret';
  globalThis.fetch = async (url, options) => {
    const payload = JSON.parse(options.body);
    assert.equal(payload.operationId, 'op-123');
    assert.equal(payload.contractVersion, 2);
    assert.equal(payload.secret, 'test-secret');
    return { ok: true, status: 200, async text() { return JSON.stringify({ ok: true, operationId: payload.operationId }); } };
  };
  const handler = await loadHandler();
  const res = responseMock();
  await handler({ method: 'POST', body: { mode: 'personal', participant: 'tester', id: 'm1', vote: 'like', operationId: 'op-123' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.operationId, 'op-123');
});

test('oversized queue identifiers are rejected without an upstream write', async () => {
  process.env.SHEET_WRITE_URL = 'https://script.google.com/macros/s/deployment/exec';
  process.env.SHEET_WRITE_SECRET = 'test-secret';
  globalThis.fetch = async () => { throw new Error('must not be called'); };
  const handler = await loadHandler();
  const res = responseMock();
  await handler({ method: 'POST', body: { mode: 'personal', participant: 'x'.repeat(41), id: 'm1', vote: 'like' } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'payload_too_long');
});

test('shared writes are disabled without contacting Apps Script', async () => {
  process.env.SHEET_WRITE_URL = 'https://script.google.com/macros/s/deployment/exec';
  process.env.SHEET_WRITE_SECRET = 'test-secret';
  globalThis.fetch = async () => { throw new Error('must not be called'); };
  const handler = await loadHandler();
  const res = responseMock();
  await handler({ method: 'POST', body: { mode: 'shared', id: 'm1', vote: 'dislike', operationId: 'op-locked' } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'invalid_vote_payload');
});

test('malformed JSON is rejected before contacting the upstream', async () => {
  process.env.SHEET_WRITE_URL = 'https://script.google.com/macros/s/deployment/exec';
  process.env.SHEET_WRITE_SECRET = 'test-secret';
  globalThis.fetch = async () => { throw new Error('must not be called'); };
  const handler = await loadHandler();
  const res = responseMock();
  await handler({ method: 'POST', body: '{not-json' }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'invalid_json');
});
