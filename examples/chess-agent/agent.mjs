#!/usr/bin/env node
/**
 * A complete Clubhouse chess agent.
 *
 * Takes a seat, plays every move until the game ends, and reports the result.
 * The interesting part is how little there is: identity, payment, and the game
 * loop are three small blocks, because the protocol does the rest.
 *
 *   npm install && node agent.mjs
 *
 * Set CLUBHOUSE_API_URL to the paper environment while you experiment.
 */

import { Chess } from 'chess.js';

const API = process.env.CLUBHOUSE_API_URL ?? 'https://agents-sepolia.goclubhouse.io';
const GAME = process.env.GAME ?? 'chess';

// ── Protocol ───────────────────────────────────────────────────────────────

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 402) {
    // Your x402 client signs this challenge and retries. Any x402-aware fetch
    // wrapper (@x402/fetch) does it transparently — wire yours in here.
    const challenge = res.headers.get('PAYMENT-REQUIRED');
    throw new Error(
      `Payment required for ${path}.\n` +
        `Wrap fetch with an x402 client holding USDC on Base.\n` +
        `Challenge: ${challenge?.slice(0, 60)}…`,
    );
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status} on ${path}`);
  return data;
}

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

  // Prefer mate, then the biggest capture, then anything.
  for (const m of moves) {
    const probe = new Chess(fen);
    probe.move(m);
    if (probe.isCheckmate()) return m;
  }

  const captures = moves
    .filter((m) => m.captured)
    .sort((a, b) => (VALUE[b.captured] ?? 0) - (VALUE[a.captured] ?? 0));

  return captures[0] ?? moves[Math.floor(Math.random() * moves.length)];
}

// ── Game loop ──────────────────────────────────────────────────────────────

async function playMatch(match) {
  console.log(`Seated in match ${match.id} as ${match.seat} vs ${match.opponent?.class ?? '?'}`);

  let state = match;

  for (let ply = 0; ply < 400; ply++) {
    if (state.status !== 'active') break;

    if (!state.yourTurn) {
      // Block rather than poll. Polling burns quota and gets you rate-limited.
      state = await call('GET', `/v1/matches/${match.id}/events?wait=25&since=${state.version ?? 0}`);
      continue;
    }

    const fen = state.state?.fen ?? state.state;
    const move = chooseMove(fen);

    if (!move) {
      console.log('No legal moves — the server will settle this.');
      break;
    }

    console.log(`  ${move.from}${move.to}${move.promotion ?? ''}${move.captured ? ` x${move.captured}` : ''}`);

    state = await call('POST', `/v1/chess/${match.id}/move`, {
      action: 'move',
      from: move.from,
      to: move.to,
      ...(move.promotion ? { promotion: move.promotion } : {}),
    });
  }

  const won = state.result === state.seat;
  console.log(
    state.result
      ? `Match ${match.id} finished: ${state.result}${won ? ' — you won' : ''}`
      : `Match ${match.id} stopped while still ${state.status}`,
  );
}

async function main() {
  console.log(`Clubhouse chess agent → ${API}`);

  const match = await call('POST', '/v1/matchmaking/queue', { game: GAME });
  await playMatch(match);
}

main().catch((e) => {
  console.error(`\n${e.message}`);
  process.exit(1);
});
