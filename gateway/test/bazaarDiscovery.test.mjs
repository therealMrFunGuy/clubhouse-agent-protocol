/**
 * The Bazaar declaration: present, and good enough to actually call.
 *
 * ## Why this is worth a test
 *
 * The CDP Bazaar is where agents look for paid endpoints — 14,562 resources
 * indexed, continuously. There is no submission form; a facilitator indexes a
 * resource when a payment for it settles, reading the `extensions.bazaar`
 * declaration off the challenge. Without it we are simply not discoverable,
 * which is a silent failure: everything works, nobody arrives.
 *
 * Being LISTED is not the same as being CALLABLE, and that gap is the reason
 * for the schema assertions below rather than a bare "the key exists". A route
 * that takes a request body or a path parameter and declares neither gets
 * indexed and then produces 404s, because the agent has no way to construct a
 * valid request. The tournament route is exactly that trap: its id goes in the
 * PATH, and an agent guessing from the resource URL alone would POST to
 * /v1/tournaments/join, which does not exist.
 *
 * The shape asserted here was taken from a resource that IS indexed
 * (api.onesource.io), not from documentation — the same discipline the
 * attribution suite uses, and for the same reason: our belief about a payload
 * shape has been wrong on this surface more than once.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildRoutes } from '../src/x402.ts';

/** Minimal env: buildRoutes only needs the pot and the network defaults. */
const routes = buildRoutes({
  AGENT_POT_ADDRESS: '0x000000000000000000000000000000000000dEaD',
});

const queue = routes['POST /v1/matchmaking/queue'];
const tournament = routes['POST /v1/tournaments/*/join'];

test('every priced route declares a bazaar extension', () => {
  // If this fails we are invisible to the discovery layer agents query, and
  // nothing else in the system reports a problem.
  for (const [name, route] of Object.entries(routes)) {
    assert.ok(route.extensions?.bazaar, `${name} has no extensions.bazaar`);
  }
});

test('a priced route still declares its resource descriptor', () => {
  // Indexing needs both halves. We already had this one; asserting it stops a
  // future edit from trading one for the other.
  for (const [name, route] of Object.entries(routes)) {
    assert.ok(route.resource, `${name} has no resource url`);
    assert.ok(route.description, `${name} has no description`);
  }
});

test('the queue route tells an agent which games it may ask for', () => {
  const games = queue.extensions.bazaar.schema.properties.input.properties.bodyFields.properties.game;
  assert.deepEqual(games.enum, ['chess', 'pool8', 'pool9', 'poker']);
  // `game` is the one field the origin will reject the request without.
  assert.deepEqual(
    queue.extensions.bazaar.schema.properties.input.properties.bodyFields.required,
    ['game'],
  );
});

test('the TOURNAMENT route declares its id as a PATH parameter', () => {
  // The sharp one. The resource url is .../tournaments/join, but the real path
  // is .../tournaments/<id>/join. An agent that reads the url and not this
  // declaration builds a request that 404s every time — listed, and uncallable.
  const input = tournament.extensions.bazaar.schema.properties.input;
  assert.ok(input.properties.pathParams, 'tournament route declares no pathParams');
  assert.deepEqual(input.properties.pathParams.required, ['tournamentId']);
  assert.ok(input.required.includes('pathParams'));
});

test('each declaration carries a worked example, not just a schema', () => {
  // A schema says what is allowed; an example shows a call that works. Agents
  // use the second one, and the indexed resources we modelled this on publish
  // both.
  for (const [name, route] of Object.entries(routes)) {
    const info = route.extensions.bazaar.info;
    assert.equal(info.input.type, 'http', `${name} input is not declared http`);
    assert.equal(info.input.method, 'POST', `${name} declares the wrong method`);
    assert.ok(info.output?.example, `${name} has no output example`);
  }
});
