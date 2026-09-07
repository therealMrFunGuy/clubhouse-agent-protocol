#!/usr/bin/env node
/**
 * Run the agent's search against a real rack, without touching the network.
 *
 * Worth running before you play: it tells you how long a turn will take on your
 * hardware, and it lets you tune the scoring function against visible output
 * instead of guessing from match results.
 *
 *   node bench.mjs
 */

import { mkBall, rack8Ball, cueStart, simulateShot, groupOf } from '@goclubhouse/pool-sim';

// Same knobs as agent.mjs.
const ANGLE_STEPS = 240;
const POWERS = [0.25, 0.45, 0.65, 0.85];
const SPINS = [0, -0.6, 0.6];

function scoreShot(result, myGroup) {
  const potted = result.balls.filter((b) => b.pocketed);
  if (potted.some((b) => b.id === 8)) return -Infinity;
  if (potted.some((b) => b.id === 0)) return -50;
  let score = 0;
  for (const b of potted) {
    if (b.id === 0 || b.id === 8) continue;
    const g = groupOf(b.id);
    score += myGroup === null || g === myGroup ? 25 : -15;
  }
  return score;
}

const cue = cueStart();
const table = [mkBall(0, cue.x, cue.y), ...rack8Ball().map((b) => mkBall(b.id, b.x, b.y))];
const snapshot = JSON.stringify(table);

const started = process.hrtime.bigint();
const scored = [];

for (let i = 0; i < ANGLE_STEPS; i++) {
  const angle = (i / ANGLE_STEPS) * Math.PI * 2;
  for (const power of POWERS) {
    for (const spinSide of SPINS) {
      const shot = { angle, power, spinSide, spinVert: 0 };
      const result = simulateShot(table, shot);
      scored.push({
        shot,
        score: scoreShot(result, null),
        potted: result.balls.filter((b) => b.pocketed).map((b) => b.id),
      });
    }
  }
}

const ms = Number(process.hrtime.bigint() - started) / 1e6;
scored.sort((a, b) => b.score - a.score);

console.log(`Searched ${scored.length} shots in ${ms.toFixed(0)}ms (${(ms / scored.length).toFixed(2)}ms each)\n`);
console.log('Best opening shots:');
for (const s of scored.slice(0, 5)) {
  const { angle, power, spinSide } = s.shot;
  console.log(
    `  score ${String(s.score).padStart(4)}  angle ${angle.toFixed(3)}  power ${power}  ` +
      `spin ${String(spinSide).padStart(4)}  potted [${s.potted}]`,
  );
}

const scratches = scored.filter((s) => s.potted.includes(0)).length;
const potters = scored.filter((s) => s.potted.some((id) => id !== 0)).length;
console.log(`\n${potters} of ${scored.length} shots pot something; ${scratches} scratch.`);

// The property the whole approach rests on.
if (JSON.stringify(table) !== snapshot) {
  console.error('\nFAIL: the table was mutated — every candidate after the first was scored wrong.');
  process.exit(1);
}
console.log('Table unchanged after the search — candidates were all scored from the same position.');
