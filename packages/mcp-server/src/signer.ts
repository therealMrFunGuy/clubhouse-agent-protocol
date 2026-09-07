/**
 * Proving who you are.
 *
 * Reads and discovery are open, but anything that ACTS as somebody — playing a
 * move, taking a shot, reading your own matches or audit chain — requires a
 * signature from the wallet that paid to enter. Without one the gateway answers
 * 401, and until this file existed the MCP server had no way to produce one:
 * it could browse the platform and could not play on it. The two headline
 * tools, `clubhouse_chess_move` and `clubhouse_pool_shot`, were unusable.
 *
 * ## The key
 *
 * Supplied by the operator through `CLUBHOUSE_AGENT_PRIVATE_KEY`, and it stays
 * on the operator's machine — this server runs locally over stdio and talks
 * outward to a public API. That is consistent with the package's security
 * stance rather than a departure from it: the claim is that we hold no
 * CLUBHOUSE credentials and need not be trusted to run this honestly. An
 * agent's own wallet key is the operator's, not ours, and never leaves them.
 *
 * The key is read once, converted to an account, and never logged. Only the
 * derived address is ever printed, so a screenshot of a terminal cannot leak
 * the wallet that holds the winnings.
 *
 * ## What is signed
 *
 *   clubhouse-agent-v1 \n timestamp \n nonce \n METHOD \n path?query \n sha256(body)
 *
 * The path includes the query string, because signing the pathname alone would
 * leave parameters unauthorised while the gateway forwards them under its own
 * HMAC — the origin would then treat values the agent never saw as authorised.
 * The format is versioned on the first line so it can change without an old
 * signature silently meaning something new.
 */

import { createHash, randomUUID } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';

export const ADDRESS_HEADER = 'x-cap-agent-address';
export const TIMESTAMP_HEADER = 'x-cap-agent-timestamp';
export const NONCE_HEADER = 'x-cap-agent-nonce';
export const SIGNATURE_HEADER = 'x-cap-agent-signature';

export interface AgentSigner {
  address: `0x${string}`;
  headersFor(method: string, path: string, body: string): Promise<Record<string, string>>;
}

/** Mirrors gateway/src/agentAuth.ts. Both sides must build the same string. */
export function challengeString(parts: {
  timestamp: string;
  nonce: string;
  method: string;
  path: string;
  bodyHash: string;
}): string {
  return [
    'clubhouse-agent-v1',
    parts.timestamp,
    parts.nonce,
    parts.method.toUpperCase(),
    parts.path,
    parts.bodyHash,
  ].join('\n');
}

function sha256Hex(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/**
 * Build a signer from the operator's key, or null when none is configured.
 *
 * Returning null rather than throwing is deliberate: an operator who only wants
 * to browse leaderboards should not have to hold a wallet, and the play tools
 * explain what to set when they are actually reached.
 *
 * A key that is present but malformed DOES throw. That is a misconfiguration
 * the operator wants to hear about at startup, not one request at a time.
 */
export function signerFromEnv(env: NodeJS.ProcessEnv = process.env): AgentSigner | null {
  const raw = (env.CLUBHOUSE_AGENT_PRIVATE_KEY ?? '').trim();
  if (!raw) return null;

  const hex = (raw.startsWith('0x') ? raw : `0x${raw}`) as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    // Deliberately says nothing about the value itself — not its prefix, not
    // its length, not a fragment. An error message is the easiest place for a
    // secret to end up in a log.
    throw new Error(
      'CLUBHOUSE_AGENT_PRIVATE_KEY is not a valid 32-byte hex private key. ' +
        'Expected 64 hex characters, optionally 0x-prefixed.',
    );
  }

  const account = privateKeyToAccount(hex);

  return {
    address: account.address,
    async headersFor(method, path, body) {
      const timestamp = String(Date.now());
      const nonce = randomUUID();
      const signature = await account.signMessage({
        message: challengeString({
          timestamp,
          nonce,
          method,
          path,
          bodyHash: sha256Hex(body),
        }),
      });
      return {
        [ADDRESS_HEADER]: account.address,
        [TIMESTAMP_HEADER]: timestamp,
        [NONCE_HEADER]: nonce,
        [SIGNATURE_HEADER]: signature,
      };
    },
  };
}
