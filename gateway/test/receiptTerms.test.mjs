/**
 * Where the forwarded receipt's terms come from.
 *
 * `paymentRequirements` is the requirement this gateway advertised and the
 * facilitator verified and settled against. `paymentPayload.accepted` is the
 * CLIENT's echo of it. The gateway once preferred the echo — a workaround for a
 * since-fixed bug where the sibling read as `amount: '0'` — and that made every
 * money field in the receipt attacker-controlled under a declared v1.
 *
 * These read source rather than execute it. The Worker's paid branch needs a
 * live facilitator and a real settled USDC payment to reach, so the property
 * that matters — which object the terms are read from — is asserted directly.
 * The alternative is discovering it in production, where the evidence is a
 * drained pot wallet.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const index = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8');

/** The paid branch: from where the payer is read to where the origin is called. */
function paidBranch() {
  const start = index.indexOf('// ── Who paid, and for what ──');
  const end = index.indexOf('// ── Settle ONLY if the origin actually granted the seat');
  assert.ok(start > -1 && end > start, 'could not locate the paid branch');
  return index.slice(start, end);
}

test('the receipt is built from the server requirement, never the client echo', () => {
  const branch = paidBranch();

  // The terms must come from the verified requirement…
  assert.match(branch, /const requirements = \(result as any\)\.paymentRequirements/);
  assert.match(branch, /const network = requirements\.network/);
  assert.match(branch, /const asset = requirements\.asset/);
  assert.match(branch, /const amount = requirements\.amount/);

  // …and no money field may be read from the client's payload. `payload` is
  // still used for the payer and the settlement nonce, which come from the
  // SIGNED EIP-3009 authorisation — those are proven, the echoed terms are not.
  assert.doesNotMatch(branch, /payload\.accepted/);
  assert.doesNotMatch(branch, /accepted\.(amount|asset|network|scheme)/);
});

test('missing server terms are refused, not defaulted', () => {
  // Defaulting is how the original `amount: '0'` went unnoticed and produced
  // the workaround that became the hole. A field we cannot establish is a
  // failure to surface, not a gap to fill with a plausible-looking value.
  const branch = paidBranch();
  assert.match(branch, /!network \|\| !asset \|\| typeof amount !== 'string'/);
  assert.match(branch, /Payment terms could not be established/);
  assert.doesNotMatch(branch, /amount = requirements\.amount \?\?/);
});

test('the version gate runs BEFORE the library matches requirements', () => {
  // processHTTPRequest is what executes the weak v1 match, so a check placed
  // after it has already lost: the requirement has been chosen by then.
  const gate = index.indexOf('declaredX402Version(ctx.paymentHeader)');
  const process = index.indexOf('server.processHTTPRequest');
  assert.ok(gate > -1, 'version gate is missing');
  assert.ok(process > -1, 'processHTTPRequest call is missing');
  assert.ok(gate < process, 'the version gate must precede processHTTPRequest');
});

test('only the supported version is allowed through', () => {
  assert.match(index, /declaredVersion !== null && declaredVersion !== SUPPORTED_X402_VERSION/);
  // `!== null` keeps the unpaid path alive: no header means no payment to judge,
  // and that request is the one that earns a 402 challenge.
});
