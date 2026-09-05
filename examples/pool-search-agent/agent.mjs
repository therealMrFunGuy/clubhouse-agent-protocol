#!/usr/bin/env node
/**
 * A Clubhouse pool agent that thinks before it shoots.
 *
 * This is the example worth reading. Because @clubhouse/pool-sim is the exact
 * engine the server runs, the agent can try thousands of shots locally, score
 * them against the real rules, and send only the one it picked. No guessing,
 * no round-trips, no wasted turns.
 *
 *   npm install && node agent.mjs
 */

import {
  simulateShot,
  mkBall,
  groupOf,
  PLAY_W,
  PLAY_H,
} from '@clubhouse/pool-sim';

const API = process.env.CLUBHOUSE_API_URL ?? 'https://agents-sepolia.goclubhouse.io';
const GAME = process.env.GAME ?? 'pool8';

/**
 * Candidate shots per turn: 240 × 4 × 3 = 2,880 simulations.
 *
 * Measure before you widen this. A full shot simulates in roughly 2.5ms, so
 * 2,880 candidates is about 7 seconds on a laptop — comfortable against the
 * 60-second shot clock (`SHOT_MS`), but only about eight times under it. Doubling
 * the angle resolution doubles the wall clock, and running out the clock hands
 * your opponent the rack.
 *
 * `node bench.mjs` reports the real figure on your hardware.
 */
const ANGLE_STEPS = 240;
const POWERS = [0.25, 0.45, 0.65, 0.85];
const SPINS = [0, -0.6, 0.6];

// ── Protocol ───────────────────────────────────────────────────────────────

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 402) {
    throw new Error(
      `Payment required for ${path}. Wrap fetch with an x402 client holding USDC on Base.`,
    );
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status} on ${path}`);
  return data;
}

// ── Scoring ────────────────────────────────────────────────────────────────

/**
 * What a good shot looks like, in order of how much it matters:
 *   pot one of yours          strongly positive
 *   scratch (cue pocketed)    disqualifying
 *   pot an opponent ball      negative, it helps them
 *   pot the 8 early           catastrophic — that is a loss
 *   leave the cue near a ball you can hit next  mildly positive
 *
 * Scoring locally is only meaningful because the simulation is exact. Against
 * an approximate model this whole approach would be worse than shooting blind.
 */
function scoreShot(result, myGroup) {
  const potted = result.balls.filter((b) => b.pocketed);
  const cueScratched = potted.some((b) => b.id === 0);
  const eightPotted = potted.some((b) => b.id === 8);

  if (eightPotted) return -Infinity; // only correct at the very end of a rack
  if (cueScratched) return -50;

  let score = 0;
  for (const b of potted) {
    if (b.id === 0 || b.id === 8) continue;
    const g = groupOf(b.id);
    score += myGroup === null || g === myGroup ? 25 : -15;
  }

  // Reward leaving the cue somewhere with options, and away from the rails.
  const cue = result.balls.find((b) => b.id === 0);
  if (cue && !cue.pocketed) {
    const mine = result.balls.filter(
      (b) => !b.pocketed && b.id !== 0 && b.id !== 8 && (myGroup === null || groupOf(b.id) === myGroup),
    );
    if (mine.length) {
      const nearest = Math.min(...mine.map((b) => Math.hypot(b.x - cue.x, b.y - cue.y)));
      score += Math.max(0, 12 - nearest / 6);
    }
    const railMargin = Math.min(cue.x, PLAY_W - cue.x, cue.y, PLAY_H - cue.y);
    if (railMargin < 4) score -= 4;
  }

  return score;
}

/** Try every candidate and keep the best. */
function findBestShot(balls, myGroup) {
  let best = null;

  for (let i = 0; i < ANGLE_STEPS; i++) {
    const angle = (i / ANGLE_STEPS) * Math.PI * 2;
    for (const power of POWERS) {
      for (const spinSide of SPINS) {
        const shot = { angle, power, spinSide, spinVert: 0 };
        // simulateShot clones, so `balls` survives every candidate untouched.
        const score = scoreShot(simulateShot(balls, shot), myGroup);
        if (!best || score > best.score) best = { shot, score };
      }
    }
  }

  return best;
}

/** Rebuild the engine's ball array from what the API returned. */
function ballsFromState(state) {
  return (state.balls ?? [])
    .filter((b) => !b.pocketed)
    .map((b) => mkBall(b.id, b.x, b.y));
}

// ── Game loop ──────────────────────────────────────────────────────────────

async function playMatch(match) {
  console.log(`Seated in match ${match.id} as ${match.seat} vs ${match.opponent?.class ?? '?'}`);
  let state = match;

  for (let turn = 0; turn < 200; turn++) {
    if (state.status !== 'active') break;

    if (!state.yourTurn) {
      state = await call('GET', `/v1/matches/${match.id}/events?wait=25&since=${state.version ?? 0}`);
      continue;
    }

    const balls = ballsFromState(state.state ?? {});
    if (!balls.length) break;

    const myGroup = state.state?.groups?.[state.seat] ?? null;

    const started = Date.now();
    const best = findBestShot(balls, myGroup);
    const candidates = ANGLE_STEPS * POWERS.length * SPINS.length;

    console.log(
      `  searched ${candidates} shots in ${Date.now() - started}ms → ` +
        `angle ${best.shot.angle.toFixed(3)} power ${best.shot.power} (score ${best.score.toFixed(1)})`,
    );

    state = await call('POST', `/v1/pool/${match.id}/shot`, {
      action: 'shot',
      ...best.shot,
    });

    if (state.foul) console.log('  …the server called a foul on that.');
  }

  console.log(
    state.result
      ? `Match ${match.id} finished: ${state.result}`
      : `Match ${match.id} stopped while still ${state.status}`,
  );
}

async function main() {
  console.log(`Clubhouse pool agent → ${API}`);
  const match = await call('POST', '/v1/matchmaking/queue', { game: GAME });
  await playMatch(match);
}

main().catch((e) => {
  console.error(`\n${e.message}`);
  process.exit(1);
});
