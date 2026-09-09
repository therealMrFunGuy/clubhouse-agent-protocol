#!/usr/bin/env node
/**
 * Run the agent's search against a real rack, without touching the network.
 *
 * Worth running before you play: it tells you how long a turn will take on your
 * hardware, and it lets you tune the scoring function against visible output
 * instead of guessing from match results.
 *
 *   node bench.mjs
 *
 * It imports `scoreOutcome` and `findBestShot` from agent.mjs rather than
 * restating them. The previous version kept its own copy, which had already
 * drifted: it scored a shot by looking at which balls fell, while the agent
 * scored it by a different rule again — so the numbers printed here described
 * a search nothing actually ran.
 */

import { initPoolState } from '@goclubhouse/pool-sim';
import {
  scoreOutcome,
  findBestShot,
  CANDIDATES,
  ANGLE_STEPS,
  POWERS,
  SPINS,
} from './agent.mjs';

const opening = initPoolState('pool8', 0);
const snapshot = JSON.stringify(opening);

const started = process.hrtime.bigint();
const scored = [];

for (let i = 0; i < ANGLE_STEPS; i++) {
  const angle = (i / ANGLE_STEPS) * Math.PI * 2;
  for (const power of POWERS) {
    for (const spinSide of SPINS) {
      const shot = { angle, power, spinSide, spinVert: 0 };
      const outcome = scoreOutcome(opening, 'p1', shot);
      if (!outcome) continue;
      const last = outcome.played.state.lastShot;
      scored.push({ shot, score: outcome.score, potted: last.pocketed, foul: last.foul });
    }
  }
}

const ms = Number(process.hrtime.bigint() - started) / 1e6;
scored.sort((a, b) => b.score - a.score);

console.log(
  `Judged ${scored.length} shots in ${ms.toFixed(0)}ms (${(ms / scored.length).toFixed(2)}ms each)\n`,
);

console.log('Best opening shots:');
for (const s of scored.slice(0, 5)) {
  const { angle, power, spinSide } = s.shot;
  console.log(
    `  score ${s.score.toFixed(1).padStart(6)}  angle ${angle.toFixed(3)}  power ${power}  ` +
      `spin ${String(spinSide).padStart(4)}  ${s.foul ? 'FOUL ' : '     '}potted [${s.potted}]`,
  );
}

const fouls = scored.filter((s) => s.foul).length;
const potters = scored.filter((s) => s.potted.some((id) => id !== 0)).length;
console.log(
  `\n${potters} of ${scored.length} shots pot something; ${fouls} are fouls by the real rules.`,
);

// The property the whole approach rests on: applyShot deep-copies, so every
// candidate is judged from the SAME position.
if (JSON.stringify(opening) !== snapshot) {
  console.error('\nFAIL: the state was mutated — every candidate after the first was judged wrong.');
  process.exit(1);
}
console.log('State unchanged after the search — candidates were all judged from the same position.');

// And the search itself agrees with the sweep above.
const best = findBestShot(opening, 'p1');
if (!best || CANDIDATES !== scored.length) {
  console.error('\nFAIL: findBestShot and this sweep disagree about the candidate set.');
  process.exit(1);
}
console.log(
  `findBestShot picked angle ${best.shot.angle.toFixed(3)} power ${best.shot.power} ` +
    `(score ${best.score.toFixed(1)}).`,
);
