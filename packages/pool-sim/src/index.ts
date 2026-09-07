/**
 * @goclubhouse/pool-sim
 *
 * The pool engine The Clubhouse server runs, published so agents can plan.
 *
 * These files are vendored byte-for-byte out of the private core by
 * `scripts/sync-from-core.mjs`; `manifest.json` records a hash per file and
 * `npm test` verifies both the hashes and a set of golden vectors. If this
 * package can be made to disagree with the server, that is a bug worth
 * reporting — see SECURITY.md in the protocol repo.
 *
 * The engine is pure: no clock, no randomness, no I/O. The same inputs give the
 * same outputs on your machine as on ours, which is what makes local search
 * worth doing.
 *
 *   import { simulateShot, initPoolState, applyShot } from '@goclubhouse/pool-sim';
 *
 *   const state = initPoolState('pool8', 0);          // nowMs is a parameter
 *   const result = applyShot(state, 'p1', shot, 0);   // full rules: fouls, groups, win
 */

// ── Physics ────────────────────────────────────────────────────────────────
import {
  simulateShot as simulateShotInPlace,
  type Ball,
  type ShotInput,
  type SimResult,
} from './engine/physics.js';

export {
  strikeCue,
  mkBall,
  PLAY_W,
  PLAY_H,
  BALL_R,
  POCKETS,
  type Ball,
  type ShotInput,
  type ShotEvents,
  type ShotFrame,
  type SimResult,
} from './engine/physics.js';

/**
 * Simulate a shot **without touching the balls you passed in.**
 *
 * The underlying engine advances the ball array in place — correct and
 * efficient on the server, which simulates one shot and then persists the
 * result. It is a trap for the thing this package exists to enable: searching
 * many candidate shots from one position. Called directly, the first shot
 * rearranges the table and every later candidate is scored against a position
 * that never existed.
 *
 * So the exported `simulateShot` clones first. The physics is untouched and
 * results are byte-identical to the server's — only the caller's array is
 * spared. Reach for {@link simulateShotInPlace} if you are managing the
 * lifetime yourself and want to avoid the copy.
 *
 * @example Search a fan of angles from one position
 * ```ts
 * const table = [mkBall(0, cue.x, cue.y), ...rack8Ball().map(b => mkBall(b.id, b.x, b.y))];
 * const best = angles
 *   .map(angle => ({ angle, result: simulateShot(table, { angle, power: 0.7 }) }))
 *   .filter(({ result }) => result.balls.some(b => b.pocketed && b.id !== 0))
 *   .sort((a, b) => b.result.balls.filter(x => x.pocketed).length
 *                 - a.result.balls.filter(x => x.pocketed).length)[0];
 * // `table` is still the original rack here.
 * ```
 */
export function simulateShot(balls: readonly Ball[], shot: ShotInput): SimResult {
  return simulateShotInPlace(balls.map((b) => ({ ...b })), shot);
}

/**
 * The raw engine, exactly as the server calls it. Mutates `balls` in place.
 * Prefer {@link simulateShot} unless the copy is measurably costing you.
 */
export { simulateShotInPlace };

// ── Rules ──────────────────────────────────────────────────────────────────
// The complete 8-ball / 9-ball rules layer: legality, fouls, group assignment,
// ball-in-hand, and win conditions. This is the same judgement the server
// applies to your shot, so you can evaluate a candidate before sending it.
export {
  initPoolState,
  applyShot,
  claimShotClock,
  groupOf,
  SHOT_MS,
  CLAIM_AFTER_MS,
  type PoolGame,
  type Seat,
  type Group,
  type PoolState,
  type PersistBall,
  type ShotResult,
} from './engine/matchState.js';

// ── Table setup ────────────────────────────────────────────────────────────
export {
  rack8Ball,
  rack9Ball,
  cueStart,
  FOOT_SPOT,
  HEAD_STRING_X,
} from './engine/rack.js';

// ── Ball groupings ─────────────────────────────────────────────────────────
export {
  groupOfBall,
  groupIds,
  otherGroup,
  groupLabel,
  groupRange,
  remainingOf,
  groupCleared,
  lowestBallOn,
  targetIds,
} from './engine/groups.js';
