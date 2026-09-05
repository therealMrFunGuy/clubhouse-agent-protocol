/**
 * The claim circuit breaker.
 *
 * These are money tests. Claiming is the only step in batch-settlement that
 * moves funds, and this is the control that bounds how much can move at once.
 *
 *   node --test test/*.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectWithinCeiling, owedBy } from '../dist/breaker.js';

const ch = (id, signed, claimed = '0') => ({
  channelId: id,
  signedMaxClaimable: signed,
  totalClaimed: claimed,
});

const fresh = (now = 1_000_000) => ({ claimedThisInterval: 0n, intervalStartedAt: now });

test('owed is signed minus claimed', () => {
  assert.equal(owedBy(ch('a', '1000', '400')), 600n);
});

test('owed never goes negative even if bookkeeping disagrees', () => {
  // If totalClaimed somehow exceeds signedMaxClaimable, treating the difference
  // as a negative would credit it against the ceiling and let MORE money out.
  assert.equal(owedBy(ch('a', '100', '500')), 0n);
});

test('with no ceiling, everything claimable is selected', () => {
  const d = selectWithinCeiling([ch('a', '100'), ch('b', '200')], undefined, fresh(), 1_000_000);
  assert.equal(d.selected.length, 2);
  assert.equal(d.ceilingHit, false);
});

test('channels owing nothing are never selected', () => {
  const d = selectWithinCeiling(
    [ch('a', '500', '500'), ch('b', '100', '0')],
    1000n,
    fresh(),
    1_000_000,
  );
  assert.deepEqual(d.selected.map((c) => c.channelId), ['b']);
});

test('the ceiling caps what leaves in one interval', () => {
  const d = selectWithinCeiling(
    [ch('a', '600'), ch('b', '600'), ch('c', '600')],
    1000n,
    fresh(),
    1_000_000,
  );
  const total = d.selected.reduce((s, c) => s + owedBy(c), 0n);
  assert.ok(total <= 1000n, `selected ${total}, ceiling 1000`);
  assert.equal(d.ceilingHit, true);
});

test('deferred channels are kept, never dropped', () => {
  const d = selectWithinCeiling(
    [ch('a', '600'), ch('b', '600'), ch('c', '600')],
    1000n,
    fresh(),
    1_000_000,
  );
  assert.equal(d.selected.length + d.deferred.length, 3, 'a channel vanished');
});

test('largest debts are settled first when the ceiling binds', () => {
  // Otherwise a flood of dust channels could starve a real one indefinitely —
  // a cheap way for an attacker to delay someone else's settlement.
  const d = selectWithinCeiling(
    [ch('dust1', '1'), ch('dust2', '1'), ch('big', '900')],
    1000n,
    fresh(),
    1_000_000,
  );
  assert.equal(d.selected[0].channelId, 'big');
});

test('a smaller channel still fits after a larger one is deferred', () => {
  const d = selectWithinCeiling(
    [ch('huge', '5000'), ch('small', '100')],
    1000n,
    fresh(),
    1_000_000,
  );
  assert.deepEqual(d.selected.map((c) => c.channelId), ['small']);
  assert.deepEqual(d.deferred.map((c) => c.channelId), ['huge']);
});

test('spend accumulates across calls within one interval', () => {
  const now = 1_000_000;
  const first = selectWithinCeiling([ch('a', '700')], 1000n, fresh(now), now);
  assert.equal(first.selected.length, 1);

  // Same interval: only 300 of headroom remains, so 700 must not go out again.
  const second = selectWithinCeiling([ch('b', '700')], 1000n, first.state, now + 60_000);
  assert.equal(second.selected.length, 0);
  assert.equal(second.ceilingHit, true);
});

test('the ceiling resets when the interval rolls over', () => {
  const now = 1_000_000;
  const first = selectWithinCeiling([ch('a', '900')], 1000n, fresh(now), now);
  assert.equal(first.selected.length, 1);

  const later = selectWithinCeiling([ch('b', '900')], 1000n, first.state, now + 3_600_001);
  assert.equal(later.selected.length, 1, 'interval did not reset');
  assert.equal(later.state.claimedThisInterval, 900n);
});

test('a single channel larger than the ceiling is deferred, not force-claimed', () => {
  // The ceiling is a hard bound. A channel that can never fit must stall and be
  // escalated to a human, rather than being waved through because it is stuck.
  const d = selectWithinCeiling([ch('whale', '99999')], 1000n, fresh(), 1_000_000);
  assert.equal(d.selected.length, 0);
  assert.equal(d.deferred.length, 1);
  assert.equal(d.ceilingHit, true);
});

test('an empty channel set is not a ceiling hit', () => {
  const d = selectWithinCeiling([], 1000n, fresh(), 1_000_000);
  assert.equal(d.selected.length, 0);
  assert.equal(d.ceilingHit, false, 'would fire a false alert every idle cycle');
});

test('base units are handled at scale without precision loss', () => {
  // USDC has 6dp; large channels exceed Number.MAX_SAFE_INTEGER in base units.
  const big = '9007199254740993000';
  assert.equal(owedBy(ch('a', big, '0')), 9007199254740993000n);
  const d = selectWithinCeiling([ch('a', big)], 10n ** 30n, fresh(), 1_000_000);
  assert.equal(d.selected.length, 1);
});
