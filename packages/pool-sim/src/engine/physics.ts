/**
 * Deterministic 2-D pool physics — the authoritative shot simulator.
 *
 * This module is PURE (no Date.now/Math.random, no server or DOM imports) so the
 * exact same code runs (a) server-side to authoritatively resolve a ranked shot and
 * (b) client-side for the free unranked bot game. Given identical inputs it always
 * produces identical output, which is what lets the server trust one result and the
 * client replay the animation frames the server computed.
 *
 * The model is a standard slide→roll billiard model:
 *   • Each ball carries linear velocity v and a "rolling velocity" sp (the surface
 *     speed its spin would produce). Natural rolling ⇔ sp == v. Top/bottom spin
 *     (follow/draw) is just sp initialised ≠ v; the cloth friction then converts the
 *     slip (v − sp) into a change of v over time — so draw pulls the cue back and
 *     follow drives it on, emergently and correctly.
 *   • Side spin (english) is a vertical-axis angular velocity wz that bends cushion
 *     rebounds and throws object balls slightly.
 *   • Ball–ball collisions exchange the velocity component along the line of centres
 *     (equal-mass, near-elastic) and leave the tangential component alone — this is
 *     what produces the textbook 90° stun rule and correct cut-shot angles.
 *
 * Units are inches / seconds (a 9-ft table is 100"×50" of playing surface).
 */

// ── Table + ball geometry ────────────────────────────────────────────────────
export const PLAY_W = 100; // playing surface width  (long rail to long rail)
export const PLAY_H = 50;  // playing surface height (short rail to short rail)
export const BALL_R = 1.125; // 2.25" diameter regulation ball

/** Pocket centres: 4 corners + 2 sides (middle of the long rails). */
export const POCKETS: ReadonlyArray<{ x: number; y: number; corner: boolean }> = [
  { x: 0, y: 0, corner: true },
  { x: PLAY_W, y: 0, corner: true },
  { x: 0, y: PLAY_H, corner: true },
  { x: PLAY_W, y: PLAY_H, corner: true },
  { x: PLAY_W / 2, y: 0, corner: false },
  { x: PLAY_W / 2, y: PLAY_H, corner: false },
];
/**
 * How close a ball centre must get to a pocket centre to fall in. Capture radii
 * are kept >= the mouth half-widths so there is no band where a ball is neither
 * pocketed nor rebounded; an out-of-bounds backstop below is the hard guarantee.
 */
const CORNER_CAPTURE_R = 3.1;
const SIDE_CAPTURE_R = 3.1;
/** Half-width of the rail gap at each pocket (a ball inside this zone can't rebound). */
const CORNER_MOUTH = 3.0;
const SIDE_MOUTH = 3.0;

// ── Physical constants ───────────────────────────────────────────────────────
const G = 386.09;            // gravity, in/s²
const MU_SLIDE = 0.2;        // sliding (kinetic) friction coefficient
const MU_ROLL = 0.015;       // rolling resistance coefficient
const E_CUSH = 0.82;         // cushion restitution
const E_BALL = 0.95;         // ball–ball restitution
const SLIDE_ROLL_FACTOR = 2.5; // solid-sphere coupling: slip decays at (1+2.5)=3.5·μg
const SIDE_DAMP = 1.4;       // per-second decay of side spin
const CUSH_SPIN = 0.16;      // how strongly english bends a cushion rebound
const THROW = 0.018;         // how strongly english throws a struck ball
const V_STOP = 0.7;          // below this speed a rolling ball is snapped to rest

const DT = 1 / 300;          // integration step
const MAX_TIME = 18;         // hard cap on simulated seconds
const MAX_STEPS = Math.round(MAX_TIME / DT);
const RECORD_EVERY = 5;      // record a frame every 5 steps → 60 fps
const MAX_SPEED = 520;       // cue speed at power = 1 (a hard break)
const FOLLOW_FACTOR = 1.3;   // vertical-offset → follow/draw scaling

export interface Ball {
  id: number;   // 0 = cue; 1..15 = numbered object balls
  x: number;
  y: number;
  vx: number;
  vy: number;
  spx: number;  // rolling-velocity vector (spin surface speed)
  spy: number;
  wz: number;   // vertical-axis (side) spin
  pocketed: boolean;
}

export interface ShotInput {
  /** aim direction in radians (0 = +x toward the far short rail). */
  angle: number;
  /** 0..1 cue-stick power. */
  power: number;
  /** side english, −1 (left) .. 1 (right). */
  spinSide?: number;
  /** vertical offset, −1 (draw) .. 1 (follow). */
  spinVert?: number;
}

/** Ordered log of everything the rules layer needs to judge a shot. */
export interface ShotEvents {
  /** first numbered ball the cue ball touched (null = no contact). */
  firstContact: number | null;
  /** object-ball ids pocketed, in the order they fell. */
  pocketed: number[];
  /** true if the cue ball was pocketed (scratch). */
  cueScratched: boolean;
  /** true if any ball touched a cushion AFTER the cue's first ball contact. */
  railAfterContact: boolean;
  /** distinct object balls that touched a cushion (used for break legality). */
  ballsToRail: number;
}

export interface ShotFrame {
  /** balls still in play this frame: [id, x, y] triples, coords rounded to 0.01". */
  b: Array<[number, number, number]>;
}

export interface SimResult {
  frames: ShotFrame[];
  events: ShotEvents;
  balls: Ball[]; // final resting state (pocketed balls flagged)
}

/** Build a still cue/object ball at a position. */
export function mkBall(id: number, x: number, y: number): Ball {
  return { id, x, y, vx: 0, vy: 0, spx: 0, spy: 0, wz: 0, pocketed: false };
}

function hypot(x: number, y: number) {
  return Math.sqrt(x * x + y * y);
}

/** Apply a shot's initial velocity + spin to the cue ball (mutates it). */
export function strikeCue(cue: Ball, shot: ShotInput): void {
  const power = Math.max(0, Math.min(1, shot.power));
  const speed = power * MAX_SPEED;
  const dx = Math.cos(shot.angle);
  const dy = Math.sin(shot.angle);
  cue.vx = dx * speed;
  cue.vy = dy * speed;
  // Follow/draw: set the rolling velocity ahead of (follow) or behind (draw) v.
  const ov = Math.max(-1, Math.min(1, shot.spinVert ?? 0));
  const spSpeed = speed * (1 + ov * FOLLOW_FACTOR);
  cue.spx = dx * spSpeed;
  cue.spy = dy * spSpeed;
  // Side english as vertical-axis spin, scaled by power so a soft tap can't magic-hook.
  const oh = Math.max(-1, Math.min(1, shot.spinSide ?? 0));
  cue.wz = oh * speed * 0.9;
}

/** Is the point on `rail` (a wall) close enough to a pocket to be in its mouth? */
function inPocketMouth(pos: number, railPockets: number[], mouth: number): boolean {
  for (const p of railPockets) if (Math.abs(pos - p) < mouth) return true;
  return false;
}

/**
 * Simulate a shot to rest and return the animation frames + the event log.
 * `balls` is mutated in place to the final resting state (also returned).
 */
export function simulateShot(balls: Ball[], shot: ShotInput): SimResult {
  const cue = balls.find((b) => b.id === 0);
  if (cue && !cue.pocketed) strikeCue(cue, shot);

  const events: ShotEvents = {
    firstContact: null,
    pocketed: [],
    cueScratched: false,
    railAfterContact: false,
    ballsToRail: 0,
  };
  const railed = new Set<number>();
  const frames: ShotFrame[] = [];

  const record = () => {
    const b: Array<[number, number, number]> = [];
    for (const ball of balls) {
      if (ball.pocketed) continue;
      b.push([ball.id, Math.round(ball.x * 100) / 100, Math.round(ball.y * 100) / 100]);
    }
    frames.push({ b });
  };
  record(); // frame 0 = starting layout

  const cornerXs = [0, PLAY_W];
  const sideXs = [PLAY_W / 2];

  for (let step = 0; step < MAX_STEPS; step++) {
    let anyMoving = false;

    // ── 1) Friction + integrate each ball ────────────────────────────────────
    for (const ball of balls) {
      if (ball.pocketed) continue;
      const speed = hypot(ball.vx, ball.vy);
      const slipx = ball.vx - ball.spx;
      const slipy = ball.vy - ball.spy;
      const slip = hypot(slipx, slipy);

      if (slip > 1e-3) {
        // Sliding: kinetic friction opposes the contact-point slip and spins the
        // ball up toward rolling (slip decays at (1+SLIDE_ROLL_FACTOR)·μg).
        const d = MU_SLIDE * G * DT;
        const ux = slipx / slip;
        const uy = slipy / slip;
        ball.vx -= ux * d;
        ball.vy -= uy * d;
        const ds = d * SLIDE_ROLL_FACTOR;
        ball.spx += ux * ds;
        ball.spy += uy * ds;
        // Snap to pure roll if this step drove the slip through zero.
        if ((ball.vx - ball.spx) * slipx + (ball.vy - ball.spy) * slipy <= 0) {
          ball.spx = ball.vx;
          ball.spy = ball.vy;
        }
      } else if (speed > 1e-6) {
        // Rolling: gentle rolling resistance slows v and sp together.
        const d = MU_ROLL * G * DT;
        const nx = ball.vx / speed;
        const ny = ball.vy / speed;
        const ns = Math.max(0, speed - d);
        ball.vx = nx * ns;
        ball.vy = ny * ns;
        ball.spx = ball.vx;
        ball.spy = ball.vy;
      }

      // Decay side spin.
      ball.wz *= Math.max(0, 1 - SIDE_DAMP * DT);

      // Rest test.
      const sp2 = hypot(ball.vx, ball.vy);
      if (sp2 < V_STOP && hypot(ball.vx - ball.spx, ball.vy - ball.spy) < V_STOP) {
        ball.vx = 0; ball.vy = 0; ball.spx = 0; ball.spy = 0;
      } else {
        anyMoving = true;
      }

      ball.x += ball.vx * DT;
      ball.y += ball.vy * DT;
    }

    // ── 2) Pockets (check before cushions so a ball in the jaw falls in) ──────
    for (const ball of balls) {
      if (ball.pocketed) continue;
      let pocket = false;
      for (const p of POCKETS) {
        const cr = p.corner ? CORNER_CAPTURE_R : SIDE_CAPTURE_R;
        if (hypot(ball.x - p.x, ball.y - p.y) < cr) { pocket = true; break; }
      }
      // Hard backstop: a ball whose centre has crossed a rail line can only have
      // slipped through a pocket mouth (cushions clamp everywhere else), so treat
      // it as pocketed. Guarantees no ball is ever stranded off-table.
      if (!pocket && (ball.x < 0 || ball.x > PLAY_W || ball.y < 0 || ball.y > PLAY_H)) {
        pocket = true;
      }
      if (pocket) {
        ball.pocketed = true;
        ball.vx = ball.vy = ball.spx = ball.spy = ball.wz = 0;
        if (ball.id === 0) events.cueScratched = true;
        else events.pocketed.push(ball.id);
      }
    }

    // ── 3) Cushions ──────────────────────────────────────────────────────────
    for (const ball of balls) {
      if (ball.pocketed) continue;
      let hitRail = false;
      // Left / right short rails (x walls) — gap at corner pockets.
      if (ball.x < BALL_R && ball.vx < 0 && !inPocketMouth(ball.y, [0, PLAY_H], CORNER_MOUTH)) {
        ball.x = BALL_R;
        ball.vx = -ball.vx * E_CUSH;
        ball.spx = -ball.spx * E_CUSH;
        // english bends the rebound along the rail + is partly spent.
        ball.vy += ball.wz * CUSH_SPIN;
        ball.wz *= 0.4;
        hitRail = true;
      } else if (ball.x > PLAY_W - BALL_R && ball.vx > 0 && !inPocketMouth(ball.y, [0, PLAY_H], CORNER_MOUTH)) {
        ball.x = PLAY_W - BALL_R;
        ball.vx = -ball.vx * E_CUSH;
        ball.spx = -ball.spx * E_CUSH;
        ball.vy -= ball.wz * CUSH_SPIN;
        ball.wz *= 0.4;
        hitRail = true;
      }
      // Top / bottom long rails (y walls) — gap at corner + side pockets.
      if (ball.y < BALL_R && ball.vy < 0 && !inPocketMouth(ball.x, [0, PLAY_W / 2, PLAY_W], ball.x < PLAY_W * 0.25 || ball.x > PLAY_W * 0.75 ? CORNER_MOUTH : SIDE_MOUTH)) {
        ball.y = BALL_R;
        ball.vy = -ball.vy * E_CUSH;
        ball.spy = -ball.spy * E_CUSH;
        ball.vx -= ball.wz * CUSH_SPIN;
        ball.wz *= 0.4;
        hitRail = true;
      } else if (ball.y > PLAY_H - BALL_R && ball.vy > 0 && !inPocketMouth(ball.x, [0, PLAY_W / 2, PLAY_W], ball.x < PLAY_W * 0.25 || ball.x > PLAY_W * 0.75 ? CORNER_MOUTH : SIDE_MOUTH)) {
        ball.y = PLAY_H - BALL_R;
        ball.vy = -ball.vy * E_CUSH;
        ball.spy = -ball.spy * E_CUSH;
        ball.vx += ball.wz * CUSH_SPIN;
        ball.wz *= 0.4;
        hitRail = true;
      }
      if (hitRail && ball.id !== 0) {
        if (!railed.has(ball.id)) { railed.add(ball.id); events.ballsToRail++; }
        if (events.firstContact !== null) events.railAfterContact = true;
      }
      if (hitRail && ball.id === 0 && events.firstContact !== null) {
        events.railAfterContact = true;
      }
    }

    // ── 4) Ball–ball collisions ──────────────────────────────────────────────
    for (let i = 0; i < balls.length; i++) {
      const a = balls[i];
      if (a.pocketed) continue;
      for (let j = i + 1; j < balls.length; j++) {
        const b = balls[j];
        if (b.pocketed) continue;
        let nx = b.x - a.x;
        let ny = b.y - a.y;
        const dist = hypot(nx, ny);
        const minD = BALL_R * 2;
        if (dist > 0 && dist < minD) {
          nx /= dist; ny /= dist;
          // Separate to remove overlap (split evenly).
          const overlap = (minD - dist) / 2;
          a.x -= nx * overlap; a.y -= ny * overlap;
          b.x += nx * overlap; b.y += ny * overlap;
          // Normal components.
          const avn = a.vx * nx + a.vy * ny;
          const bvn = b.vx * nx + b.vy * ny;
          if (avn - bvn > 0) {
            // Approaching: exchange the normal component (equal mass), damped by e.
            const impulse = ((avn - bvn) * (1 + E_BALL)) / 2;
            a.vx -= impulse * nx; a.vy -= impulse * ny;
            b.vx += impulse * nx; b.vy += impulse * ny;
            // Record contact + english throw on the struck ball.
            const involvesCue = a.id === 0 || b.id === 0;
            if (involvesCue) {
              const cueBall = a.id === 0 ? a : b;
              const obj = a.id === 0 ? b : a;
              if (events.firstContact === null) events.firstContact = obj.id;
              const tx = -ny, ty = nx; // tangent
              const throwV = cueBall.wz * THROW;
              obj.vx += tx * throwV; obj.vy += ty * throwV;
            }
          }
        }
      }
    }

    if (step % RECORD_EVERY === 0) record();
    if (!anyMoving) break;
  }

  record(); // final resting frame
  return { frames, events, balls };
}
