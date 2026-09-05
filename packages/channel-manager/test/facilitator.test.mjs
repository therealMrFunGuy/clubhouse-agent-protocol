/**
 * Facilitator service.
 *
 * This process authorises and broadcasts settlement, so its auth boundary and
 * input limits are the things worth testing. The scheme itself is x402's; what
 * is ours is who gets to reach it and what they can send.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createFacilitatorService } from '../dist/facilitator.js';

const TOKEN = 'x'.repeat(48);
const PORT = 8499;
const BASE = `http://127.0.0.1:${PORT}`;

// Records what reached the scheme, so we can prove auth ran *before* it.
const calls = [];
const scheme = {
  async verify(payload, requirements) {
    calls.push(['verify', payload, requirements]);
    return { isValid: true };
  },
  async settle(payload) {
    calls.push(['settle', payload]);
    return { success: true, transaction: '0xdeadbeef' };
  },
};

let svc;
before(async () => {
  svc = createFacilitatorService({ scheme, network: 'eip155:8453', authToken: TOKEN, port: PORT });
  await svc.listen();
});
after(async () => { await svc.close(); });

const post = (path, body, token) =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const VALID = { paymentPayload: { a: 1 }, paymentRequirements: { b: 2 } };

test('rejects a short auth token at construction', () => {
  assert.throws(
    () => createFacilitatorService({ scheme, network: 'eip155:8453', authToken: 'short' }),
    /at least 32/,
  );
});

test('/supported is open, so SDK initialize() can probe it', async () => {
  const res = await fetch(`${BASE}/supported`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.kinds[0].scheme, 'batch-settlement');
  assert.equal(body.kinds[0].network, 'eip155:8453');
});

test('unauthenticated settle is refused', async () => {
  calls.length = 0;
  const res = await post('/settle', VALID);
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0, 'auth must run before the scheme is touched');
});

test('a wrong token is refused', async () => {
  calls.length = 0;
  const res = await post('/settle', VALID, 'y'.repeat(48));
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test('a token of the wrong length is refused without throwing', async () => {
  // timingSafeEqual throws on length mismatch; that must be handled, not crash
  // the process — otherwise a one-byte token is a denial of service.
  const res = await post('/settle', VALID, 'z');
  assert.equal(res.status, 401);
});

test('a valid token reaches verify and settle', async () => {
  calls.length = 0;
  const v = await post('/verify', VALID, TOKEN);
  assert.equal(v.status, 200);
  assert.deepEqual(await v.json(), { isValid: true });

  const s = await post('/settle', VALID, TOKEN);
  assert.equal(s.status, 200);
  assert.equal((await s.json()).transaction, '0xdeadbeef');
  assert.deepEqual(calls.map((c) => c[0]), ['verify', 'settle']);
});

test('missing payment fields are rejected before the scheme runs', async () => {
  calls.length = 0;
  const res = await post('/settle', { paymentPayload: { a: 1 } }, TOKEN);
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test('malformed JSON is rejected cleanly', async () => {
  const res = await post('/verify', '{not json', TOKEN);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'Invalid JSON');
});

test('an oversized body is refused rather than buffered', async () => {
  const huge = JSON.stringify({ paymentPayload: { pad: 'A'.repeat(400_000) }, paymentRequirements: {} });
  const res = await post('/verify', huge, TOKEN);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'Body too large');
});

test('GET on a settlement route is refused', async () => {
  const res = await fetch(`${BASE}/settle`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 405);
});

test('unknown authenticated paths 404 without touching the scheme', async () => {
  calls.length = 0;
  const res = await post('/drain', VALID, TOKEN);
  assert.equal(res.status, 404);
  assert.equal(calls.length, 0);
});

test('a scheme failure does not leak internals to the caller', async () => {
  const port = PORT + 1;
  const boom = createFacilitatorService({
    scheme: {
      verify: async () => { throw new Error('channel 0xSECRET has balance 123456'); },
      settle: async () => ({}),
    },
    network: 'eip155:8453',
    authToken: TOKEN,
    port,
    onError: () => {},
  });
  await boom.listen(port);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(VALID),
    });
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.ok(!text.includes('SECRET'), 'internal detail leaked to the caller');
    assert.ok(!text.includes('123456'), 'channel balance leaked to the caller');
  } finally {
    await boom.close();
  }
});
