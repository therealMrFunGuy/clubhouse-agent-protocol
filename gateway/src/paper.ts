/**
 * The paper environment.
 *
 * Standing the whole path up needs a way to buy a seat without moving real
 * money, so that the auth, envelope, pairing, game and audit layers can be
 * exercised end to end before anyone's USDC is involved. In paper mode a
 * wallet signature stands in for a settled payment.
 *
 * That is, unavoidably, a switch that turns the paywall off. Everything here
 * exists to make it impossible to leave on by accident:
 *
 *   1. It only engages when X402_PAPER_MODE is exactly "1".
 *   2. It refuses to engage on any network not on the testnet list — and the
 *      refusal is a hard 500 on EVERY request, not a quiet fallback to charging
 *      properly. A misconfigured gateway must be visibly broken rather than
 *      subtly free.
 *   3. Every paper response is stamped, in the body and in a header, so a paper
 *      result can never be mistaken for a real one in a log or a screenshot.
 *
 * Rule 2 is the important one. The tempting design — "if paper mode is set but
 * the network is mainnet, just charge normally" — fails silently in the safe
 * direction today and the unsafe direction the moment the condition is
 * inverted by a later edit. Refusing outright cannot degrade.
 */

import type { Env } from './types';
import { NETWORK, USDC } from './x402';
import type { PaymentReceipt } from './origin';

/** Networks where a synthetic payment is acceptable. Nothing with real value. */
const TESTNETS = new Set<string>([NETWORK.baseSepolia]);

export function paperModeRequested(env: Env): boolean {
  return env.X402_PAPER_MODE === '1';
}

/**
 * Whether paper mode is not just requested but permissible.
 * Returns the reason it is refused, or null when it is safe to engage.
 */
export function paperModeBlocker(env: Env): string | null {
  if (!paperModeRequested(env)) return null;
  const network = env.X402_NETWORK ?? NETWORK.baseMainnet;
  if (!TESTNETS.has(network)) {
    return `X402_PAPER_MODE is on but X402_NETWORK is ${network}, which is not a testnet`;
  }
  if (!env.ORIGIN_BASE_URL?.length) return 'ORIGIN_BASE_URL is not set';
  return null;
}

/**
 * A receipt for a payment that did not happen.
 *
 * The nonce is prefixed so it is obvious in the payments table, and so a paper
 * row can never collide with a real settlement's nonce.
 */
export function paperReceipt(env: Env, args: { nonce: string; resource: string }): PaymentReceipt {
  const network = env.X402_NETWORK ?? NETWORK.baseSepolia;
  return {
    nonce: `paper:${args.nonce}`,
    scheme: 'exact',
    network,
    asset: USDC[network] ?? '0x0000000000000000000000000000000000000000',
    // The CONFIGURED price, in exact base units — not zero.
    //
    // A zero-amount receipt made the paper environment stop short of the thing
    // it exists to rehearse: with no money in, there is no pot, so settlement
    // credited nothing and the entire payout path went unexercised while every
    // test stayed green. A paper environment that skips the money is a paper
    // environment that cannot catch money bugs.
    //
    // Nothing is actually transferred — this is a synthetic receipt on a
    // testnet — but the ledger now moves the same numbers it would in
    // production, so accrual, the pot split and the rake are all real.
    amount: priceBaseUnits(env.PRICE_RANKED_SEAT),
    resource: args.resource,
  };
}

/**
 * Decimal USDC string → base units, as a string. Six decimals, no floats.
 *
 * `Math.round(Number(price) * 1e6)` is the obvious version and it is how a
 * decimals bug gets shipped; this platform has already shipped one on a money
 * path. String arithmetic cannot drift.
 */
function priceBaseUnits(price: string | undefined): string {
  const [whole = '0', frac = ''] = String(price ?? '1.00').split('.');
  const padded = (frac + '000000').slice(0, 6);
  const digits = `${whole}${padded}`.replace(/^0+(?=\d)/, '');
  return /^\d+$/.test(digits) ? digits : '1000000';
}
