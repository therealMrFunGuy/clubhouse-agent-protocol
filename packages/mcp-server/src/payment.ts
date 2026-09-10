/**
 * Turning a 402 into a paid seat.
 *
 * ## Why this file had to exist
 *
 * `server.json` told operators this server "signs payments and identity
 * challenges" and to "fund it with what you are willing to lose at the table".
 * Only the second half was true. It signed identity challenges; it had never
 * been able to pay for anything. An operator who funded that wallet and asked
 * their model to take a seat got a base64 blob back.
 *
 * That was not a small gap. Five independent agent wallets found this API,
 * correctly implemented EIP-191 request signing against a live money endpoint —
 * the hardest step — and then every one of them left without paying. Four of
 * them touched only `/agents/me` and `/matches/mine`, which are exactly the
 * routes behind `clubhouse_my_status` and `clubhouse_my_matches`: they were
 * running THIS server. The wall they hit was this file being absent.
 *
 * The examples pointed at `wrapFetchWithPayment` from `x402-fetch`, which is on
 * the 1.x line; our gateway hard-rejects a declared v1 payload. So the one
 * client we named in public could never have paid us.
 *
 * ## Why these two imports
 *
 * `@x402/core/client` + `@x402/evm/exact/client` is the v2 client half of the
 * library the gateway already speaks, and it is the exact pair used by
 * `scripts/live-game.mjs` — the script that ran the successful mainnet pilot.
 * This is not a new integration; it is the proven one, moved to where agents
 * can reach it.
 *
 * ## The one non-obvious call
 *
 * `handlePaymentRequired()` looks like the method you want and returns null
 * here — it is hook-driven and expects hooks this client does not register.
 * `createPaymentPayload()` + `encodePaymentSignatureHeader()` are what it wraps
 * and what actually work. live-game.mjs learned this the expensive way; the
 * comment is here so nobody learns it twice.
 */

import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http, publicActions } from 'viem';
import { base } from 'viem/chains';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { registerExactEvmScheme } from '@x402/evm/exact/client';

/** Default ceiling per payment. A ranked seat is $0.50; a tournament buy-in $5. */
const DEFAULT_MAX_PAYMENT = '$5';

export interface PaymentMaker {
  /** The wallet that will be debited. Same key the identity signer uses. */
  address: string;
  /**
   * Build the `PAYMENT-SIGNATURE` headers for a 402, or null when the
   * challenge cannot be satisfied (unsupported scheme, over the cap, an asset
   * this wallet is not allowed to spend).
   */
  headersFor(getHeader: (name: string) => string | null): Promise<Record<string, string> | null>;
}

/**
 * Build a payer from the environment, or null when no key is configured.
 *
 * Null rather than throwing: every read-only tool works without a key, and the
 * server must keep running for an operator who only wants leaderboards. Paying
 * is the opt-in.
 */
export function paymentMakerFromEnv(env: NodeJS.ProcessEnv = process.env): PaymentMaker | null {
  const raw = (env.CLUBHOUSE_AGENT_PRIVATE_KEY ?? '').trim();
  if (!raw) return null;

  const hex = (raw.startsWith('0x') ? raw : `0x${raw}`) as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    // Says nothing about the value — not its prefix, not its length, not a
    // fragment. An error message is the easiest place for a secret to end up.
    throw new Error(
      'CLUBHOUSE_AGENT_PRIVATE_KEY is not a valid 32-byte hex private key. ' +
        'Expected 64 hex characters, optionally 0x-prefixed.',
    );
  }

  const account = privateKeyToAccount(hex);
  const rpcUrl = (env.CLUBHOUSE_BASE_RPC_URL ?? '').trim() || 'https://mainnet.base.org';
  // `.extend(publicActions)` is load-bearing, not tidiness. The exact scheme
  // READS the token contract to build its EIP-712 domain, and `readContract` is
  // a PUBLIC action — a bare wallet client does not have it. Without this the
  // payment fails at signing time with a missing-domain error, which is exactly
  // the class of defect that made a challenge verify but not be payable during
  // the payment-channel work.
  const wallet = createWalletClient({ account, chain: base, transport: http(rpcUrl) }).extend(
    publicActions,
  );

  // The scheme reads `signer.address`; a viem wallet client exposes `account`,
  // so handing it over directly makes the scheme read `undefined` as the payer
  // and fail with 'Address "undefined" is invalid'. Adapt rather than assume.
  const signer = {
    address: account.address,
    signTypedData: (m: any) => wallet.signTypedData({ account, ...m }),
    readContract: (a: any) => wallet.readContract(a),
  };

  const inner = new x402Client();
  registerExactEvmScheme(inner, { signer });

  // ── The ceiling, set EXPLICITLY ───────────────────────────────────────────
  //
  // The library defaults to $1 per payment, which happens to cover a seat and
  // happens not to cover a tournament buy-in. Inheriting a default for the
  // amount of somebody else's money this process may move is the wrong shape
  // regardless of whether the number is right: an operator reading this file
  // should be able to see the cap, and change it, without reading the
  // library's source.
  //
  // This is a per-payment ceiling, not a budget. It bounds one bad or
  // misunderstood challenge; it does not bound a model that decides to enter
  // fifty tournaments. Operators who want a hard total should fund the wallet
  // with what they are willing to lose — which is what server.json says, and
  // which is now true.
  const cap = (env.CLUBHOUSE_MAX_PAYMENT_USD ?? '').trim() || DEFAULT_MAX_PAYMENT;
  inner.setSpendControls({ maxAmountPerPayment: cap as any });

  const http402 = new x402HTTPClient(inner);

  return {
    address: account.address,
    async headersFor(getHeader) {
      const required = http402.getPaymentRequiredResponse(getHeader);
      if (!required) return null;

      // See the header comment: handlePaymentRequired() returns null here.
      const payload = await inner.createPaymentPayload(required);
      const headers = http402.encodePaymentSignatureHeader(payload);
      return headers ?? null;
    },
  };
}
