/**
 * Adversarial probes against the paper gateway.
 *
 * The smoke test proves the happy path works. These probe the controls that
 * only matter when someone is attacking: replay, tampering, clock games, and
 * paying once for two seats.
 */

import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { createHash } from 'node:crypto';

const GATEWAY = process.env.GATEWAY ?? 'http://127.0.0.1:8799';
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

function challengeString({ timestamp, nonce, method, path, bodyHash }) {
  return ['clubhouse-agent-v1', timestamp, nonce, method.toUpperCase(), path, bodyHash].join('\n');
}

/** Build the headers for a call WITHOUT sending it, so we can send it twice. */
async function sign(account, method, path, body, overrides = {}) {
  const rawBody = body === undefined ? '' : JSON.stringify(body);
  const timestamp = overrides.timestamp ?? String(Date.now());
  const nonce = overrides.nonce ?? `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const message = challengeString({
    timestamp, nonce, method, path, bodyHash: sha256(rawBody),
  });
  const signature = await account.signMessage({ message });
  return {
    rawBody,
    headers: {
      'content-type': 'application/json',
      'x-cap-agent-address': account.address,
      'x-cap-agent-timestamp': timestamp,
      'x-cap-agent-nonce': nonce,
      'x-cap-agent-signature': signature,
    },
  };
}

const send = (method, path, { rawBody, headers }) =>
  fetch(`${GATEWAY}${path}`, { method, headers, body: rawBody || undefined });

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

async function main() {
  const a = privateKeyToAccount(generatePrivateKey());
  const b = privateKeyToAccount(generatePrivateKey());

  console.log('\nReplay and tampering probes\n');

  // ── Replay: the same signed envelope, sent twice ──────────────────────────
  {
    const req = await sign(a, 'POST', '/v1/matchmaking/queue', { game: 'chess', variant: 'live' });
    const first = await send('POST', '/v1/matchmaking/queue', req);
    const second = await send('POST', '/v1/matchmaking/queue', req);
    check('first use of a signed envelope succeeds', first.status === 200, `got ${first.status}`);
    // The agent's nonce becomes the origin's replay key, so the second attempt
    // is refused downstream rather than being forwarded again under a fresh id.
    check('an identical replay is refused', second.status !== 200, `got ${second.status}`);
  }

  // ── Tampering: valid signature, altered body ──────────────────────────────
  {
    const req = await sign(b, 'POST', '/v1/matchmaking/queue', { game: 'chess', variant: 'live' });
    req.rawBody = JSON.stringify({ game: 'chess', variant: 'async' });
    const res = await send('POST', '/v1/matchmaking/queue', req);
    check('a body swapped after signing is refused', res.status === 401, `got ${res.status}`);
  }

  // ── Tampering: valid signature, different path ────────────────────────────
  {
    const req = await sign(b, 'GET', '/v1/chess/1', undefined);
    const res = await send('GET', '/v1/chess/999', req);
    check('a signature for one path is not valid for another', res.status === 401, `got ${res.status}`);
  }

  // ── Tampering: valid signature, query string appended ─────────────────────
  {
    // Audit finding: the agent's signature covered the pathname only, while the
    // gateway forwarded pathname+query under its own HMAC — so the origin
    // treated parameters the agent never signed as agent-authorised.
    const req = await sign(b, 'GET', '/v1/chess/1', undefined);
    const res = await send('GET', '/v1/chess/1?chain=base-mainnet', req);
    check('a query string appended after signing is refused', res.status === 401, `got ${res.status}`);
  }

  // ── Paper mode must still gate on the priced-route set ────────────────────
  {
    // Audit finding: the paper branch minted a synthetic receipt for ANY POST
    // under /v1/, so it did not model the paywall it exists to rehearse.
    const req = await sign(b, 'POST', '/v1/leaderboards/chess', {});
    const res = await send('POST', '/v1/leaderboards/chess', req);
    check('an unpriced POST is not granted a paper receipt', res.status === 404, `got ${res.status}`);
  }

  // ── Clock: a stale timestamp ──────────────────────────────────────────────
  {
    const old = String(Date.now() - 10 * 60 * 1000);
    const req = await sign(b, 'GET', '/v1/chess/1', undefined, { timestamp: old });
    const res = await send('GET', '/v1/chess/1', req);
    check('a stale signature is refused', res.status === 401, `got ${res.status}`);
  }

  // ── Clock: a far-future timestamp, held for later use ─────────────────────
  {
    const future = String(Date.now() + 10 * 60 * 1000);
    const req = await sign(b, 'GET', '/v1/chess/1', undefined, { timestamp: future });
    const res = await send('GET', '/v1/chess/1', req);
    check('a far-future signature is refused', res.status === 401, `got ${res.status}`);
  }

  // ── One payment, two seats ────────────────────────────────────────────────
  {
    // Same nonce, two DIFFERENT requests. The payment nonce is derived from the
    // agent's nonce, so reusing it must not buy a second seat.
    const nonce = `dup-${Date.now()}`;
    const c = privateKeyToAccount(generatePrivateKey());
    const first = await send('POST', '/v1/matchmaking/queue',
      await sign(c, 'POST', '/v1/matchmaking/queue', { game: 'chess', variant: 'live' }, { nonce }));
    const second = await send('POST', '/v1/matchmaking/queue',
      await sign(c, 'POST', '/v1/matchmaking/queue', { game: 'chess', variant: 'async' }, { nonce }));
    check('one payment nonce cannot buy two seats', !(first.status === 200 && second.status === 200),
      `${first.status} then ${second.status}`);
  }

  // ── Self-play: an agent must not be paired with itself ────────────────────
  {
    const solo = privateKeyToAccount(generatePrivateKey());
    const first = await send('POST', '/v1/matchmaking/queue',
      await sign(solo, 'POST', '/v1/matchmaking/queue', { game: 'chess', variant: 'live' }));
    const firstBody = await first.json();
    const second = await send('POST', '/v1/matchmaking/queue',
      await sign(solo, 'POST', '/v1/matchmaking/queue', { game: 'chess', variant: 'live' }));
    const secondBody = await second.json();
    check('an agent is never matched against itself',
      secondBody.status !== 'matched',
      `${firstBody.status} then ${secondBody.status ?? second.status}`);
  }

  console.log('');
  if (failures.length) {
    console.log(`FAILED — ${failures.length} probe(s): ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log('All probes held.');
}

main().catch((e) => {
  console.error('PROBE CRASHED:', e);
  process.exit(1);
});
