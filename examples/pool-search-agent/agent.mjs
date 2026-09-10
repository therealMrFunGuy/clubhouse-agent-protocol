#!/usr/bin/env node
/**
 * A Clubhouse pool agent that thinks before it shoots.
 *
 * This is the example worth reading. Because @goclubhouse/pool-sim is the exact
 * engine the server runs, the agent can try thousands of shots locally, judge
 * each one against the real rules, and send only the one it picked. No
 * guessing, no round-trips, no wasted turns.
 *
 *   npm install
 *   export CLUBHOUSE_AGENT_PRIVATE_KEY=0x...        # your agent's wallet
 *   node agent.mjs
 *
 * `node bench.mjs` runs the same search with no network at all, so you can tune
 * the scoring against visible output and measure a turn on your hardware.
 *
 * ## Judged, not guessed
 *
 * The search calls `applyShot` — the complete rules layer, not just the
 * physics. So a candidate that hits the wrong ball first, fails to reach a
 * rail, scratches, or sinks the 8 early comes back as a FOUL or a LOSS rather
 * than as a pot that happens to look good. Scoring against a hand-written
 * approximation of the rules is how an agent ends up confidently handing its
 * opponent ball-in-hand every other turn.
 *
 * ## Where the engine comes from
 *
 * `@goclubhouse/pool-sim` is installed from the registry, not linked from
 * `../../packages/pool-sim`. The workspace copy ships no `dist/` — it is
 * gitignored — and its package.json has `prepack`/`prepublishOnly` but no
 * `prepare`, and npm runs neither for a local path dependency. So on a fresh
 * clone the link resolved to a directory with no build in it, and this file
 * died on ERR_MODULE_NOT_FOUND before reaching one line of protocol. The
 * published tarball is byte-identical to a local build; examples/README.md has
 * the two commands for pointing this at your own edits to the engine instead.
 */

import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { applyShot, groupOf, targetIds, PLAY_W, PLAY_H, SHOT_MS } from '@goclubhouse/pool-sim';

const API = (process.env.CLUBHOUSE_API_URL ?? 'https://agents.goclubhouse.io').replace(/\/+$/, '');
const GAME = process.env.GAME === 'pool9' ? 'pool9' : 'pool8';

/**
 * Candidate shots per turn: 240 × 3 × 3 = 2,160 full rules evaluations.
 *
 * Measure before you widen this. `applyShot` runs the physics AND judges the
 * result against the full rules, which costs roughly 2.5ms from the opening
 * rack — so 2,160 candidates is five or six seconds on an unloaded laptop, and
 * ten on a busy one. Comfortable against the 60-second shot clock (`SHOT_MS`),
 * but only about ten times under it, and half that when the machine is loaded.
 * Doubling the angle resolution doubles the wall clock, and running out the
 * clock hands your opponent the rack.
 *
 * `node bench.mjs` reports the real figure on your hardware, and `ANGLE_STEPS`
 * in the environment overrides the width — `selftest.mjs` turns it right down
 * so a whole rack fits in a few seconds.
 */
export const ANGLE_STEPS =
  Number(process.env.ANGLE_STEPS) > 0 ? Math.floor(Number(process.env.ANGLE_STEPS)) : 240;
export const POWERS = [0.3, 0.55, 0.8];
export const SPINS = [0, -0.6, 0.6];

/**
 * Terminal scores. Far outside the range positional scoring can reach, so a win
 * always beats a pot and a loss always loses to a foul — but finite, so they
 * print, sort and compare like numbers.
 */
const WIN = 1_000_000;
const LOSS = -1_000_000;

/** Consecutive fruitless 25s waits before testing the opponent's shot clock. */
const WAITS_BEFORE_TIMEOUT_CLAIM = 6; // 150s > SHOT_MS + the claim grace
const PAIRING_TIMEOUT_MS = 5 * 60_000;

// ── Identity ───────────────────────────────────────────────────────────────

function loadAccount() {
  const raw = (process.env.CLUBHOUSE_AGENT_PRIVATE_KEY ?? '').trim();
  if (!raw) {
    throw new Error(
      'Set CLUBHOUSE_AGENT_PRIVATE_KEY to your agent wallet key (32 bytes of hex).\n' +
        'Generate a throwaway one with:\n' +
        "  node -e \"console.log('0x'+require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  const hex = raw.startsWith('0x') ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('CLUBHOUSE_AGENT_PRIVATE_KEY is not a valid 32-byte hex private key.');
  }
  return privateKeyToAccount(hex);
}

/**
 * Loaded on first use, not at import. `bench.mjs` imports the scoring from this
 * file and needs no wallet at all — a search that runs offline should not
 * demand a key to start.
 */
let account = null;
const agentAccount = () => (account ??= loadAccount());

// ── Protocol ───────────────────────────────────────────────────────────────

/**
 * What the gateway rebuilds and verifies:
 *
 *   clubhouse-agent-v1 \n timestamp \n nonce \n METHOD \n path?query \n sha256(body)
 *
 * The path carries its query string, and the body is hashed exactly as sent —
 * serialise once, then use that same string for both the hash and the request.
 * See gateway/src/agentAuth.ts for the verifying half.
 */
async function sign(method, path, payload) {
  const signer = agentAccount();
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const signature = await signer.signMessage({
    message: [
      'clubhouse-agent-v1',
      timestamp,
      nonce,
      method.toUpperCase(),
      path,
      createHash('sha256').update(payload, 'utf8').digest('hex'),
    ].join('\n'),
  });
  return {
    'x-cap-agent-address': signer.address,
    'x-cap-agent-timestamp': timestamp,
    'x-cap-agent-nonce': nonce,
    'x-cap-agent-signature': signature,
  };
}

class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function call(method, path, body) {
  const payload = body === undefined ? '' : JSON.stringify(body);

  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(payload ? { 'content-type': 'application/json' } : {}),
      ...(await sign(method, path, payload)),
    },
    body: payload || undefined,
  });

  if (res.status === 402) {
    throw new ApiError(
      402,
      `Payment required for ${path}.\n` +
        'A ranked seat is 0.50 USDC on Base (eip155:8453). WETH (0.00001) and CRED (10)\n' +
        'are also accepted, but both pay through Permit2 and need a one-time on-chain\n' +
        'approval plus spendControls.allowedAssets in your client — USDC needs neither.\n' +
        'Pay it with the v2 client: @x402/core/client + @x402/evm/exact/client. ' +
          'NOT x402-fetch — that is 1.x and this gateway returns 400 for a declared ' +
          'v1 payload. See packages/mcp-server/src/payment.ts for a working payer.',
      null,
    );
  }

  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(res.status, `HTTP ${res.status} on ${path}: ${text.slice(0, 200)}`, null);
  }
  if (!res.ok) throw new ApiError(res.status, data.error ?? `HTTP ${res.status} on ${path}`, data);
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Scoring ────────────────────────────────────────────────────────────────

/**
 * What a good shot looks like, in order of how much it matters:
 *
 *   win on this shot            everything else is noise
 *   lose on this shot           disqualifying
 *   foul                        expensive — it hands over ball-in-hand
 *   pot one of yours            strongly positive
 *   keep the table              worth about a pot on its own
 *   pot an opponent ball        negative, it helps them
 *   leave the cue near a legal target  mildly positive
 *
 * Everything above the last line is the ENGINE's verdict, not ours. That is the
 * whole point: the same code decides it here as decides it on the server.
 */
export function scoreOutcome(before, seat, shot) {
  const played = applyShot(before, seat, shot, Date.now());
  // Not a legal shot at all — a cue placement the rules refuse, say.
  if (!played.ok) return null;

  // Both of these are the ENGINE's verdict, including the bar rule that makes
  // the 8 on the break a win rather than the disaster a hand-written scorer
  // would assume. That is the difference this whole approach buys.
  if (played.result === seat) return { score: WIN, played };
  if (played.result) return { score: LOSS, played };

  const after = played.state;
  const last = after.lastShot;
  // Read off the state, not off the GAME env var: the state is what the server
  // is actually running, and a scorer that disagrees with it about which ball
  // ends the rack is worse than no scorer.
  const moneyBall = after.game === 'pool8' ? 8 : 9;
  let score = 0;

  if (last.foul) score -= 60;
  if (last.continued) score += 20;

  // Null means the table is still open — 8-ball before groups are assigned, and
  // 9-ball always, where groups never apply. Potting anything is good then, and
  // treating it as "not mine" is how an agent talks itself out of a break that
  // sank three balls.
  const group = after.groups?.[seat] ?? null;
  for (const id of last.pocketed) {
    if (id === 0 || id === moneyBall) continue; // cue and money ball: judged above
    if (group === null) score += 30;
    else score += groupOf(id) === group ? 30 : -12;
  }

  // Reward leaving the cue somewhere with options, and away from the rails.
  const cue = after.balls.find((b) => b.id === 0);
  if (cue && !cue.pk) {
    const targets = targetIds(after.game, after.balls, group)
      .map((id) => after.balls.find((b) => b.id === id))
      .filter(Boolean);
    if (targets.length) {
      const nearest = Math.min(...targets.map((b) => Math.sqrt((b.x - cue.x) ** 2 + (b.y - cue.y) ** 2)));
      score += Math.max(0, 12 - nearest / 6);
    }
    const railMargin = Math.min(cue.x, PLAY_W - cue.x, cue.y, PLAY_H - cue.y);
    if (railMargin < 4) score -= 4;
  }

  return { score, played };
}

/** Try every candidate and keep the best. */
export function findBestShot(state, seat) {
  let best = null;

  for (let i = 0; i < ANGLE_STEPS; i++) {
    const angle = (i / ANGLE_STEPS) * Math.PI * 2;
    for (const power of POWERS) {
      for (const spinSide of SPINS) {
        const shot = { angle, power, spinSide, spinVert: 0 };
        // applyShot deep-copies before it touches anything, so `state` survives
        // every candidate untouched — which is what makes searching from one
        // position meaningful at all.
        const outcome = scoreOutcome(state, seat, shot);
        if (outcome && (!best || outcome.score > best.score)) {
          best = { shot, score: outcome.score, played: outcome.played };
        }
      }
    }
  }

  return best;
}

export const CANDIDATES = ANGLE_STEPS * POWERS.length * SPINS.length;

// ── Taking a seat ──────────────────────────────────────────────────────────

/** The queue answers `matched` or `queued`; `queued` carries a null matchId. */
async function takeSeat() {
  const seat = await call('POST', '/v1/matchmaking/queue', { game: GAME });

  if (seat.status === 'matched') {
    console.log(`Matched immediately as ${seat.seat} in match ${seat.matchId}.`);
    return { matchId: seat.matchId, seat: seat.seat };
  }

  console.log('Queued. Waiting for an opponent — your seat is paid for and held.');
  const deadline = Date.now() + PAIRING_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(5_000);
    // Newest first, so the first hit is the seat just bought rather than some
    // older game still running. It is also how a restarted process finds the
    // game it already paid for.
    const mine = await call('GET', '/v1/matches/mine?status=active&limit=5');
    const match = (mine.matches ?? []).find((m) => m.game === GAME);
    if (match) {
      console.log(`Paired as ${match.seat} in match ${match.matchId}.`);
      return { matchId: match.matchId, seat: match.seat };
    }
  }

  await call('POST', `/v1/matchmaking/${GAME}/cancel`, {}).catch(() => {});
  throw new Error('No opponent within the pairing window; left the queue.');
}

// ── Game loop ──────────────────────────────────────────────────────────────

async function playMatch(matchId, seat) {
  console.log(`Seated in match ${matchId} as ${seat}. Shot clock ${SHOT_MS / 1000}s.`);

  // There is no per-seat pool read: pool is perfect information, so the live
  // table comes from the public waiter, which blocks until something changes.
  // `version` is its cursor — null means "return whatever is current now".
  let version = null;
  let status = 'active';
  let result = null;
  let idleWaits = 0;

  for (let step = 0; step < 600; step++) {
    const ev = await call(
      'GET',
      `/v1/matches/${matchId}/events?wait=25&since=${encodeURIComponent(version ?? '')}`,
    );
    version = ev.version;
    status = ev.status;
    result = ev.result;
    if (status !== 'active') break;

    const state = ev.state;
    // No `yourTurn` field exists on this response — whose shot it is lives in
    // the state, as `turn`, and is compared against the seat the queue gave us.
    if (!state || state.turn !== seat) {
      if (ev.timedOut && ++idleWaits >= WAITS_BEFORE_TIMEOUT_CLAIM) {
        idleWaits = 0;
        const claim = await call('POST', `/v1/pool/${matchId}/shot`, {
          action: 'claim_timeout',
        }).catch((e) => {
          // "There is still time on that clock" is a 400 and a fine answer.
          if (e instanceof ApiError && (e.status === 400 || e.status === 409)) return null;
          throw e;
        });
        if (claim?.terminal) {
          result = claim.terminal;
          status = 'finished';
          break;
        }
      } else if (!ev.timedOut) {
        // Something moved, so the opponent is alive. Counting only CONSECUTIVE
        // dead waits is the difference between "they have stopped" and "this is
        // a long game".
        idleWaits = 0;
      }
      continue;
    }
    idleWaits = 0;

    const started = Date.now();
    const best = findBestShot(state, seat);
    if (!best) {
      console.log('No legal shot the engine will accept — leaving it to the clock.');
      continue;
    }

    const potted = best.played.state?.lastShot?.pocketed ?? [];
    console.log(
      `  judged ${CANDIDATES} shots in ${Date.now() - started}ms → ` +
        `angle ${best.shot.angle.toFixed(3)} power ${best.shot.power} spin ${best.shot.spinSide} ` +
        `(score ${best.score.toFixed(1)}${potted.length ? `, expects [${potted}]` : ''})`,
    );

    const played = await call('POST', `/v1/pool/${matchId}/shot`, {
      action: 'shot',
      angle: best.shot.angle,
      power: best.shot.power,
      spinSide: best.shot.spinSide,
      spinVert: best.shot.spinVert,
    });

    if (played.terminal) {
      result = played.terminal;
      status = 'finished';
      break;
    }
    // Our own shot changed the table, so the cursor we hold is stale. Null makes
    // the next wait return the new position immediately instead of blocking on
    // one we have already left behind.
    version = null;
  }

  const outcome =
    result === seat ? ' — you won' : result === 'draw' ? ' — a draw' : result ? ' — you lost' : '';
  console.log(
    result
      ? `Match ${matchId} finished: ${result}${outcome}`
      : `Match ${matchId} stopped while still ${status}`,
  );
}

async function main() {
  console.log(`Clubhouse ${GAME} agent ${agentAccount().address} → ${API}`);
  const { matchId, seat } = await takeSeat();
  await playMatch(matchId, seat);
}

// Importable for bench.mjs and selftest.mjs; only the CLI entry point plays.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`\n${e.message}`);
    process.exit(1);
  });
}
