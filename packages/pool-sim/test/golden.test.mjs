/**
 * Guarantees this package makes to agents.
 *
 * An agent searching shot space locally is betting that our simulation and
 * theirs agree. These tests defend that bet from three directions:
 *
 *   1. Integrity  — the vendored engine is byte-identical to what was synced
 *                   from the server core, so nobody has hand-patched it.
 *   2. Purity     — no clock, no randomness, no I/O anywhere in the engine.
 *   3. Fidelity   — the engine still reproduces committed golden vectors, so
 *                   drift across platforms or Node versions is caught here
 *                   rather than at the table.
 *
 *   node --test test/*.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(PKG, 'manifest.json'), 'utf8'));
const golden = JSON.parse(readFileSync(join(PKG, 'test/fixtures/golden.json'), 'utf8'));

const { simulateShot, simulateShotInPlace, mkBall } = await import(join(PKG, 'dist/index.js'));
const { rack8Ball, rack9Ball, cueStart } = await import(join(PKG, 'dist/engine/rack.js'));
const { initPoolState, applyShot } = await import(join(PKG, 'dist/engine/matchState.js'));

function digest(v) {
  return createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 32);
}

function buildBalls(rack) {
  const spec = rack === '9' ? rack9Ball() : rack8Ball();
  const cue = cueStart();
  return [mkBall(0, cue.x, cue.y), ...spec.map((b) => mkBall(b.id, b.x, b.y))];
}

// ── 1. Integrity ───────────────────────────────────────────────────────────

test('vendored engine matches the sync manifest', () => {
  for (const [file, meta] of Object.entries(manifest.files)) {
    const actual = createHash('sha256')
      .update(readFileSync(join(PKG, 'src/engine', file), 'utf8'), 'utf8')
      .digest('hex');
    assert.equal(
      actual,
      meta.sha256,
      `${file} differs from the manifest. Never hand-edit src/engine — ` +
        `re-run scripts/sync-from-core.mjs instead.`,
    );
  }
});

test('every engine file is accounted for in the manifest', () => {
  const onDisk = readdirSync(join(PKG, 'src/engine')).filter((f) => f.endsWith('.ts')).sort();
  assert.deepEqual(onDisk, Object.keys(manifest.files).sort());
});

// ── 2. Purity ──────────────────────────────────────────────────────────────

test('engine contains no clock, randomness, or I/O', () => {
  const banned = [
    [/\bDate\.now\s*\(/, 'Date.now()'],
    [/\bMath\.random\s*\(/, 'Math.random()'],
    [/\bnew Date\s*\(/, 'new Date()'],
    [/\bprocess\./, 'process.*'],
    [/\brequire\s*\(/, 'require()'],
    [/\bfetch\s*\(/, 'fetch()'],
  ];
  for (const file of Object.keys(manifest.files)) {
    const src = readFileSync(join(PKG, 'src/engine', file), 'utf8');
    for (const [re, label] of banned) {
      assert.ok(!re.test(src), `${file} contains ${label} — the engine must stay pure`);
    }
  }
});

// ── 3. Fidelity ────────────────────────────────────────────────────────────

for (const v of golden.vectors) {
  test(`golden: ${v.name}`, () => {
    const result = simulateShot(buildBalls(v.rack), v.shot);

    assert.equal(result.frames.length, v.frames, 'frame count drifted');

    const potted = result.balls.filter((b) => b.pocketed).map((b) => b.id).sort((a, b) => a - b);
    assert.deepEqual(potted, v.potted, 'different balls were pocketed');

    const positions = result.balls
      .filter((b) => !b.pocketed)
      .map((b) => [b.id, Number(b.x.toFixed(4)), Number(b.y.toFixed(4))]);
    assert.deepEqual(positions, v.finalPositions, 'final ball positions drifted');

    // Catches any change anywhere in the result, including fields the checks
    // above do not read.
    assert.equal(digest(result), v.resultDigest, 'full result digest drifted');
  });
}

test(`golden: ${golden.rulesVector.name}`, () => {
  const state = initPoolState('pool8', 0);
  const ruled = applyShot(state, 'p1', { angle: 0, power: 1 }, 0);
  assert.equal(
    digest({ foul: ruled.foul, turn: ruled.state?.turn, balls: ruled.state?.balls }),
    golden.rulesVector.digest,
    'the rules layer reached a different verdict',
  );
});

// ── Determinism ────────────────────────────────────────────────────────────

test('identical inputs produce identical outputs', () => {
  const shot = { angle: 0.33, power: 0.82, spinSide: -0.4, spinVert: 0.6 };
  const a = simulateShot(buildBalls('8'), shot);
  const b = simulateShot(buildBalls('8'), shot);
  assert.equal(digest(a), digest(b));
});

test('simulating does not mutate a caller’s ball array', () => {
  // Agents search by trying many shots from one position. If the first call
  // mutated the array, every subsequent candidate would be scored against a
  // corrupted table — a silent, extremely confusing failure.
  const balls = buildBalls('8');
  const before = JSON.stringify(balls);
  simulateShot(balls, { angle: 0.2, power: 0.9 });
  simulateShot(balls, { angle: 0.2, power: 0.9 });
  assert.equal(JSON.stringify(balls), before, 'simulateShot mutated its input');
});

test('the in-place variant mutates, and agrees with the safe one', () => {
  // Pins the documented difference between the two exports. The engine really
  // does advance balls in place — correct for the server, a trap for search —
  // and the safe wrapper must change nothing but that.
  const shot = { angle: 0.2, power: 0.9 };

  const forInPlace = buildBalls('8');
  const snapshot = JSON.stringify(forInPlace);
  const inPlace = simulateShotInPlace(forInPlace, shot);
  assert.notEqual(JSON.stringify(forInPlace), snapshot, 'expected the raw engine to mutate');

  const safe = simulateShot(buildBalls('8'), shot);
  assert.equal(digest(safe), digest(inPlace), 'the wrapper altered the physics');
});

test('a search over many candidate shots stays consistent', () => {
  const score = (angle) => digest(simulateShot(buildBalls('8'), { angle, power: 0.7 }));
  const first = Array.from({ length: 12 }, (_, i) => score(i * 0.1));
  const again = Array.from({ length: 12 }, (_, i) => score(i * 0.1));
  assert.deepEqual(first, again);
  assert.equal(new Set(first).size, first.length, 'distinct angles gave identical results');
});
