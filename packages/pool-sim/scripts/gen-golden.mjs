#!/usr/bin/env node
/**
 * Generate golden vectors for the pool engine.
 *
 * These exist to answer the one question an agent actually cares about before
 * trusting a local search: *does the simulation on my machine agree with the
 * server's?* A physics engine is exactly the kind of code where that can
 * silently stop being true — floating-point behaviour varies across platforms
 * and engine versions, and a shot that pots on our table but not on yours makes
 * the package worse than useless.
 *
 * Run after `sync-from-core.mjs`, and commit the result.
 *
 *   node scripts/gen-golden.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(HERE, '..');

const { simulateShot, mkBall } = await import(join(PKG, 'dist', 'index.js'));
const { rack8Ball, rack9Ball, cueStart } = await import(join(PKG, 'dist', 'engine', 'rack.js'));
const { initPoolState, applyShot } = await import(join(PKG, 'dist', 'engine', 'matchState.js'));

/**
 * Cases chosen to exercise distinct code paths rather than to look varied:
 * a clean break, a dead-straight stop shot, heavy side english, maximum draw,
 * a rail-first shot, and a near-zero-power tap that should barely move.
 */
const SHOTS = [
  { name: 'break-8ball-full', rack: '8', shot: { angle: 0, power: 1 } },
  { name: 'break-9ball-full', rack: '9', shot: { angle: 0, power: 1 } },
  { name: 'straight-medium', rack: '8', shot: { angle: 0, power: 0.5 } },
  { name: 'right-english', rack: '8', shot: { angle: 0.05, power: 0.7, spinSide: 1 } },
  { name: 'left-english', rack: '8', shot: { angle: -0.05, power: 0.7, spinSide: -1 } },
  { name: 'max-draw', rack: '8', shot: { angle: 0, power: 0.8, spinVert: -1 } },
  { name: 'max-follow', rack: '8', shot: { angle: 0, power: 0.8, spinVert: 1 } },
  { name: 'steep-angle-up', rack: '8', shot: { angle: 0.9, power: 0.6 } },
  { name: 'steep-angle-down', rack: '8', shot: { angle: -0.9, power: 0.6 } },
  { name: 'feather-tap', rack: '8', shot: { angle: 0, power: 0.02 } },
  { name: 'rail-first', rack: '8', shot: { angle: 1.4, power: 0.9, spinSide: 0.5 } },
  { name: 'combined-spin', rack: '9', shot: { angle: 0.2, power: 0.75, spinSide: -0.6, spinVert: 0.8 } },
];

function buildBalls(rack) {
  const spec = rack === '9' ? rack9Ball() : rack8Ball();
  const cue = cueStart();
  return [mkBall(0, cue.x, cue.y), ...spec.map((b) => mkBall(b.id, b.x, b.y))];
}

/**
 * Hash the full result rather than storing megabytes of frames. A single
 * changed coordinate anywhere changes the digest, which is precisely the
 * sensitivity we want — and it keeps the fixture file readable.
 */
function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

const vectors = SHOTS.map(({ name, rack, shot }) => {
  const balls = buildBalls(rack);
  const result = simulateShot(balls, shot);
  return {
    name,
    rack,
    shot,
    frames: result.frames.length,
    potted: result.balls.filter((b) => b.pocketed).map((b) => b.id).sort((a, b) => a - b),
    // Final resting positions, rounded to 4dp. Tighter than the wire format
    // (2dp) so the fixture catches drift the API would round away.
    finalPositions: result.balls
      .filter((b) => !b.pocketed)
      .map((b) => [b.id, Number(b.x.toFixed(4)), Number(b.y.toFixed(4))]),
    resultDigest: digest(result),
  };
});

// A full rules-layer pass, so fouls and turn handover are pinned too, not just
// the raw physics.
const state = initPoolState('pool8', 0);
const ruled = applyShot(state, 'p1', { angle: 0, power: 1 }, 0);
const rulesVector = {
  name: 'rules-break-8ball',
  ok: ruled.ok ?? null,
  foul: ruled.foul ?? null,
  nextTurn: ruled.state?.turn ?? null,
  digest: digest({ foul: ruled.foul, turn: ruled.state?.turn, balls: ruled.state?.balls }),
};

mkdirSync(join(PKG, 'test', 'fixtures'), { recursive: true });
writeFileSync(
  join(PKG, 'test', 'fixtures', 'golden.json'),
  `${JSON.stringify({ generatedBy: 'gen-golden.mjs', vectors, rulesVector }, null, 2)}\n`,
);

console.log(`Wrote ${vectors.length} physics vectors + 1 rules vector.`);
for (const v of vectors) {
  console.log(`  ${v.name.padEnd(20)} frames=${String(v.frames).padStart(4)} potted=[${v.potted}]`);
}
