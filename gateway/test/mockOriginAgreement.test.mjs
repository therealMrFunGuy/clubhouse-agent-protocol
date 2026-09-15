/**
 * The mock origin must agree with the gateway about what a valid envelope is.
 *
 * SECURITY.md sends researchers to `scripts/mock-origin.mjs` as the verifying
 * half of the trust boundary, and says a disagreement between it and the real
 * origin is itself a finding. One was reported: the gateway (and the real
 * origin) append sha256(voucher) to the canonical string for a metered move,
 * and the mock did not. Two consequences, both tested below —
 *
 *  - a genuinely signed voucher move was rejected, so the channel path could
 *    not be exercised locally at all; and
 *  - a voucher header ADDED to an envelope signed without one was accepted, so
 *    the mock taught the opposite of the real binding.
 *
 * These drive the real signer (`forwardToOrigin`) against the real mock over
 * HTTP rather than re-deriving either side, so the test cannot agree with
 * itself.
 *
 *   cd gateway && node --test test/mockOriginAgreement.test.mjs
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonicalString, forwardToOrigin } from '../src/origin.ts';

const MOCK = fileURLToPath(new URL('../../scripts/mock-origin.mjs', import.meta.url));
const SECRET = 'a'.repeat(64);
const PORT = 20_000 + Math.floor(Math.random() * 30_000);
const BASE = `http://127.0.0.1:${PORT}`;
const MOVE = '/chess/1/move';
const VOUCHER = JSON.stringify({ channelId: '0xchannel', maxClaimableAmount: '500', signature: '0xsig' });

let mock;

before(async () => {
  mock = spawn(process.execPath, [MOCK], {
    env: { ...process.env, PORT: String(PORT), AGENT_GATEWAY_HMAC_SECRET: SECRET },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    mock.stdout.on('data', (d) => String(d).includes('mock origin on') && resolve());
    mock.on('exit', (code) => reject(new Error(`mock origin exited early (${code})`)));
  });
});

after(() => mock?.kill());

const env = { ORIGIN_HMAC_SECRET: SECRET, ORIGIN_BASE_URL: BASE };
const identity = { wallet: '0x00000000000000000000000000000000000000a1', keyId: null, tier: 'ranked' };
const move = { from: 'e2', to: 'e4' };

test('an unmetered move the gateway signs is accepted (control)', async () => {
  const res = await forwardToOrigin(env, { method: 'POST', path: MOVE, body: move, identity });
  assert.equal(res.status, 200);
});

test('a voucher move the gateway signs is accepted', async () => {
  const res = await forwardToOrigin(env, { method: 'POST', path: MOVE, body: move, identity, voucher: VOUCHER });
  assert.equal(res.status, 200, 'the mock must hash the voucher into the string it verifies');
});

test('a voucher header added to an envelope signed without one is rejected', async () => {
  // Sign exactly as the gateway does for an UNMETERED move, then attach a
  // voucher nobody signed. The real origin appends a line that was never in
  // the signature and refuses; a verifier that ignores the header accepts.
  const body = JSON.stringify(move);
  const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const signature = createHmac('sha256', SECRET)
    .update(canonicalString({
      timestamp, nonce, method: 'POST', path: MOVE, bodyHash: sha(body),
      wallet: identity.wallet, chainId: '', paymentHash: '',
    }))
    .digest('hex');

  const res = await fetch(`${BASE}/api/internal/agent/v1${MOVE}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-cap-timestamp': timestamp,
      'x-cap-nonce': nonce,
      'x-cap-signature': signature,
      'x-cap-wallet': identity.wallet,
      'x-cap-voucher': VOUCHER,
    },
    body,
  });
  assert.equal(res.status, 401);
});
