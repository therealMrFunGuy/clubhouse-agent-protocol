/**
 * 8-ball group presentation — the single source of truth for "which balls are
 * mine, what are they called, and what colour are they".
 *
 * Deliberately DEPENDENCY-FREE (no physics, no matchState, no React), for the
 * same reason lib/poker/preAction.ts and lib/poker/seatLayout.ts are: the HUD,
 * the canvas and the tests all need this, and none of them should have to pull
 * the rules engine in to get it.
 *
 * The important property is `targetIds`: it returns exactly the balls the server
 * will accept as a legal FIRST CONTACT for that player. Anything this module
 * highlights is a shot the engine will allow; anything it doesn't is a foul.
 * If judge8Ball / judge9Ball ever change, change this with them — the whole
 * point of highlighting is that the highlight cannot lie.
 */

export type Group = 'solid' | 'stripe';
export type PoolGameId = 'pool8' | 'pool9';

/** Minimal ball shape — matches PersistBall without importing it. */
export interface BallLike { id: number; pk: boolean }

export const SOLID_IDS: readonly number[] = [1, 2, 3, 4, 5, 6, 7];
export const STRIPE_IDS: readonly number[] = [9, 10, 11, 12, 13, 14, 15];
export const EIGHT = 8;

/** Base hue per ball. Solids and their striped partner share a colour (1 & 9, 2 & 10, ...). */
const BALL_HUE: Record<number, string> = {
  1: '#e6c200', 2: '#1f4fd8', 3: '#d61f1f', 4: '#6b1fb0',
  5: '#e6721f', 6: '#1f9e4f', 7: '#8a2b2b',
};

export function groupOfBall(id: number): Group | 'eight' | 'cue' {
  if (id === 0) return 'cue';
  if (id === EIGHT) return 'eight';
  return id <= 7 ? 'solid' : 'stripe';
}

/** The ball's own colour (the stripe band's colour for 9-15). */
export function ballHue(id: number): string {
  if (id === 0) return '#f4f4f0';
  if (id === EIGHT) return '#141414';
  return BALL_HUE[id <= 7 ? id : id - 8] || '#888888';
}

/** A CSS background that reads as that ball: flat for solids, banded for stripes. */
export function ballFill(id: number): string {
  if (id === 0) return '#f4f4f0';
  if (id === EIGHT) return '#141414';
  const hue = ballHue(id);
  return id >= 9
    ? `linear-gradient(to bottom, #f4f4f0 0 26%, ${hue} 26% 74%, #f4f4f0 74% 100%)`
    : hue;
}

export function groupIds(g: Group): readonly number[] {
  return g === 'solid' ? SOLID_IDS : STRIPE_IDS;
}

export function otherGroup(g: Group): Group {
  return g === 'solid' ? 'stripe' : 'solid';
}

/** "Solids" / "Stripes" — capitalised for a label, never relied on alone (see the HUD swatch). */
export function groupLabel(g: Group): string {
  return g === 'solid' ? 'Solids' : 'Stripes';
}

/** "1-7" / "9-15" — the range spelled out, because the two words are easy to misread. */
export function groupRange(g: Group): string {
  return g === 'solid' ? '1–7' : '9–15';
}

/** Ids of that group still on the table, ascending. */
export function remainingOf(balls: BallLike[], g: Group): number[] {
  const ids = new Set(groupIds(g));
  return balls.filter((b) => !b.pk && ids.has(b.id)).map((b) => b.id).sort((a, b) => a - b);
}

/** Has this group been cleared, so the 8 is live for them? */
export function groupCleared(balls: BallLike[], g: Group): boolean {
  return remainingOf(balls, g).length === 0;
}

/** 9-ball's "ball on": the lowest object ball still up. */
export function lowestBallOn(balls: BallLike[]): number | null {
  let lo: number | null = null;
  for (const b of balls) {
    if (b.id === 0 || b.pk) continue;
    if (lo === null || b.id < lo) lo = b.id;
  }
  return lo;
}

/**
 * The balls this player may legally strike first, right now.
 *
 *  • 9-ball        -> the lowest ball on, always.
 *  • 8-ball, group -> their remaining group balls, or the 8 once cleared.
 *  • 8-ball, open  -> EMPTY on purpose. Any non-8 is legal on an open table, so
 *    highlighting would mean lighting up fourteen balls, which tells the player
 *    nothing. The HUD says "Open table" instead.
 */
export function targetIds(game: PoolGameId, balls: BallLike[], group: Group | null): number[] {
  if (game === 'pool9') {
    const lo = lowestBallOn(balls);
    return lo === null ? [] : [lo];
  }
  if (!group) return [];
  const mine = remainingOf(balls, group);
  return mine.length ? mine : (balls.some((b) => b.id === EIGHT && !b.pk) ? [EIGHT] : []);
}

/**
 * The one-line status under a player's rack: how many of theirs are left, and
 * whether the 8 is live. Written as a running count so a new player learns the
 * win condition by playing rather than by reading rules.
 */
export function groupProgress(balls: BallLike[], g: Group | null): string {
  if (!g) return 'Open table';
  const left = remainingOf(balls, g).length;
  if (left === 0) return 'On the 8';
  return `${left} to go, then the 8`;
}
