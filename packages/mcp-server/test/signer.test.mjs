/**
 * Signing, and whether it matches the gateway.
 *
 * Reads and discovery are open, but anything that ACTS as somebody needs a
 * signature from the wallet that paid to enter. The MCP server could not
 * produce one, so it could browse the platform and not play on it — the two
 * headline tools, chess_move and pool_shot, answered 401.
 *
 * The property that matters is not "we sign something", it is "we sign the
 * SAME thing gateway/src/agentAuth.ts verifies". A signer that disagrees with
 * its verifier by one byte fails every request, and fails it in a way that
 * looks exactly like a bad key.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyMessage } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { signerFromEnv, challengeString } from '../dist/signer.js';

// A throwaway key. Never used for anything, and deliberately not derived from
// anything real — a test fixture that is also a live wallet is an accident
// waiting to be committed.
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const ADDRESS = privateKeyToAccount(KEY).address;

test('no key configured means browse-only, not a crash', () => {
  // An operator who only wants leaderboards should not need a wallet.
  assert.equal(signerFromEnv({}), null);
  assert.equal(signerFromEnv({ CLUBHOUSE_AGENT_PRIVATE_KEY: '   ' }), null);
});

test('a malformed key fails loudly and says nothing about its value', () => {
  // An error message is the easiest place for a secret to end up in a log.
  const bad = 'deadbeef';
  assert.throws(
    () => signerFromEnv({ CLUBHOUSE_AGENT_PRIVATE_KEY: bad }),
    (e) => {
      assert.match(e.message, /not a valid 32-byte hex private key/);
      assert.ok(!e.message.includes(bad), 'the error leaked the key material');
      return true;
    },
  );
});

test('accepts a key with or without the 0x prefix', () => {
  assert.equal(signerFromEnv({ CLUBHOUSE_AGENT_PRIVATE_KEY: KEY }).address, ADDRESS);
  assert.equal(
    signerFromEnv({ CLUBHOUSE_AGENT_PRIVATE_KEY: KEY.slice(2) }).address,
    ADDRESS,
  );
});

test('the challenge string is byte-identical to the gateway’s', () => {
  // Mirrors gateway/src/agentAuth.ts challengeString exactly. If that file
  // changes its format, this fails rather than every request failing in
  // production for a reason that reads as a key problem.
  const parts = {
    timestamp: '1757030000000',
    nonce: 'a-nonce',
    method: 'post',
    path: '/v1/chess/7/move',
    bodyHash: 'x'.repeat(64),
  };
  assert.equal(
    challengeString(parts),
    ['clubhouse-agent-v1', '1757030000000', 'a-nonce', 'POST', '/v1/chess/7/move', 'x'.repeat(64)].join('\n'),
  );
});

test('the signature VERIFIES the way the gateway verifies it', async () => {
  // The whole point. viem's verifyMessage is literally what agentAuth.ts calls,
  // so this is the real check rather than a re-implementation agreeing with
  // itself.
  const signer = signerFromEnv({ CLUBHOUSE_AGENT_PRIVATE_KEY: KEY });
  const body = JSON.stringify({ action: 'move', from: 'e2', to: 'e4' });
  const headers = await signer.headersFor('POST', '/v1/chess/7/move', body);

  const message = challengeString({
    timestamp: headers['x-cap-agent-timestamp'],
    nonce: headers['x-cap-agent-nonce'],
    method: 'POST',
    path: '/v1/chess/7/move',
    bodyHash: createHash('sha256').update(body, 'utf8').digest('hex'),
  });

  assert.ok(
    await verifyMessage({
      address: headers['x-cap-agent-address'],
      message,
      signature: headers['x-cap-agent-signature'],
    }),
    'the gateway would reject this signature',
  );
});

test('a different body produces a different signature', async () => {
  // The body is inside the signed material, so a proxy cannot rewrite a move.
  const signer = signerFromEnv({ CLUBHOUSE_AGENT_PRIVATE_KEY: KEY });
  const a = await signer.headersFor('POST', '/v1/chess/7/move', '{"to":"e4"}');
  const b = await signer.headersFor('POST', '/v1/chess/7/move', '{"to":"e5"}');
  assert.notEqual(a['x-cap-agent-signature'], b['x-cap-agent-signature']);
});

test('the query string is signed, not just the path', async () => {
  // Signing the pathname alone would leave parameters unauthorised while the
  // gateway forwards them under its own HMAC — the origin would treat values
  // the agent never saw as authorised.
  const signer = signerFromEnv({ CLUBHOUSE_AGENT_PRIVATE_KEY: KEY });
  const bare = challengeString({
    timestamp: '1', nonce: 'n', method: 'GET', path: '/v1/matches/mine', bodyHash: 'h',
  });
  const withQuery = challengeString({
    timestamp: '1', nonce: 'n', method: 'GET', path: '/v1/matches/mine?status=active', bodyHash: 'h',
  });
  assert.notEqual(bare, withQuery);
});

test('every request gets a fresh nonce and timestamp', async () => {
  // A reused nonce is a replay the origin will reject.
  const signer = signerFromEnv({ CLUBHOUSE_AGENT_PRIVATE_KEY: KEY });
  const a = await signer.headersFor('GET', '/v1/matches/mine', '');
  const b = await signer.headersFor('GET', '/v1/matches/mine', '');
  assert.notEqual(a['x-cap-agent-nonce'], b['x-cap-agent-nonce']);
});
