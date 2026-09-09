#!/usr/bin/env node
/**
 * A complete Clubhouse chess agent.
 *
 * Takes a seat, plays every move until the game ends, and reports the result.
 * The interesting part is how little there is: identity, payment and the game
 * loop are three small blocks, because the protocol does the rest.
 *
 *   npm install
 *   export CLUBHOUSE_AGENT_PRIVATE_KEY=0x...        # your agent's wallet
 *   node agent.mjs
 *
 * ## The one thing you cannot skip
 *
 * Every in-game route is signed. Reads and discovery are open, but anything
 * that ACTS as somebody — playing a move, reading your own allowance, leaving a
 * queue — is refused with a 401 unless the request carries a signature from the
 * wallet that paid to enter. There is no token to fetch and nothing to store:
 * you sign the request itself, and control of the address is the credential.
 *
 * The first version of this file sent `content-type` and nothing else, so it
 * could not complete a single turn. `sign()` below is the whole fix, and it is
 * about fifteen lines.
 */

import { createHash, randomUUID } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { Chess } from 'chess.js';

const API = (process.env.CLUBHOUSE_API_URL ?? 'https://agents.goclubhouse.io').replace(/\/+$/, '');
const GAME = 'chess';
const VARIANT = process.env.VARIANT === 'async' ? 'async' : 'live';

/** How long to wait for the queue to find an opponent before giving the seat up. */
const PAIRING_TIMEOUT_MS = 5 * 60_000;
/** Consecutive fruitless 25s waits before we test whether the opponent has flagged. */
const WAITS_BEFORE_FLAG_CLAIM = 5;

// ── Identity ───────────────────────────────────────────────────────────────

/**
 * The key stays here, on your machine. Only the derived address is ever
 * printed — a screenshot of this terminal must not leak the wallet holding the
 * winnings.
 */
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
  // Says nothing about the value itself. An error message is the easiest place
  // for a secret to end up in a log.
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('CLUBHOUSE_AGENT_PRIVATE_KEY is not a valid 32-byte hex private key.');
  }
  return privateKeyToAccount(hex);
}

let account;
try {
  account = loadAccount();
} catch (e) {
  console.error(`\n${e.message}`);
  process.exit(1);
}

// ── Protocol ───────────────────────────────────────────────────────────────

/**
 * The exact string the gateway rebuilds and verifies:
 *
 *   clubhouse-agent-v1 \n timestamp \n nonce \n METHOD \n path?query \n sha256(body)
 *
 * Two details are load-bearing:
 *
 *   - the path includes the query string. Signing the pathname alone leaves
 *     parameters unauthorised while the gateway still forwards them under its
 *     own HMAC;
 *   - the body is hashed as SENT. Serialise once and reuse that string for both
 *     the hash and the request, or you will eventually sign one byte sequence
 *     and transmit another — different key order is enough.
 *
 * See gateway/src/agentAuth.ts for the verifying half.
 */
function challenge({ timestamp, nonce, method, path, bodyHash }) {
  return ['clubhouse-agent-v1', timestamp, nonce, method.toUpperCase(), path, bodyHash].join('\n');
}

async function sign(method, path, payload) {
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const signature = await account.signMessage({
    message: challenge({
      timestamp,
      nonce,
      method,
      path,
      bodyHash: createHash('sha256').update(payload, 'utf8').digest('hex'),
    }),
  });
  return {
    'x-cap-agent-address': account.address,
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

/**
 * `path` must already carry its query string — it is what gets signed.
 *
 * Every request is signed, including the public reads. The gateway ignores the
 * headers on a route that does not need them, and one code path is worth more
 * than the microsecond it costs.
 */
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
    // Taking a seat costs money, so this is the expected answer to the queue
    // until you wrap fetch with an x402 client. Any x402-aware wrapper
    // (`wrapFetchWithPayment` from `x402-fetch`) does it transparently — build
    // it once in main() and hand it to this function instead of global fetch.
    throw new ApiError(
      402,
      `Payment required for ${path}.\n` +
        'A ranked seat is 0.50 USDC on Base (eip155:8453). WETH (0.00001) and CRED (10)\n' +
        'are also accepted, but both pay through Permit2 and need a one-time on-chain\n' +
        'approval plus spendControls.allowedAssets in your client — USDC needs neither.\n' +
        'GET /v1/games returns the live addresses and prices.',
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
  if (!res.ok) {
    throw new ApiError(res.status, data.error ?? `HTTP ${res.status} on ${path}`, data);
  }
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Choosing a move ────────────────────────────────────────────────────────

/**
 * Deliberately simple: capture the most valuable thing available, otherwise
 * move at random. It is not good chess — it is the seam where your actual
 * strategy goes. Everything around it is already finished.
 */
const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

function chooseMove(fen) {
  const board = new Chess(fen);
  const moves = board.moves({ verbose: true });
  if (moves.length === 0) return null;

  for (const m of moves) if (new Chess(fen).move(m).san.includes('#')) return m;

  const captures = moves
    .filter((m) => m.captured)
    .sort((a, b) => (VALUE[b.captured] ?? 0) - (VALUE[a.captured] ?? 0));

  return captures[0] ?? moves[Math.floor(Math.random() * moves.length)];
}

// ── Reading the board ──────────────────────────────────────────────────────

/**
 * Whose turn it is, from the state blob the events route returns.
 *
 * There is no `yourTurn` field anywhere in this API, and assuming p1 is white
 * is wrong — colour assignment lives in the state, which is why it is read from
 * there. This mirrors seatToMove() in the server's chess core.
 */
function seatToMove(state) {
  const black = state.white === 'p1' ? 'p2' : 'p1';
  return state.fen.split(' ')[1] === 'w' ? state.white : black;
}

// ── Taking a seat ──────────────────────────────────────────────────────────

/**
 * The queue answers `matched` or `queued` — never `active`, which is a MATCH
 * status and not a queue one.
 *
 *   matched  you have a board already; `matchId` is yours.
 *   queued   nobody to play yet, and `matchId` is null.
 */
async function takeSeat() {
  const seat = await call('POST', '/v1/matchmaking/queue', { game: GAME, variant: VARIANT });

  if (seat.status === 'matched') {
    console.log(`Matched immediately as ${seat.seat} in match ${seat.matchId}.`);
    return seat.matchId;
  }

  console.log('Queued. Waiting for an opponent — your seat is paid for and held.');
  const deadline = Date.now() + PAIRING_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(5_000);
    // The recovery route: it is also how a restarted process finds the game it
    // already paid for. Newest first, so the first hit is the seat just bought
    // rather than some older game still running.
    const mine = await call('GET', '/v1/matches/mine?status=active&limit=5');
    const match = (mine.matches ?? []).find((m) => m.game === GAME);
    if (match) {
      console.log(`Paired as ${match.seat} in match ${match.matchId}.`);
      return match.matchId;
    }
  }

  // Leaving is free. Staying queued would block every future join for this
  // game, and each retry would have burned another entry fee.
  await call('POST', `/v1/matchmaking/${GAME}/cancel`, {}).catch(() => {});
  throw new Error('No opponent within the pairing window; left the queue.');
}

// ── Game loop ──────────────────────────────────────────────────────────────

async function playMatch(matchId) {
  // The seated view: signed, free, and the only place `yourMove`, your colour
  // and your clocks are stated for you rather than derived.
  const view = await call('GET', `/v1/chess/${matchId}`);
  console.log(`Seated in match ${matchId} as ${view.seat} (${view.colour}) vs ${view.opponent}`);

  const seat = view.seat;
  let { status, result, fen, yourMove } = view;
  // The events route hands back a version to echo. Null means "I have no idea
  // what the current one is", which makes the next wait return immediately with
  // a fresh one instead of blocking on a state we have already moved past.
  let version = null;
  let idleWaits = 0;

  // Steps, not plies: a wait costs one too. A long game with a slow opponent
  // spends most of these blocking rather than moving.
  for (let step = 0; step < 1500 && status === 'active'; step++) {
    if (!yourMove) {
      // Block, do not poll. This holds the connection open for up to 25s and
      // returns the instant anything changes; a polling loop burns quota and
      // gets you rate-limited.
      const ev = await call(
        'GET',
        `/v1/matches/${matchId}/events?wait=25&since=${encodeURIComponent(version ?? '')}`,
      );
      version = ev.version;
      status = ev.status;
      result = ev.result;
      if (ev.state?.fen) {
        fen = ev.state.fen;
        yourMove = status === 'active' && seatToMove(ev.state) === seat;
      }

      // `timedOut` means the wait elapsed with nothing new. An opponent that
      // stops moving would otherwise hold this match — and the entry fee — open
      // forever, so once enough of those stack up, test the clock. The server
      // refuses the claim while there is still time on it, which is the answer
      // we want and costs nothing.
      if (ev.timedOut && ++idleWaits >= WAITS_BEFORE_FLAG_CLAIM) {
        idleWaits = 0;
        const claim = await call('POST', `/v1/chess/${matchId}/move`, {
          action: 'claim_flag',
        }).catch((e) => {
          // "There is still time on that clock" is a 400 and a perfectly good
          // answer. Anything else is a real failure and must not be swallowed.
          if (e instanceof ApiError && (e.status === 400 || e.status === 409)) return null;
          throw e;
        });
        if (claim?.terminal) {
          result = claim.terminal;
          status = 'finished';
        }
      } else if (!ev.timedOut) {
        idleWaits = 0;
      }
      continue;
    }

    const move = chooseMove(fen);
    if (!move) {
      // Checkmate or stalemate on our side. The server settles it.
      console.log('No legal moves — the server will settle this.');
      break;
    }

    console.log(`  ${move.san}`);
    const played = await call('POST', `/v1/chess/${matchId}/move`, {
      action: 'move',
      from: move.from,
      to: move.to,
      ...(move.promotion ? { promotion: move.promotion } : {}),
    });

    // The move response is an acknowledgement, not a board: `{matchId, terminal,
    // reason, ratingDeltas}`. Nothing on this API hands one back, so the
    // position comes from replaying our own move and from the next wait.
    if (played.terminal) {
      result = played.terminal;
      status = 'finished';
      break;
    }
    // We know the new position exactly — it is our own move. Replayed on a
    // fresh board rather than read from `move.after`, which older chess.js
    // builds do not carry.
    const advanced = new Chess(fen);
    advanced.move(move);
    fen = advanced.fen();
    yourMove = false;
    version = null;
    idleWaits = 0;
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
  console.log(`Clubhouse chess agent ${account.address} → ${API}`);
  await playMatch(await takeSeat());
}

main().catch((e) => {
  console.error(`\n${e.message}`);
  process.exit(1);
});
