/**
 * Deterministic ball racks + spot positions for 8-ball and 9-ball.
 *
 * Positions are fixed (no randomness) so a match is perfectly reproducible and
 * fair. Interior arrangement is legal-but-arbitrary; what's enforced is what the
 * rules require: 8-ball has the 8 in the centre of the third row with one solid
 * and one stripe in the back corners; 9-ball has the 1 at the apex and the 9 in
 * the centre.
 */

import { PLAY_W, PLAY_H, BALL_R } from './physics.js';

export interface RackBall {
  id: number;
  x: number;
  y: number;
}

/** Foot spot (apex of the rack) and head spot (cue for the break). */
export const FOOT_SPOT = { x: PLAY_W * 0.75, y: PLAY_H / 2 };
export const HEAD_SPOT = { x: PLAY_W * 0.25, y: PLAY_H / 2 };
/** The head string — the break must be taken from behind it (smaller x). */
export const HEAD_STRING_X = PLAY_W * 0.25;

const S = BALL_R * 2 + 0.04; // centre-to-centre spacing (near-touching)
const DX = S * Math.cos(Math.PI / 6); // row-to-row spacing toward the foot rail
const CY = PLAY_H / 2;

/** Lay out rows of ids into positions, each row centred on the long axis. */
function layout(rows: number[][]): RackBall[] {
  const balls: RackBall[] = [];
  rows.forEach((row, r) => {
    const x = FOOT_SPOT.x + r * DX;
    const n = row.length;
    row.forEach((id, i) => {
      const y = CY + (i - (n - 1) / 2) * S;
      balls.push({ id, x, y });
    });
  });
  return balls;
}

/** 8-ball rack: 8 in the centre of row 3, one solid + one stripe in the corners. */
export function rack8Ball(): RackBall[] {
  return layout([
    [1],
    [10, 2],
    [3, 8, 11],
    [12, 4, 13, 5],
    [6, 14, 7, 15, 9],
  ]);
}

/** 9-ball diamond rack: 1 at the apex, 9 dead centre. */
export function rack9Ball(): RackBall[] {
  return layout([
    [1],
    [2, 3],
    [4, 9, 5],
    [6, 7],
    [8],
  ]);
}

export function cueStart(): RackBall {
  return { id: 0, x: HEAD_SPOT.x, y: HEAD_SPOT.y };
}
