import { describe, expect, it } from 'vitest';

describe('test harness', () => {
  it('runs and can fail', () => {
    expect(1 + 1).toBe(2);
  });
});
