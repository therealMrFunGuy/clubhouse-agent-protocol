/**
 * Pool match state + rules — the JSON blob stored in game_matches.state.
 *
 * The server owns this entirely and is authoritative: it takes a shot (aim, power,
 * spin, optional ball-in-hand placement), runs the deterministic physics simulator,
 * judges the result against 8-ball / 9-ball rules, and returns the resulting state,
 * animation frames, and any terminal result. A client can never assert an outcome.
 *
 * p1 = the player who was WAITING when matched → breaks first.
 *
 * Documented simplifications for v1 (both players play the identical ruleset, so
 * they're fair): pockets are not "called" (any pocket counts); 9-ball has no
 * push-out; 8-on-the-break wins for the breaker (bar rule). Everything else follows
 * standard rules — group assignment, ball-in-hand on all fouls, wrong-ball and
 * no-rail fouls, loss on early/foul 8.
 */

import {
  simulateShot,
  mkBall,
  PLAY_W,
  PLAY_H,
  BALL_R,
  POCKETS,
  type Ball,
  type ShotInput,
  type ShotFrame,
} from './physics.js';
import { rack8Ball, rack9Ball, cueStart, FOOT_SPOT, HEAD_STRING_X } from './rack.js';

export type PoolGame = 'pool8' | 'pool9';
export type Seat = 'p1' | 'p2';
export type Group = 'solid' | 'stripe';

/** Per-shot deadline; the opponent can claim the game if you sit on your turn.
 *  Defined in ./constants so UI can read it without pulling in the simulator.
 *  Imported (not just re-exported) because claimShotClock uses it in here. */
import { SHOT_MS, CLAIM_AFTER_MS } from './constants.js';
export { SHOT_MS, CLAIM_AFTER_MS };

export interface PersistBall {
  id: number;
  x: number;
  y: number;
  pk: boolean; // pocketed
}

export interface PoolState {
  game: PoolGame;
  balls: PersistBall[];
  turn: Seat;
  /** 'break' before the opening shot, then 'open' (8-ball, groups unset) → 'play'. */
  phase: 'break' | 'open' | 'play' | 'over';
  ballInHand: boolean;
  /** 8-ball only: which group each seat is on (null until assigned). */
  groups: { p1: Group | null; p2: Group | null };
  turnStartAt: number;
  startedAt: number;
  /** monotonically increments each resolved shot (lets an observer detect a new shot). */
  shotSeq: number;
  /**
   * The exact, resolved parameters of the last shot (including the cue's actual
   * position at strike). Because the physics engine is pure + deterministic, an
   * observing client can re-simulate from the pre-shot layout + these params and
   * reproduce byte-identical animation frames — no need to ship frames over GET.
   */
  lastShotParams: {
    angle: number; power: number; spinSide: number; spinVert: number; cueX: number; cueY: number;
  } | null;
  /** summary of the most recent shot for the UI. */
  lastShot: {
    by: Seat;
    foul: boolean;
    reason: string | null;
    pocketed: number[];
    continued: boolean;
  } | null;
  winner: Seat | null;
  winReason: string | null;
}

export interface ShotResult {
  ok: boolean;
  error?: string;
  state?: PoolState;
  /** animation frames the client plays back (server-computed, authoritative). */
  frames?: ShotFrame[];
  /** terminal result when the game ended on this shot. */
  result?: Seat;
  reason?: string;
}

// ── Ball classification ──────────────────────────────────────────────────────
export function groupOf(id: number): Group | 'eight' | 'cue' {
  if (id === 0) return 'cue';
  if (id === 8) return 'eight';
  return id <= 7 ? 'solid' : 'stripe';
}

function initialRack(game: PoolGame): PersistBall[] {
  const rack = game === 'pool8' ? rack8Ball() : rack9Ball();
  const balls: PersistBall[] = [{ ...cueStart(), pk: false }];
  for (const b of rack) balls.push({ id: b.id, x: b.x, y: b.y, pk: false });
  return balls;
}

export function initPoolState(game: PoolGame, nowMs: number): PoolState {
  return {
    game,
    balls: initialRack(game),
    turn: 'p1',
    phase: 'break',
    ballInHand: false,
    groups: { p1: null, p2: null },
    turnStartAt: nowMs,
    startedAt: nowMs,
    shotSeq: 0,
    lastShotParams: null,
    lastShot: null,
    winner: null,
    winReason: null,
  };
}

function persistToBalls(persist: PersistBall[]): Ball[] {
  return persist.filter((b) => !b.pk).map((b) => {
    const ball = mkBall(b.id, b.x, b.y);
    return ball;
  });
}

function opponent(seat: Seat): Seat {
  return seat === 'p1' ? 'p2' : 'p1';
}

/** Lowest-numbered object ball still on the table (9-ball's "ball on"). */
function lowestBall(balls: PersistBall[]): number | null {
  let lo: number | null = null;
  for (const b of balls) {
    if (b.id === 0 || b.pk) continue;
    if (lo === null || b.id < lo) lo = b.id;
  }
  return lo;
}

function remainingOfGroup(balls: PersistBall[], group: Group): number {
  return balls.filter((b) => !b.pk && groupOf(b.id) === group).length;
}

/** Is a candidate cue position legal (in bounds, clear of balls + pockets)? */
function cuePlacementError(state: PoolState, x: number, y: number): string | null {
  if (x < BALL_R || x > PLAY_W - BALL_R || y < BALL_R || y > PLAY_H - BALL_R) {
    return 'Cue ball out of bounds';
  }
  // "Normal pool" placement: on the BREAK and after a SCRATCH (cue pocketed) the cue
  // must be placed behind the head string. A non-scratch foul is ball-in-hand
  // anywhere (standard). scratched = the cue ball is currently pocketed.
  const cueScratched = state.balls.some((b) => b.id === 0 && b.pk);
  const behindLineRequired = state.phase === 'break' || (state.ballInHand && cueScratched);
  if (behindLineRequired && x > HEAD_STRING_X) {
    return 'Place the cue ball behind the head string';
  }
  for (const p of POCKETS) {
    if (Math.hypot(x - p.x, y - p.y) < BALL_R * 2) return 'Too close to a pocket';
  }
  for (const b of state.balls) {
    if (b.id === 0 || b.pk) continue;
    if (Math.hypot(x - b.x, y - b.y) < BALL_R * 2) return 'Overlaps another ball';
  }
  return null;
}

/** Find an open spot to re-place the cue after a scratch (near the head spot). */
function findCueSpot(state: PoolState): { x: number; y: number } {
  const candidates: Array<{ x: number; y: number }> = [];
  const baseX = HEAD_STRING_X;
  for (let dx = 0; dx <= baseX - BALL_R; dx += BALL_R) {
    for (let dy = 0; dy <= PLAY_H / 2 - BALL_R; dy += BALL_R) {
      candidates.push({ x: baseX - dx, y: PLAY_H / 2 + dy });
      candidates.push({ x: baseX - dx, y: PLAY_H / 2 - dy });
    }
  }
  for (const c of candidates) {
    if (!cuePlacementError({ ...state, phase: 'play' }, c.x, c.y)) return c;
  }
  return { x: HEAD_STRING_X, y: PLAY_H / 2 };
}

/** Re-spot a ball (9-ball's 9 after a foul pot) on/behind the foot spot. */
function findSpotFor(state: PoolState, occupied: PersistBall[]): { x: number; y: number } {
  for (let dx = 0; dx <= PLAY_W - FOOT_SPOT.x - BALL_R; dx += BALL_R) {
    const x = FOOT_SPOT.x + dx;
    const clash = occupied.some((b) => !b.pk && b.id !== 0 && Math.hypot(x - b.x, FOOT_SPOT.y - b.y) < BALL_R * 2);
    if (!clash && x <= PLAY_W - BALL_R) return { x, y: FOOT_SPOT.y };
  }
  return { x: FOOT_SPOT.x, y: FOOT_SPOT.y };
}

/**
 * Apply a shot. `shot.cueX/cueY` are honoured only when the incoming player has
 * ball-in-hand (or is breaking). Returns the next state + frames, and a terminal
 * result when the game is decided.
 */
export function applyShot(
  state: PoolState,
  seat: Seat,
  shot: ShotInput & { cueX?: number; cueY?: number },
  nowMs: number,
): ShotResult {
  if (state.phase === 'over') return { ok: false, error: 'Game is over' };
  if (state.turn !== seat) return { ok: false, error: 'Not your turn' };

  const next: PoolState = JSON.parse(JSON.stringify(state));

  // ── Ball-in-hand / break placement ─────────────────────────────────────────
  const cue = next.balls.find((b) => b.id === 0)!;
  const wantsPlace = typeof shot.cueX === 'number' && typeof shot.cueY === 'number';
  if (next.ballInHand || next.phase === 'break') {
    if (wantsPlace) {
      const err = cuePlacementError(next, shot.cueX!, shot.cueY!);
      if (err) return { ok: false, error: err };
      cue.x = shot.cueX!; cue.y = shot.cueY!; cue.pk = false;
    } else if (cue.pk) {
      // Scratched with no placement supplied — auto-place.
      const spot = findCueSpot(next);
      cue.x = spot.x; cue.y = spot.y; cue.pk = false;
    }
    next.ballInHand = false;
  } else if (wantsPlace) {
    return { ok: false, error: "You don't have ball in hand" };
  }
  if (cue.pk) return { ok: false, error: 'Cue ball is off the table' };

  // Normalize the shot inputs ONCE, up front, and use the SAME normalized values
  // for both the persisted lastShotParams and the simulation. This guarantees the
  // observer (which re-simulates from lastShotParams) feeds byte-identical inputs
  // to the pure engine:
  //   • angle wrapped into [0, 2π) — a huge raw angle (e.g. 1e300) makes V8's trig
  //     argument-reduction results implementation-dependent, so the server and the
  //     observer could otherwise compute divergent frames. (Judged result is server-
  //     authoritative regardless; this keeps the animation in sync.)
  //   • spin clamped to [-1, 1] to match strikeCue's internal clamp, so the stored
  //     value can never differ from the value actually simulated.
  const TWO_PI = Math.PI * 2;
  const nAngle = ((shot.angle % TWO_PI) + TWO_PI) % TWO_PI;
  const nPower = Math.max(0, Math.min(1, shot.power));
  const nSpinSide = Math.max(-1, Math.min(1, shot.spinSide ?? 0));
  const nSpinVert = Math.max(-1, Math.min(1, shot.spinVert ?? 0));

  // Record the fully-resolved shot (incl. the cue's actual strike position) so an
  // observing client can deterministically re-simulate the identical animation.
  next.shotSeq = state.shotSeq + 1;
  next.lastShotParams = {
    angle: nAngle,
    power: nPower,
    spinSide: nSpinSide,
    spinVert: nSpinVert,
    cueX: cue.x,
    cueY: cue.y,
  };

  // ── Simulate ────────────────────────────────────────────────────────────────
  const sim = simulateShot(persistToBalls(next.balls), { angle: nAngle, power: nPower, spinSide: nSpinSide, spinVert: nSpinVert });
  const ev = sim.events;

  // Write resting positions + pocketed flags back to persistent state.
  const restById = new Map<number, Ball>();
  for (const b of sim.balls) restById.set(b.id, b);
  for (const b of next.balls) {
    const r = restById.get(b.id);
    if (!r) continue;
    b.x = Math.round(r.x * 100) / 100;
    b.y = Math.round(r.y * 100) / 100;
    if (r.pocketed) b.pk = true;
  }

  const isBreak = state.phase === 'break';
  const wasOpen = state.phase === 'open' || state.phase === 'break';

  // Judge the shot per game.
  const judged =
    next.game === 'pool8'
      ? judge8Ball(state, next, seat, ev, isBreak, wasOpen)
      : judge9Ball(state, next, seat, ev, isBreak);

  // Apply re-spots / cue scratch handling decided by the judge.
  if (ev.cueScratched) {
    cue.pk = true; // will be placed by the incoming player (ball in hand)
  }

  next.lastShot = {
    by: seat,
    foul: judged.foul,
    reason: judged.reason,
    pocketed: ev.pocketed,
    continued: judged.continueTurn && !judged.winner,
  };

  // ── Terminal? ───────────────────────────────────────────────────────────────
  if (judged.winner) {
    next.phase = 'over';
    next.winner = judged.winner;
    next.winReason = judged.reason || 'win';
    return { ok: true, state: next, frames: sim.frames, result: judged.winner, reason: next.winReason || undefined };
  }

  // Advance phase (8-ball open → play once a group is set).
  if (next.game === 'pool8') {
    if (next.groups.p1 || next.groups.p2) next.phase = 'play';
    else next.phase = 'open';
  } else {
    next.phase = 'play';
  }

  // ── Turn + ball-in-hand ─────────────────────────────────────────────────────
  if (judged.foul) {
    next.turn = opponent(seat);
    next.ballInHand = true;
  } else if (judged.continueTurn) {
    next.turn = seat;
    next.ballInHand = false;
  } else {
    next.turn = opponent(seat);
    next.ballInHand = false;
  }
  next.turnStartAt = nowMs;

  return { ok: true, state: next, frames: sim.frames };
}

interface Judgement {
  foul: boolean;
  reason: string | null;
  continueTurn: boolean;
  winner: Seat | null;
}

// ── 8-ball rules ──────────────────────────────────────────────────────────────
function judge8Ball(
  prev: PoolState,
  next: PoolState,
  seat: Seat,
  ev: ReturnType<typeof simulateShot>['events'],
  isBreak: boolean,
  wasOpen: boolean,
): Judgement {
  const myGroup = prev.groups[seat];
  const potted = ev.pocketed;
  const pottedNon8 = potted.filter((id) => id !== 8);
  const eightPotted = potted.includes(8);

  // 8 on the break → breaker wins (bar rule); scratch on that break → loss.
  if (isBreak && eightPotted) {
    if (ev.cueScratched) return { foul: true, reason: '8 pocketed with a scratch on the break — loss', continueTurn: false, winner: opponent(seat) };
    return { foul: false, reason: '8-ball on the break — win!', continueTurn: false, winner: seat };
  }

  // Determine legality of contact.
  let foul = false;
  let reason: string | null = null;
  if (ev.cueScratched) { foul = true; reason = 'Scratch (cue ball pocketed)'; }
  else if (ev.firstContact === null) { foul = true; reason = 'No ball hit'; }
  else {
    const fcGroup = groupOf(ev.firstContact);
    if (!wasOpen && myGroup) {
      const cleared = remainingOfGroup(prev.balls, myGroup) === 0;
      if (fcGroup === 'eight' && !cleared) { foul = true; reason = 'Hit the 8 before clearing your group'; }
      else if (fcGroup !== 'eight' && fcGroup !== myGroup) { foul = true; reason = `Hit ${fcGroup} first — not your group`; }
    } else {
      // Open table (or break): may not strike the 8 first.
      if (fcGroup === 'eight') { foul = true; reason = 'Hit the 8 on an open table'; }
    }
    // No-rail foul: after a legal contact, some ball must be pocketed or reach a rail.
    if (!foul && potted.length === 0 && !ev.railAfterContact) {
      foul = true; reason = 'No ball pocketed and no rail after contact';
    }
    // Break-specific: must pocket a ball or drive 4 to a rail.
    if (!foul && isBreak && potted.length === 0 && ev.ballsToRail < 4) {
      foul = true; reason = 'Illegal break (fewer than 4 balls to a rail)';
    }
  }

  // Win/loss on the 8 (non-break).
  if (eightPotted) {
    const cleared = remainingOfGroup(prev.balls, myGroup ?? ('solid' as Group)) === 0;
    const legalEight = !foul && myGroup && cleared;
    if (legalEight) return { foul: false, reason: 'Cleared and sank the 8 — win!', continueTurn: false, winner: seat };
    return { foul: true, reason: reason || 'Pocketed the 8 illegally', continueTurn: false, winner: opponent(seat) };
  }

  // Group assignment on an open table (only on a clean shot that potted a non-8).
  if (wasOpen && !isBreak && !foul && pottedNon8.length > 0) {
    const solids = pottedNon8.filter((id) => groupOf(id) === 'solid').length;
    const stripes = pottedNon8.filter((id) => groupOf(id) === 'stripe').length;
    let mine: Group | null = null;
    if (solids > 0 && stripes === 0) mine = 'solid';
    else if (stripes > 0 && solids === 0) mine = 'stripe';
    else mine = groupOf(pottedNon8[0]) as Group; // mixed → first pocketed decides
    next.groups[seat] = mine;
    next.groups[opponent(seat)] = mine === 'solid' ? 'stripe' : 'solid';
  }

  // Continue if you legally pocketed one of YOUR balls (open table: any non-8 you potted).
  let continueTurn = false;
  if (!foul && pottedNon8.length > 0) {
    const g = next.groups[seat];
    continueTurn = wasOpen || (g ? pottedNon8.some((id) => groupOf(id) === g) : false);
  }

  return { foul, reason, continueTurn, winner: null };
}

// ── 9-ball rules ──────────────────────────────────────────────────────────────
function judge9Ball(
  prev: PoolState,
  next: PoolState,
  seat: Seat,
  ev: ReturnType<typeof simulateShot>['events'],
  isBreak: boolean,
): Judgement {
  const lowestBefore = lowestBall(prev.balls);
  const potted = ev.pocketed;
  const ninePotted = potted.includes(9);

  let foul = false;
  let reason: string | null = null;
  if (ev.cueScratched) { foul = true; reason = 'Scratch (cue ball pocketed)'; }
  else if (ev.firstContact === null) { foul = true; reason = 'No ball hit'; }
  else if (lowestBefore !== null && ev.firstContact !== lowestBefore) {
    foul = true; reason = `Must hit the ${lowestBefore} first`;
  } else if (potted.length === 0 && !ev.railAfterContact) {
    foul = true; reason = 'No ball pocketed and no rail after contact';
  } else if (isBreak && potted.length === 0 && ev.ballsToRail < 4) {
    foul = true; reason = 'Illegal break (fewer than 4 balls to a rail)';
  }

  if (ninePotted) {
    if (!foul) return { foul: false, reason: 'Pocketed the 9 — win!', continueTurn: false, winner: seat };
    // 9 fell on a foul → re-spot it, no win.
    const nine = next.balls.find((b) => b.id === 9);
    if (nine) {
      nine.pk = false;
      const spot = findSpotFor(next, next.balls);
      nine.x = spot.x; nine.y = spot.y;
    }
  }

  const continueTurn = !foul && potted.length > 0;
  return { foul, reason, continueTurn, winner: null };
}

/** Opponent claims the game because the player on turn blew the shot clock. */
export function claimShotClock(state: PoolState, claimant: Seat, nowMs: number): ShotResult {
  if (state.phase === 'over') return { ok: false, error: 'Game is over' };
  if (state.turn === claimant) return { ok: false, error: "Can't claim your own clock" };
  // CLAIM_AFTER_MS, not SHOT_MS. Blowing the shot clock is pressure; ending
  // somebody's paid game is terminal, and the two used to fire on the same
  // tick — a second of lag cost a rack. See constants.ts.
  if (nowMs - state.turnStartAt <= CLAIM_AFTER_MS) return { ok: false, error: 'Opponent still has time' };
  const next: PoolState = JSON.parse(JSON.stringify(state));
  next.phase = 'over';
  next.winner = claimant;
  next.winReason = 'timeout';
  return { ok: true, state: next, result: claimant, reason: 'timeout' };
}
