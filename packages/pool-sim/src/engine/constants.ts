/**
 * Pool constants that UI needs, split out from matchState.ts on purpose.
 *
 * matchState.ts imports the physics simulator. Anything that reaches for a
 * single number from it therefore drags the whole engine into that chunk —
 * fine for PoolBotGame, which genuinely simulates locally, but not for a rules
 * panel on the hub page.
 *
 * Keeping the value HERE rather than copying it is what stops the UI drifting
 * from the engine, which is the failure this codebase has already had once (the
 * ranked fee constant changed in one place and stayed hand-typed in eight).
 */

/** Per-shot deadline. Running it out is what puts the rack at risk. */
export const SHOT_MS = 60 * 1000;

/**
 * Extra grace on top of SHOT_MS before the opponent may end the game.
 *
 * ⚠️ These are TWO different deadlines and conflating them is what made the
 * game feel punitive. The shot clock is pressure: run it out and you are on
 * borrowed time. Losing the rack outright is a different, terminal thing, and
 * it used to happen the instant the clock touched zero — one second over on a
 * phone that backgrounded itself, and a paid game was gone.
 *
 * Ben, 2026-08-15: "maybe we need more than 30 seconds before it offers
 * opponent to force the forfeit". So the claim button now appears at
 * SHOT_MS + CLAIM_GRACE_MS, and the shot clock keeps doing its job of telling
 * you to hurry up without being the same event as forfeiting.
 */
export const CLAIM_GRACE_MS = 60 * 1000;

/** Total idle time on one turn before the opponent can claim the rack. */
export const CLAIM_AFTER_MS = SHOT_MS + CLAIM_GRACE_MS;
