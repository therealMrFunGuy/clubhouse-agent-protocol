/**
 * The authorizer's one refusal.
 *
 * These are money tests, and they are specifically tests of a PUBLISHED claim.
 * Four public documents state that our authorizer "is refused the ability to
 * sign a refund — not by policy, by code that never reaches the key". Until
 * recently that code lived only in the private platform repo, which SECURITY.md
 * puts out of scope, so nobody outside could see it, install it or check it.
 * These tests exist so the claim is falsifiable by anyone who runs
 *
 *   node --test test/*.test.mjs
 *
 * `refundWithSignature` takes no payer signature: a key that can sign `Refund`
 * can empty every channel. That is what is being refused.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  localAuthorizerSigner,
  remoteAuthorizerSigner,
  claimsOnly,
  RefundRefused,
  ALLOWED_PRIMARY_TYPES,
  REFUSED_PRIMARY_TYPES,
} from '../dist/signer.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const SIGNATURE = `0x${'ab'.repeat(65)}`;
const CHANNEL_ID = `0x${'11'.repeat(32)}`;

const DOMAIN = {
  name: 'x402 Batch Settlement',
  version: '1',
  chainId: 8453,
  verifyingContract: '0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003',
};

const claimBatchTypes = {
  ClaimBatch: [{ name: 'claims', type: 'ClaimEntry[]' }],
  ClaimEntry: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'maxClaimableAmount', type: 'uint128' },
    { name: 'totalClaimed', type: 'uint128' },
  ],
};

const refundTypes = {
  Refund: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'amount', type: 'uint128' },
  ],
};

const claimRequest = () => ({
  domain: DOMAIN,
  types: claimBatchTypes,
  primaryType: 'ClaimBatch',
  // BigInt, exactly as @x402/evm's signClaimBatch builds it.
  message: { claims: [{ channelId: CHANNEL_ID, maxClaimableAmount: 1000n, totalClaimed: 0n }] },
});

const refundRequest = () => ({
  domain: DOMAIN,
  types: refundTypes,
  primaryType: 'Refund',
  message: { channelId: CHANNEL_ID, nonce: 0n, amount: 1000n },
});

/** A stand-in for the thing holding the key. Records whether it was reached. */
function spyAccount() {
  const calls = [];
  return {
    calls,
    address: ADDRESS,
    async signTypedData(params) {
      calls.push(params);
      return SIGNATURE;
    },
  };
}

/** Replaces global fetch so no test can touch the network. Returns the calls. */
function captureFetch(response = { signature: SIGNATURE, address: ADDRESS }) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      json: async () => response,
    };
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// ── The published constants ─────────────────────────────────────────────────

test('the package exports an allow-list containing only ClaimBatch', () => {
  assert.deepEqual([...ALLOWED_PRIMARY_TYPES], ['ClaimBatch']);
  assert.ok(REFUSED_PRIMARY_TYPES.has('Refund'));
});

// ── localAuthorizerSigner ───────────────────────────────────────────────────

test('localAuthorizerSigner refuses Refund', async () => {
  const account = spyAccount();
  const signer = localAuthorizerSigner(account);

  await assert.rejects(() => signer.signTypedData(refundRequest()), RefundRefused);
  // The point is not that it throws. The point is that the key never saw it.
  assert.equal(account.calls.length, 0, 'the refused request must never reach the key');
});

test('localAuthorizerSigner still signs a claim', async () => {
  const account = spyAccount();
  const signer = localAuthorizerSigner(account);

  assert.equal(await signer.signTypedData(claimRequest()), SIGNATURE);
  assert.equal(account.calls.length, 1);
  assert.equal(account.calls[0].primaryType, 'ClaimBatch');
});

test('localAuthorizerSigner refuses an unrecognised type, not just Refund', async () => {
  // Allow-list, not deny-list: a message type the contract gains later must be
  // refused by default rather than signed because nobody blacklisted it.
  const account = spyAccount();
  const signer = localAuthorizerSigner(account);

  await assert.rejects(
    () => signer.signTypedData({ ...refundRequest(), primaryType: 'SomeFutureSweep' }),
    /will not sign the unrecognised type/,
  );
  assert.equal(account.calls.length, 0);
});

test('localAuthorizerSigner exposes the wrapped address unchanged', () => {
  assert.equal(localAuthorizerSigner(spyAccount()).address, ADDRESS);
});

// ── remoteAuthorizerSigner ──────────────────────────────────────────────────

test('remoteAuthorizerSigner refuses Refund without making a request', async () => {
  const fetchSpy = captureFetch();
  try {
    const signer = remoteAuthorizerSigner({
      url: 'http://127.0.0.1:8402/sign',
      address: ADDRESS,
      token: 'x'.repeat(32),
    });

    await assert.rejects(() => signer.signTypedData(refundRequest()), RefundRefused);
    // No socket opened means no bearer token left this process and nothing
    // reached whatever holds the key. That is the property being claimed.
    assert.equal(fetchSpy.calls.length, 0, 'a refused request must never become an HTTP request');
  } finally {
    fetchSpy.restore();
  }
});

test('remoteAuthorizerSigner refuses an unrecognised type without making a request', async () => {
  const fetchSpy = captureFetch();
  try {
    const signer = remoteAuthorizerSigner({
      url: 'http://127.0.0.1:8402/sign',
      address: ADDRESS,
      token: 'x'.repeat(32),
    });

    await assert.rejects(
      () => signer.signTypedData({ ...claimRequest(), primaryType: 'Voucher' }),
      /will not sign the unrecognised type/,
    );
    assert.equal(fetchSpy.calls.length, 0);
  } finally {
    fetchSpy.restore();
  }
});

test('remoteAuthorizerSigner forwards a claim and returns the signature', async () => {
  const fetchSpy = captureFetch();
  try {
    const signer = remoteAuthorizerSigner({
      url: 'http://127.0.0.1:8402/sign',
      address: ADDRESS,
      token: 'x'.repeat(32),
    });

    assert.equal(await signer.signTypedData(claimRequest()), SIGNATURE);
    assert.equal(fetchSpy.calls.length, 1);

    const sent = JSON.parse(fetchSpy.calls[0].init.body);
    assert.equal(sent.primaryType, 'ClaimBatch');
    assert.equal(sent.address, ADDRESS);
  } finally {
    fetchSpy.restore();
  }
});

test('remoteAuthorizerSigner serialises bigint amounts instead of throwing on them', async () => {
  // @x402/evm's signClaimBatch builds these with BigInt(), and JSON.stringify
  // throws on a bigint — so before this was fixed the remote path failed with
  // "Do not know how to serialize a BigInt" before it opened a socket, making
  // the whole out-of-process signer unusable.
  const fetchSpy = captureFetch();
  try {
    const signer = remoteAuthorizerSigner({
      url: 'http://127.0.0.1:8402/sign',
      address: ADDRESS,
      token: 'x'.repeat(32),
    });

    await signer.signTypedData(claimRequest());

    const sent = JSON.parse(fetchSpy.calls[0].init.body);
    assert.deepEqual(sent.message.claims[0], {
      channelId: CHANNEL_ID,
      maxClaimableAmount: '1000',
      totalClaimed: '0',
    });
  } finally {
    fetchSpy.restore();
  }
});

test('remoteAuthorizerSigner never sends the token in the body', async () => {
  const fetchSpy = captureFetch();
  try {
    const token = 'sekrit'.padEnd(32, 'x');
    const signer = remoteAuthorizerSigner({ url: 'https://signer.invalid/sign', address: ADDRESS, token });

    await signer.signTypedData(claimRequest());
    assert.ok(!fetchSpy.calls[0].init.body.includes(token));
    assert.equal(fetchSpy.calls[0].init.headers.authorization, `Bearer ${token}`);
  } finally {
    fetchSpy.restore();
  }
});

test('remoteAuthorizerSigner rejects a signature from an unexpected address', async () => {
  const fetchSpy = captureFetch({ signature: SIGNATURE, address: '0x2222222222222222222222222222222222222222' });
  try {
    const signer = remoteAuthorizerSigner({
      url: 'http://127.0.0.1:8402/sign',
      address: ADDRESS,
      token: 'x'.repeat(32),
    });
    await assert.rejects(() => signer.signTypedData(claimRequest()), /unexpected address/);
  } finally {
    fetchSpy.restore();
  }
});

test('remoteAuthorizerSigner refuses a non-loopback plaintext endpoint', () => {
  assert.throws(
    () => remoteAuthorizerSigner({ url: 'http://signer.example.com/sign', address: ADDRESS, token: 'x'.repeat(32) }),
    /must use HTTPS/,
  );
});

// ── claimsOnly itself ───────────────────────────────────────────────────────

test('claimsOnly is exported so a third party can wrap their own signer', async () => {
  const account = spyAccount();
  const guarded = claimsOnly(account);

  await assert.rejects(() => guarded.signTypedData(refundRequest()), RefundRefused);
  assert.equal(await guarded.signTypedData(claimRequest()), SIGNATURE);
  assert.equal(account.calls.length, 1);
});

test('the refusal survives double-wrapping', async () => {
  // localAuthorizerSigner already wraps; wrapping again must not re-open it.
  const account = spyAccount();
  const guarded = claimsOnly(localAuthorizerSigner(account));

  await assert.rejects(() => guarded.signTypedData(refundRequest()), RefundRefused);
  assert.equal(account.calls.length, 0);
});
