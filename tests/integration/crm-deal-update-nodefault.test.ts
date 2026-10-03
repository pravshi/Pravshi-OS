import { describe, expect, it } from 'vitest';
import { CreateDealSchema, UpdateDealSchema } from '@/lib/crm/schema';

/**
 * Zod v4 default-leak regression (P0 follow-up to the P1-1 company fix).
 *
 * CreateDealSchema gives `currency` a `.default('INR')` and `stage` a
 * `.default('NEW')`. In zod v4, `.partial()` makes those keys optional but the
 * defaults still fire for omitted keys — so an update like
 * `UpdateDealSchema.parse({ title: 'x' })` used to come back as
 * `{ title: 'x', currency: 'INR', stage: 'NEW' }`, and the service's UPDATE
 * would clobber the deal's stored currency/stage on every unrelated edit.
 *
 * The update schema therefore re-declares currency/stage as plain `.optional()`
 * (no defaults), mirroring the UpdateCompanySchema treatment from P1-1.
 * Pure unit test: schema.ts imports only zod, so no DB or env is needed.
 */
describe('UpdateDealSchema does not inject create-time defaults', () => {
  it('an update omitting currency and stage leaves both keys absent', () => {
    const parsed = UpdateDealSchema.parse({ title: 'Renamed deal' });
    expect(parsed).toEqual({ title: 'Renamed deal' });
    expect('currency' in parsed).toBe(false);
    expect('stage' in parsed).toBe(false);
  });

  it('create-time defaults still apply on CreateDealSchema', () => {
    const parsed = CreateDealSchema.parse({ title: 'Brand-new deal' });
    expect(parsed.currency).toBe('INR');
    expect(parsed.stage).toBe('NEW');
  });

  it('an explicit currency is normalized but does not pull in a stage', () => {
    const parsed = UpdateDealSchema.parse({ currency: 'usd' });
    expect(parsed.currency).toBe('USD');
    expect('stage' in parsed).toBe(false);
  });

  it('an explicit stage is accepted but does not pull in a currency', () => {
    const parsed = UpdateDealSchema.parse({ stage: 'WON' });
    expect(parsed.stage).toBe('WON');
    expect('currency' in parsed).toBe(false);
  });

  it('an empty update is still rejected (non-empty refine intact)', () => {
    expect(() => UpdateDealSchema.parse({})).toThrow();
  });

  it('null currency is rejected at the boundary, not passed to the DB', () => {
    expect(() => UpdateDealSchema.parse({ currency: null })).toThrow();
  });
});
