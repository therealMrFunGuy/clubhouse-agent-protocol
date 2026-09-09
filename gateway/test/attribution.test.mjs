/**
 * Attribution, against REAL payloads of both shapes.
 *
 * The gateway read `payload.authorization.from` to decide who paid. That field
 * exists on an EIP-3009 payment and does not exist on a permit2 one, so every
 * WETH and CRED payment was refused `502 Payment could not be attributed`
 * after the client had signed it and the facilitator had verified it. Two of
 * the three assets we advertise could never have been paid with.
 *
 * The payloads below are not invented. They were captured from
 * `@x402/evm`'s own client building real payments against the live 402 on
 * 2026-09-09 — a USDC one and a CRED one — with signatures truncated. That
 * matters: the defect was a wrong belief about payload shape, and a fixture
 * written from the same wrong belief would have agreed with the bug.
 *
 * These execute the function. The sibling test file reads source instead,
 * which is right for "which object are the terms read from" and wrong here:
 * asserting that the code MENTIONS permit2Authorization is exactly the kind of
 * check that passed while `payerOf` was broken in the origin.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attributePayment } from '../src/attribution.ts';

const PAYER = '0x225513ea851aB2fbC829Fd01E5BD435403B9bef5';

/** Captured from a real USDC payment. */
const eip3009Payload = {
  x402Version: 2,
  payload: {
    authorization: {
      from: PAYER,
      to: '0x7D9B82AD6967cA8c8fDA6586718f76391C612d99',
      value: '500000',
      validAfter: '0',
      validBefore: '1788964844',
      nonce: '0x1f3c8650cea9140747c7e91a52f3387a50453f588e2d65a8fc5b5c5a607881a7',
    },
    signature: '0x896ad1ecc781',
  },
};

/** Captured from a real CRED payment. Note: no `authorization` at all. */
const permit2Payload = {
  x402Version: 2,
  payload: {
    signature: '0xb6e0325687a4',
    permit2Authorization: {
      from: PAYER,
      permitted: {
        token: '0xFD1c03e25D061B0A810F129fb0C479f0A56942C6',
        amount: '10000000000000000000',
      },
      spender: '0x402085c248EeA27D92E8b30b2C58ed07f9E20001',
      nonce: '32371186758969299208829461415580081771512628136898461400806355873349343025674',
      deadline: '1788964844',
      witness: { to: '0x7D9B82AD6967cA8c8fDA6586718f76391C612d99', validAfter: '0' },
    },
  },
};

test('attributes an EIP-3009 payment', () => {
  const a = attributePayment(eip3009Payload);
  assert.equal(a.payer, PAYER);
  assert.equal(a.nonce, eip3009Payload.payload.authorization.nonce);
  assert.equal(a.flow, 'eip3009');
});

test('attributes a PERMIT2 payment — the case that was refused 502', () => {
  const a = attributePayment(permit2Payload);
  assert.equal(a.payer, PAYER);
  assert.equal(a.nonce, permit2Payload.payload.permit2Authorization.nonce);
  assert.equal(a.flow, 'permit2');
});

test('a permit2 payment yields a NON-NULL payer', () => {
  // Stated separately because null is the exact value that produced the 502,
  // and it is worth a test that fails on that value specifically rather than
  // only on a wrong address.
  assert.notEqual(attributePayment(permit2Payload).payer, null);
  assert.notEqual(attributePayment(permit2Payload).nonce, null);
});

test('prefers EIP-3009 when a payload somehow carries both', () => {
  // The batch-settlement deposit path can carry an erc3009 authorization
  // alongside other fields, so the order is deliberate rather than incidental.
  const both = {
    payload: {
      authorization: { from: '0xAAA', nonce: '0x01' },
      permit2Authorization: { from: '0xBBB', nonce: '0x02' },
    },
  };
  assert.equal(attributePayment(both).payer, '0xAAA');
  assert.equal(attributePayment(both).flow, 'eip3009');
});

test('returns nulls rather than throwing on anything unrecognised', () => {
  // The caller refuses and says so. A throw here turns a payment we merely
  // cannot read into a 500 from the Worker.
  for (const bad of [null, undefined, {}, { payload: null }, { payload: 'nope' }, { payload: {} }]) {
    const a = attributePayment(bad);
    assert.equal(a.payer, null);
    assert.equal(a.nonce, null);
  }
  assert.equal(attributePayment({ payload: {} }).flow, null);
});

test('refuses a non-string payer rather than passing an object along', () => {
  const a = attributePayment({ payload: { authorization: { from: { evil: true }, nonce: 1 } } });
  assert.equal(a.payer, null);
  assert.equal(a.nonce, null);
});
