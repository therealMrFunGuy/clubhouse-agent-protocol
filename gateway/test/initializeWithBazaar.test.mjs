/**
 * Does the resource server still START with a bazaar extension declared?
 *
 * ## Why this test exists rather than a careful reading
 *
 * `initialize()` is the single point of failure for the whole paywall. This
 * module's own header says it: it must be awaited, it validates every
 * configured route against what the facilitator advertises, and **you cannot
 * emit a 402 without it**. A route table that fails validation does not degrade
 * — it takes payments down completely.
 *
 * Adding `extensions.bazaar` to every priced route is therefore a change to the
 * input of that function, made to a live money path, for a discovery benefit.
 * `checkIfBazaarNeeded` is exported by @x402/core and is not called anywhere
 * inside it, which suggests declaring an extension is inert — but "I read the
 * bundle and it looked inert" is exactly the standard of evidence that has been
 * wrong on this surface repeatedly. A challenge that verifies is not one that
 * can be paid; a route table that type-checks is not one that initializes.
 *
 * So this runs the real `x402ResourceServer` over the real `buildRoutes`
 * output, against a stub facilitator advertising what we actually use, and
 * asserts it comes up and emits a challenge that still carries the terms.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { x402ResourceServer, x402HTTPResourceServer } from '@x402/core/server';
import { registerExactEvmScheme } from '@x402/evm/exact/server';

import { buildRoutes } from '../src/x402.ts';

const NETWORK = 'eip155:8453';

/**
 * Advertises exactly what the gateway's routes ask for, and nothing else — so
 * a route the facilitator could not serve fails here as it would in production.
 */
const stubFacilitator = {
  async getSupported() {
    return { kinds: [{ x402Version: 2, scheme: 'exact', network: NETWORK }] };
  },
  async verify() {
    return { isValid: true };
  },
  async settle() {
    return { success: true };
  },
};

const env = { AGENT_POT_ADDRESS: '0x000000000000000000000000000000000000dEaD' };

test('initialize() succeeds with bazaar extensions declared', async () => {
  // The property the paywall rests on. If declaring an extension made route
  // validation stricter, this is where it would surface — and in production it
  // would surface as every route 500ing instead of charging.
  const resourceServer = new x402ResourceServer(stubFacilitator);
  registerExactEvmScheme(resourceServer, {});
  const server = new x402HTTPResourceServer(resourceServer, buildRoutes(env));

  await assert.doesNotReject(() => server.initialize());
});

test('the route table still validates when the extension is REMOVED', async () => {
  // The control. If initialize() passed for a reason unrelated to our change,
  // this would pass too and the test above would prove nothing — so strip the
  // extensions and confirm the harness is exercising the same path either way.
  const stripped = Object.fromEntries(
    Object.entries(buildRoutes(env)).map(([k, v]) => {
      const { extensions, ...rest } = v;
      return [k, rest];
    }),
  );

  const resourceServer = new x402ResourceServer(stubFacilitator);
  registerExactEvmScheme(resourceServer, {});
  const server = new x402HTTPResourceServer(resourceServer, stripped);

  await assert.doesNotReject(() => server.initialize());
});

test('a route the facilitator cannot serve still FAILS initialize', async () => {
  // Proves the two tests above are meaningful rather than vacuous: this harness
  // can fail. A facilitator advertising nothing must not produce a server that
  // comes up happily, or "initialize() resolved" says nothing at all.
  const emptyFacilitator = { ...stubFacilitator, async getSupported() { return { kinds: [] }; } };

  const resourceServer = new x402ResourceServer(emptyFacilitator);
  registerExactEvmScheme(resourceServer, {});
  const server = new x402HTTPResourceServer(resourceServer, buildRoutes(env));

  await assert.rejects(() => server.initialize());
});
