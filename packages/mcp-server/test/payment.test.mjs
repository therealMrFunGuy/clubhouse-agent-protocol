/**
 * Paying a 402, and the ways that must not go wrong.
 *
 * ## Why this suite exists
 *
 * This server told operators it "signs payments" and could not pay for
 * anything. Five agent wallets reached the paywall through it and every one
 * left. So these tests cover the happy path — but the ones that matter are the
 * refusals, because this is the first code in the package that moves an
 * operator's real money.
 *
 * The API client is exercised against a fake `fetch`, so the assertions are
 * about what actually goes on the wire and how many times, not about file text.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ClubhouseApi, PaymentRequiredError } from '../dist/api.js';

/** A 402 that carries a challenge, then whatever the server says next. */
function fakeFetch(script) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {}, method: init?.method });
    const next = script.shift();
    if (!next) throw new Error('fake fetch ran out of scripted responses');
    return {
      status: next.status,
      // The client branches on `ok`, as the real Response does. Omitting it
      // made a scripted 200 look like a failure — the fake, not the code.
      ok: next.status >= 200 && next.status < 300,
      headers: { get: (n) => (next.headers ?? {})[n.toLowerCase()] ?? null },
      text: async () => JSON.stringify(next.body ?? {}),
      json: async () => next.body ?? {},
    };
  };
  fn.calls = calls;
  return fn;
}

const CHALLENGE = { 'payment-required': 'eyJ4NDAyVmVyc2lvbiI6Mn0=' };

/** A payer that always succeeds, recording how often it was asked. */
function okPayer() {
  const p = {
    address: '0xPayer',
    calls: 0,
    async headersFor() {
      p.calls += 1;
      return { 'PAYMENT-SIGNATURE': 'signed-payload' };
    },
  };
  return p;
}

/** A payer that refuses — over the cap, wrong asset, unsupported scheme. */
function refusingPayer() {
  return { address: '0xPayer', async headersFor() { return null; } };
}

test('a 402 is paid and the call is retried exactly once', async () => {
  const fetchImpl = fakeFetch([
    { status: 402, headers: CHALLENGE },
    { status: 200, body: { status: 'queued' } },
  ]);
  const payer = okPayer();
  const api = new ClubhouseApi({ payer, fetchImpl });

  const out = await api.post('/v1/matchmaking/queue', { game: 'chess' });

  assert.equal(out.status, 'queued');
  assert.equal(fetchImpl.calls.length, 2, 'exactly two requests: the probe and the paid retry');
  assert.equal(payer.calls, 1, 'the payer was asked once');
  // The retry must actually carry the signature, or we paid for nothing.
  assert.equal(fetchImpl.calls[1].headers['PAYMENT-SIGNATURE'], 'signed-payload');
  // ...and the first must NOT have.
  assert.equal(fetchImpl.calls[0].headers['PAYMENT-SIGNATURE'], undefined);
});

test('NEVER pays twice — a second 402 is not re-paid', async () => {
  // The wallet-draining case. A server that answers 402 to everything must cost
  // the operator one signature, not one per retry until the balance is gone.
  const fetchImpl = fakeFetch([
    { status: 402, headers: CHALLENGE },
    { status: 402, headers: CHALLENGE },
  ]);
  const payer = okPayer();
  const api = new ClubhouseApi({ payer, fetchImpl });

  await assert.rejects(
    () => api.post('/v1/matchmaking/queue', { game: 'chess' }),
    (e) => e instanceof PaymentRequiredError,
  );
  assert.equal(payer.calls, 1, 'signed once, not once per attempt');
  assert.equal(fetchImpl.calls.length, 2, 'stopped after the paid retry');
});

test('a refused challenge is reported, not retried', async () => {
  // Over the spend cap, or an asset this wallet may not spend. Retrying
  // unpaid would just burn the call; the operator needs to know why.
  const fetchImpl = fakeFetch([{ status: 402, headers: CHALLENGE }]);
  const api = new ClubhouseApi({ payer: refusingPayer(), fetchImpl });

  await assert.rejects(
    () => api.post('/v1/matchmaking/queue', { game: 'chess' }),
    (e) => e instanceof PaymentRequiredError && /over CLUBHOUSE_MAX_PAYMENT_USD/.test(e.message),
  );
  assert.equal(fetchImpl.calls.length, 1, 'no retry when the challenge cannot be satisfied');
});

test('with NO payer, the error tells the operator how to enable paying', async () => {
  // The old message said "fund this call from a wallet holding USDC on Base",
  // which is true and useless: the wallet was already funded and the server
  // still could not pay. Name the switch.
  const fetchImpl = fakeFetch([{ status: 402, headers: CHALLENGE }]);
  const api = new ClubhouseApi({ fetchImpl });

  await assert.rejects(
    () => api.post('/v1/matchmaking/queue', { game: 'chess' }),
    (e) => e instanceof PaymentRequiredError && /CLUBHOUSE_AGENT_PRIVATE_KEY/.test(e.message),
  );
  assert.equal(fetchImpl.calls.length, 1);
});

test('a funded payer that still gets 402 is told the balance may be short', async () => {
  const fetchImpl = fakeFetch([
    { status: 402, headers: CHALLENGE },
    { status: 402, headers: CHALLENGE },
  ]);
  const api = new ClubhouseApi({ payer: okPayer(), fetchImpl });

  await assert.rejects(
    () => api.post('/v1/matchmaking/queue', { game: 'chess' }),
    (e) => /short of USDC|price changed/.test(e.message),
  );
});

test('a free route is never offered a payment', async () => {
  // Paying for something that was never priced is money handed over for
  // nothing. Only a 402 may trigger the payer.
  const fetchImpl = fakeFetch([{ status: 200, body: { games: [] } }]);
  const payer = okPayer();
  const api = new ClubhouseApi({ payer, fetchImpl });

  await api.get('/v1/games');
  assert.equal(payer.calls, 0);
});
