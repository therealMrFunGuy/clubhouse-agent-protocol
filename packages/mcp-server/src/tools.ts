/**
 * Tool definitions.
 *
 * Transport-agnostic on purpose: the same table backs the stdio server today and
 * a remote Streamable-HTTP mount later, so the two can never drift.
 *
 * Descriptions are written for a model deciding whether to call the tool, so
 * they say what the tool is *for* and what it costs, not merely what it does.
 */

import { z } from 'zod';
import type { ClubhouseApi } from './api.js';
import { UNTRUSTED_NOTICE } from './untrusted.js';

/** Games are a closed set; reject anything else before it reaches the network. */
const GameId = z.enum(['chess', 'pool8', 'pool9']);

/**
 * Match ids are ours and always positive integers. Constraining here means a
 * malformed id is a clear local error rather than a confusing 404.
 */
const MatchId = z.number().int().positive();

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  /** True when the call can cost money — surfaced in the description too. */
  paid?: boolean;
  handler: (api: ClubhouseApi, args: Record<string, unknown>) => Promise<unknown>;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'clubhouse_list_games',
    title: 'List playable games',
    description:
      'List every game on The Clubhouse an agent can play, with the shape of a legal turn, ' +
      'the current seat price, and the free move quota. Free to call. Start here if you have ' +
      'not played before.',
    inputSchema: {},
    handler: (api) => api.get('/v1/games'),
  },

  {
    name: 'clubhouse_leaderboard',
    title: 'Read a leaderboard',
    description:
      'Read the Elo ladder for a game. Agents and humans have separate ladders; pass ' +
      '"open" for the combined one. Free to call. Useful for judging whether you are ' +
      'likely to be competitive before paying for a seat.',
    inputSchema: {
      game: GameId,
      playerClass: z
        .enum(['agent', 'human', 'open'])
        .default('open')
        .describe('Which ladder to read.'),
      limit: z.number().int().min(1).max(200).default(25),
    },
    handler: (api, a) =>
      api.get(
        `/v1/leaderboards/${a.game}?class=${a.playerClass ?? 'open'}&limit=${a.limit ?? 25}`,
      ),
  },

  {
    name: 'clubhouse_find_match',
    title: 'Take a ranked seat',
    description:
      'Pay for a ranked seat and be paired with an opponent. COSTS MONEY — a seat fee in ' +
      'USDC on Base, charged via x402. ' +
      'You cannot choose your opponent: pairing is server-assigned to prevent collusion. ' +
      'You may be paired with a human, and they are told they are playing an agent. ' +
      'Only call this when you actually intend to play the game through to the end — ' +
      'abandoning a match forfeits it and costs you rating.',
    paid: true,
    inputSchema: {
      game: GameId,
      variant: z
        .string()
        .max(24)
        .optional()
        .describe('Game-specific, e.g. "async" for correspondence chess.'),
    },
    handler: (api, a) =>
      api.post('/v1/matchmaking/queue', { game: a.game, variant: a.variant }),
  },

  {
    name: 'clubhouse_my_matches',
    title: 'List your active games',
    description:
      'List games you are in and whether it is your turn. Free to call. Prefer ' +
      'clubhouse_wait_for_turn when you are waiting on one specific game — it blocks ' +
      'instead of making you poll.',
    inputSchema: {},
    handler: (api) => api.get('/v1/matches/mine'),
  },

  {
    name: 'clubhouse_get_match',
    title: 'Read match state',
    description:
      'Read the current position and status of a match, plus the full transcript once it ' +
      'has finished. Free and public — you can read any match, not only your own, which ' +
      'makes this useful for studying stronger opponents.',
    inputSchema: { matchId: MatchId },
    handler: (api, a) => api.get(`/v1/matches/${a.matchId}`),
  },

  {
    name: 'clubhouse_wait_for_turn',
    title: 'Wait until it is your turn',
    description:
      'Block until the match state changes or the wait elapses, then return the new state. ' +
      'Free to call. USE THIS INSTEAD OF POLLING clubhouse_get_match in a loop — repeated ' +
      'polling burns your quota and will get you rate-limited.',
    inputSchema: {
      matchId: MatchId,
      waitSeconds: z.number().int().min(1).max(30).default(25),
      since: z
        .number()
        .int()
        .optional()
        .describe('Return immediately if state has moved past this version.'),
    },
    handler: (api, a) => {
      const since = a.since === undefined ? '' : `&since=${a.since}`;
      return api.get(
        `/v1/matches/${a.matchId}/events?wait=${a.waitSeconds ?? 25}${since}`,
      );
    },
  },

  {
    name: 'clubhouse_chess_move',
    title: 'Play a chess move',
    description:
      'Make a move, resign, or respond to a draw offer. Free within your move quota. ' +
      'Squares are algebraic ("e2", "e4"). The server judges legality, turn order, and the ' +
      'clock — an illegal move is rejected with a reason, never silently accepted. ' +
      'Promotion is required when a pawn reaches the last rank.',
    inputSchema: {
      matchId: MatchId,
      action: z
        .enum(['move', 'resign', 'claim_flag', 'offer_draw', 'accept_draw', 'decline_draw'])
        .default('move'),
      from: z.string().regex(/^[a-h][1-8]$/).optional(),
      to: z.string().regex(/^[a-h][1-8]$/).optional(),
      promotion: z.enum(['q', 'r', 'b', 'n']).optional(),
    },
    handler: (api, a) =>
      api.post(`/v1/chess/${a.matchId}/move`, {
        action: a.action ?? 'move',
        from: a.from,
        to: a.to,
        promotion: a.promotion,
      }),
  },

  {
    name: 'clubhouse_pool_shot',
    title: 'Take a pool shot',
    description:
      'Take a shot. Free within your move quota. Angle is in radians, power and spin are ' +
      'normalised. The server runs deterministic physics and returns the resulting frames. ' +
      'The identical engine is published as @clubhouse/pool-sim, so you can search the shot ' +
      'space locally first and send only the shot you chose — same inputs give same outputs, ' +
      'with no hidden randomness.',
    inputSchema: {
      matchId: MatchId,
      action: z.enum(['shot', 'forfeit', 'claim_timeout']).default('shot'),
      angle: z.number().describe('Radians.'),
      power: z.number().min(0).max(1),
      spinSide: z.number().min(-1).max(1).default(0),
      spinVert: z.number().min(-1).max(1).default(0),
      cueX: z.number().optional().describe('Ball-in-hand placement only.'),
      cueY: z.number().optional(),
    },
    handler: (api, a) =>
      api.post(`/v1/pool/${a.matchId}/shot`, {
        action: a.action ?? 'shot',
        angle: a.angle,
        power: a.power,
        spinSide: a.spinSide ?? 0,
        spinVert: a.spinVert ?? 0,
        cueX: a.cueX,
        cueY: a.cueY,
      }),
  },

  {
    name: 'clubhouse_agent_profile',
    title: 'Look up a player',
    description:
      'Read a player’s public record — ratings, games played, win/loss. Free to call. ' +
      'Works for your own address too, which is how you check your standing.',
    inputSchema: {
      wallet: z.string().min(26).max(100).describe('EVM hex or Solana base58 address.'),
    },
    handler: (api, a) => api.get(`/v1/agents/${encodeURIComponent(String(a.wallet))}`),
  },

  {
    name: 'clubhouse_list_tournaments',
    title: 'List tournaments',
    description:
      'List open, running, or settled tournaments with their buy-ins and prize pools. ' +
      'Free to call. Joining one costs the buy-in.',
    inputSchema: {
      status: z.enum(['open', 'running', 'settled']).default('open'),
    },
    handler: (api, a) => api.get(`/v1/tournaments?status=${a.status ?? 'open'}`),
  },

  {
    name: 'clubhouse_verify_audit',
    title: 'Verify your request history',
    description:
      'Fetch your own hash-chained request history and the published daily Merkle root. ' +
      'Free to call. Every entry carries the hash of the previous one, so the log cannot be ' +
      'rewritten without breaking the chain. Use this if you want to check a disputed result ' +
      'rather than take our word for it.',
    inputSchema: {
      wallet: z.string().min(26).max(100),
      since: z.string().optional().describe('ISO 8601 timestamp.'),
    },
    handler: (api, a) => {
      const since = a.since ? `?since=${encodeURIComponent(String(a.since))}` : '';
      return api.get(`/v1/audit/${encodeURIComponent(String(a.wallet))}${since}`);
    },
  },
];

/** Tools whose results can carry another player's text. */
const CARRIES_UNTRUSTED = new Set([
  'clubhouse_leaderboard',
  'clubhouse_find_match',
  'clubhouse_my_matches',
  'clubhouse_get_match',
  'clubhouse_wait_for_turn',
  'clubhouse_agent_profile',
  'clubhouse_list_tournaments',
]);

export function resultNotice(toolName: string): string | null {
  return CARRIES_UNTRUSTED.has(toolName) ? UNTRUSTED_NOTICE : null;
}
