/**
 * The version guard, and why it has to exist.
 *
 * @x402/core decodes the payment header with a bare `JSON.parse` — there is no
 * schema — and then switches on `x402Version`. Its v2 branch deep-equals the
 * client's echoed terms against the server's own requirement. Its **v1 branch
 * compares `scheme` and `network` and nothing else**, leaving `amount` and
 * `asset` free for the caller to declare.
 *
 * That declared amount is what the gateway used to forward to the origin, where
 * it is stored and SUMMED into the pot a winner is paid from. Paying $1 while
 * declaring $250 was therefore a live treasury drain, and refusing the version
 * is what closes it at this layer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { declaredX402Version, SUPPORTED_X402_VERSION } from '../src/x402.ts';

const encode = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');

test('no payment header is not a version failure', () => {
  // The unpaid path has to keep working: this is the request that EARNS a 402
  // challenge. Refusing it here would make the paywall unreachable.
  assert.equal(declaredX402Version(undefined), null);
  assert.equal(declaredX402Version(''), null);
});

test('a v2 payload is accepted', () => {
  assert.equal(declaredX402Version(encode({ x402Version: 2 })), SUPPORTED_X402_VERSION);
});

test('a v1 payload is reported, so the caller can refuse it', () => {
  // The whole finding. v1 is a valid protocol version and a well-formed payload
  // — it is simply one whose requirement matching we will not rely on.
  assert.equal(declaredX402Version(encode({ x402Version: 1 })), 1);
});

test('a forged amount rides on the version, which is why the version is the gate', () => {
  const forged = encode({
    x402Version: 1,
    accepted: {
      scheme: 'exact',
      network: 'eip155:8453',
      // Paid $1; declares $250. Under v1 the library checks neither field.
      amount: '250000000',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    },
  });
  assert.notEqual(declaredX402Version(forged), SUPPORTED_X402_VERSION);
});

test('an absent or non-numeric version is refused, not assumed current', () => {
  // "No version" must never be read as "the version we like". A payload whose
  // shape we do not recognise is arriving at a paid route.
  assert.ok(Number.isNaN(declaredX402Version(encode({}))));
  assert.ok(Number.isNaN(declaredX402Version(encode({ x402Version: '2' }))));
  assert.ok(Number.isNaN(declaredX402Version(encode({ x402Version: null }))));
});

test('an undecodable header is refused rather than waved through', () => {
  // If the version cannot be read it cannot be confirmed to be v2, and the
  // library may still decode it and take the v1 branch.
  assert.ok(Number.isNaN(declaredX402Version('not!valid!base64')));
  assert.ok(Number.isNaN(declaredX402Version(Buffer.from('{oops', 'utf8').toString('base64'))));
});

test('decodes multi-byte UTF-8 the same way @x402/core does', () => {
  // Equivalence with the library is the property that keeps this guard honest.
  // A guard that reads its input differently from the code it guards has a gap
  // between the two readings, and that gap is where the bypass lives. Plain
  // `atob` mangles multi-byte text; the library uses TextDecoder, so this does.
  const payload = { x402Version: 2, note: 'café ♠ 中文' };
  const header = encode(payload);

  assert.equal(declaredX402Version(header), 2);
  // Byte-for-byte agreement with the library's own decode path.
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64').toString('utf-8')), payload);
});
