/**
 * Our self-hosted x402 facilitator, for the `batch-settlement` scheme only.
 *
 * Public facilitators DO offer batch-settlement on mainnet: Dexter on six EVM
 * chains, and CDP on Base among others. A receiver runs its own when it needs
 * to hold the authorizer key itself — CDP's offer comes with CDP's
 * `receiverAuthorizer`, and an unrestricted authorizer can empty every channel.
 * (Two earlier versions of this comment were wrong: first "no public
 * facilitator offers it on any mainnet", then "none will take a payment as
 * small as ours". Both generalised from an incomplete probe.)
 *
 * This is deliberately the *smallest* facilitator that does the job: one scheme,
 * one network, no custody, no discovery surface.
 *
 * ## Keys
 *
 * There are three distinct roles here, and conflating any two of them is a
 * finding:
 *
 *   1. **Authorizer** (`./signer.ts`) — signs claim authorisations. Bounded by
 *      what agents already signed vouchers for.
 *   2. **Settlement submitter** — this module. Holds gas and broadcasts the
 *      claim transactions the authorizer approved. It cannot decide *what* to
 *      claim, only submit what it is handed.
 *   3. **Receiver** — the agent pot. Receives funds and signs nothing.
 *
 * None of them may be the platform's general deployer key.
 *
 * ## Exposure
 *
 * Binds loopback by default. Only the origin process should ever reach it: a
 * facilitator exposed to the internet is an oracle for other people's channel
 * state, and a target for settlement griefing. If it must cross a host boundary,
 * put it behind mTLS — do not simply widen the bind address.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export interface FacilitatorSchemeLike {
  verify(payload: unknown, requirements: unknown, context?: unknown): Promise<unknown>;
  settle(payload: unknown, requirements: unknown, context?: unknown): Promise<unknown>;
}

export interface FacilitatorServiceOptions {
  scheme: FacilitatorSchemeLike;
  /** CAIP-2. Batch-settlement contracts exist on Base only — verify before adding. */
  network: `${string}:${string}`;
  /** Shared secret the origin presents. Compared in constant time. */
  authToken: string;
  /** Default 127.0.0.1. Widening this exposes other agents' channel state. */
  host?: string;
  port?: number;
  /** Cap on request body size. Settlement payloads are small. */
  maxBodyBytes?: number;
  onError?: (error: unknown) => void;
}

const MAX_BODY_DEFAULT = 256 * 1024;

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

class BodyTooLarge extends Error {
  constructor() {
    super('Request body too large');
  }
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new BodyTooLarge();
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createFacilitatorService(opts: FacilitatorServiceOptions) {
  const host = opts.host ?? '127.0.0.1';
  const limit = opts.maxBodyBytes ?? MAX_BODY_DEFAULT;

  if (!opts.authToken || opts.authToken.length < 32) {
    throw new Error('Facilitator authToken must be at least 32 characters');
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch((error) => {
      opts.onError?.(error);
      if (!res.headersSent) {
        // Never echo the underlying error: settlement failures can carry channel
        // state and payload detail that the caller should not learn from us.
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal error' }));
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    // `/supported` is unauthenticated on purpose: the x402 SDK probes it during
    // initialize(), it reveals only which scheme/network pairs we serve, and
    // requiring auth here breaks startup for no security gain.
    if (req.method === 'GET' && url.pathname === '/supported') {
      return json(200, {
        kinds: [{ x402Version: 2, scheme: 'batch-settlement', network: opts.network }],
      });
    }

    const presented = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!constantTimeEquals(presented, opts.authToken)) {
      return json(401, { error: 'Unauthorized' });
    }

    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

    let body: { paymentPayload?: unknown; paymentRequirements?: unknown };
    try {
      body = (await readJson(req, limit)) as typeof body;
    } catch (e) {
      if (e instanceof BodyTooLarge) {
        // We stopped reading part-way through an upload, so bytes the client is
        // still sending remain unconsumed on the socket. Reusing that connection
        // feeds those leftovers to the NEXT request as if they were its head —
        // which shows up as an unrelated request being reset. Close the
        // connection rather than let a large body poison keep-alive.
        res.writeHead(400, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ error: 'Body too large' }));
        req.destroy();
        return;
      }
      return json(400, { error: 'Invalid JSON' });
    }

    if (!body?.paymentPayload || !body?.paymentRequirements) {
      return json(400, { error: 'paymentPayload and paymentRequirements are required' });
    }

    if (url.pathname === '/verify') {
      return json(200, await opts.scheme.verify(body.paymentPayload, body.paymentRequirements));
    }

    if (url.pathname === '/settle') {
      return json(200, await opts.scheme.settle(body.paymentPayload, body.paymentRequirements));
    }

    return json(404, { error: 'Not found' });
  }

  return {
    server,
    listen: (port = opts.port ?? 8402) =>
      new Promise<void>((resolve) => server.listen(port, host, resolve)),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
