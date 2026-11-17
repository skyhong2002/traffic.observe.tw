import { expect, it } from 'vitest';
import {
  type ContributorData,
  createContributorPayload,
  selectCanonicalContributor,
  signContributorToken,
  validateContributorPayload,
  verifyContributorToken,
} from '../src/contributor.ts';

const now = new Date('2026-11-17T03:00:00Z');
const contribution = (payload: ContributorData = { visits: 12300000, countries: [{ code: 'TW', share: 0.8 }] }, sourceNode = 'node-a') =>
  createContributorPayload({
    domain: 'example.com',
    targetMonth: '202610',
    fetchedAt: '2026-11-17T00:00:00.000Z',
    sourceNode,
    sourceVersion: '0.1.0',
    responseStatus: 200,
    payload,
  });
it('validates real months, field lists, canonical hashes and strict normalized data', () => {
  const good = contribution();
  const validate = (raw: unknown) => validateContributorPayload(raw, 'node-a', now);
  expect(validate(good)).toMatchObject({ ok: true, payload: { domain: 'example.com', schemaVersion: 1 } });
  expect(validate({ ...good, targetMonth: '202613' })).toMatchObject({ ok: false });
  expect(validate({ ...good, fetchedAt: '2026-11-19T00:00:00Z' })).toMatchObject({ ok: false });
  expect(validate({ ...good, payload: { visits: 99 } })).toMatchObject({ ok: false });
  expect(validate(contribution({ visits: 123, cookie: 'never' } as ContributorData))).toMatchObject({
    ok: false,
    error: 'unknown_data_field',
  });
  expect(validate({ ...good, fields: ['visits', 'visits'] })).toMatchObject({ ok: false, error: 'invalid_fields' });
  expect(validate(contribution({ visits: -1 }))).toMatchObject({ ok: false });
  expect(validate(contribution({ visits: 1, channels: { Direct: 1.5 } }))).toMatchObject({ ok: false });
  expect(validate(contribution({ visits: 1, channels: { Direct: 0.8, GenAi: 0.4 } }))).toMatchObject({ ok: false });
  expect(
    validate(
      contribution({
        visits: 1,
        countries: [
          { code: 'TW', share: 0.6 },
          { code: 'TW', share: 0.3 },
        ],
      }),
    ),
  ).toMatchObject({ ok: false });
  expect(validate(contribution({ channels: { GenAi: 0 } }))).toMatchObject({ ok: false, error: 'success_requires_visits' });
});
it('hashes all nested data and is independent of JSON property order', () => {
  const a = contribution({ visits: 123, channels: { Direct: 0.2, GenAi: 0 } });
  const b = contribution({ channels: { GenAi: 0, Direct: 0.2 }, visits: 123 });
  expect(a.payloadHash).toBe(b.payloadHash);
  expect(a.payloadHash).not.toBe(contribution({ visits: 123, channels: { Direct: 0.3, GenAi: 0 } }).payloadHash);
});
it('binds tokens to a node, rejects expiration, future timestamps and short secrets', () => {
  const secret = 'test-secret-'.repeat(4);
  const token = signContributorToken('node-a', 1700000000, secret);
  expect(verifyContributorToken(token, secret, 1700000100)).toBe('node-a');
  expect(verifyContributorToken(token, secret, 1700001000)).toBeNull();
  expect(verifyContributorToken(token, secret, 1699999900)).toBeNull();
  expect(verifyContributorToken(token, 'wrong-secret-'.repeat(4), 1700000100)).toBeNull();
  expect(signContributorToken('node-a', 1700000000, 'short')).toBeNull();
});
it('requires explicit trust and chooses by trust, completeness, freshness with stable ties', () => {
  const a = contribution({ visits: 1 }, 'a');
  const b = contribution({ visits: 2, channels: { GenAi: 0 } }, 'b');
  expect(selectCanonicalContributor([a, b], {})).toBeNull();
  expect(selectCanonicalContributor([a, b], { a: 2, b: 1 })?.sourceNode).toBe('a');
  expect(selectCanonicalContributor([a, b], { a: 1, b: 1 })?.sourceNode).toBe('b');
  expect(selectCanonicalContributor([{ ...a, responseStatus: 429 }, b], { a: 3, b: 1 })?.sourceNode).toBe('b');
});
