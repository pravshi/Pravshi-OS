import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { classifyError } from '@/lib/jobs/retry';

describe('classifyError', () => {
  describe('retryable errors', () => {
    it('ETIMEDOUT is retryable', () => {
      const err = Object.assign(new Error('connect ETIMEDOUT'), {
        code: 'ETIMEDOUT',
      });
      const result = classifyError(err);
      expect(result.retryable).toBe(true);
      expect(result.code).toBe('ETIMEDOUT');
      expect(result.message).toContain('ETIMEDOUT');
    });

    it('ECONNRESET is retryable', () => {
      const err = Object.assign(new Error('read ECONNRESET'), {
        code: 'ECONNRESET',
      });
      const result = classifyError(err);
      expect(result.retryable).toBe(true);
      expect(result.code).toBe('ECONNRESET');
    });

    it('ENOTFOUND is retryable', () => {
      const err = Object.assign(new Error('getaddrinfo ENOTFOUND api.x.com'), {
        code: 'ENOTFOUND',
      });
      expect(classifyError(err).retryable).toBe(true);
    });

    it('EAI_AGAIN is retryable', () => {
      const err = Object.assign(new Error('getaddrinfo EAI_AGAIN'), {
        code: 'EAI_AGAIN',
      });
      expect(classifyError(err).retryable).toBe(true);
    });

    it('postgres deadlock 40P01 is retryable', () => {
      const err = Object.assign(new Error('deadlock detected'), {
        code: '40P01',
      });
      const result = classifyError(err);
      expect(result.retryable).toBe(true);
      expect(result.code).toBe('40P01');
    });

    it('HTTP 500 is retryable', () => {
      const result = classifyError({ status: 500, message: 'server blew up' });
      expect(result.retryable).toBe(true);
      expect(result.code).toBe('HTTP_500');
    });

    it('HTTP 503 via response.status shape is retryable', () => {
      const result = classifyError({
        response: { status: 503 },
        message: 'service unavailable',
      });
      expect(result.retryable).toBe(true);
      expect(result.code).toBe('HTTP_503');
    });

    it('provider timeout message is retryable', () => {
      const result = classifyError(new Error('provider request timed out'));
      expect(result.retryable).toBe(true);
      expect(result.code).toBe('TIMEOUT');
    });

    it('Neon connection error is retryable', () => {
      const err = Object.assign(new Error('Connection terminated unexpectedly'), {
        name: 'NeonDbError',
      });
      const result = classifyError(err);
      expect(result.retryable).toBe(true);
      expect(result.code).toBe('NEON_CONNECTION_ERROR');
    });

    it('fetch failed (Neon driver) is retryable', () => {
      const result = classifyError(new Error('fetch failed'));
      expect(result.retryable).toBe(true);
      expect(result.code).toBe('CONNECTION_ERROR');
    });

    it('unknown errors fail open as retryable UNKNOWN', () => {
      const result = classifyError(new Error('something utterly bizarre'));
      expect(result.retryable).toBe(true);
      expect(result.code).toBe('UNKNOWN');
    });

    it('thrown strings fail open as retryable UNKNOWN', () => {
      const result = classifyError('weird string throw');
      expect(result.retryable).toBe(true);
      expect(result.code).toBe('UNKNOWN');
      expect(result.message).toBe('weird string throw');
    });

    it('null/undefined fail open as retryable UNKNOWN', () => {
      expect(classifyError(null).code).toBe('UNKNOWN');
      expect(classifyError(undefined).retryable).toBe(true);
    });
  });

  describe('non-retryable errors', () => {
    it('real ZodError is non-retryable', () => {
      const zodErr = new ZodError([
        {
          code: 'invalid_type',
          expected: 'string',
          path: ['name'],
          message: 'Invalid input',
        } as never,
      ]);
      const result = classifyError(zodErr);
      expect(result.retryable).toBe(false);
      expect(result.code).toBe('ZOD_ERROR');
    });

    it('validation error code is non-retryable', () => {
      const result = classifyError(
        Object.assign(new Error('bad payload'), { code: 'VALIDATION_ERROR' }),
      );
      expect(result.retryable).toBe(false);
      expect(result.code).toBe('VALIDATION_ERROR');
    });

    it('HTTP 400 is non-retryable', () => {
      const result = classifyError({ statusCode: 400, message: 'bad request' });
      expect(result.retryable).toBe(false);
      expect(result.code).toBe('HTTP_400');
    });

    it('HTTP 401 is non-retryable auth error', () => {
      const result = classifyError({ status: 401, message: 'unauthorized' });
      expect(result.retryable).toBe(false);
      expect(result.code).toBe('UNAUTHORIZED');
    });

    it('HTTP 403 is non-retryable forbidden error', () => {
      const result = classifyError({ status: 403, message: 'forbidden' });
      expect(result.retryable).toBe(false);
      expect(result.code).toBe('FORBIDDEN');
    });

    it('HTTP 404 is non-retryable not-found', () => {
      const result = classifyError({ status: 404, message: 'missing record' });
      expect(result.retryable).toBe(false);
      expect(result.code).toBe('NOT_FOUND');
    });

    it('bad config code is non-retryable', () => {
      const result = classifyError(
        Object.assign(new Error('missing API key'), { code: 'CONFIG_ERROR' }),
      );
      expect(result.retryable).toBe(false);
      expect(result.code).toBe('CONFIG_ERROR');
    });

    it('record-not-found code is non-retryable', () => {
      const result = classifyError(
        Object.assign(new Error('row gone'), { code: 'RECORD_NOT_FOUND' }),
      );
      expect(result.retryable).toBe(false);
    });
  });

  describe('precedence', () => {
    it('a 5xx with a timeout message is still retryable', () => {
      const result = classifyError({ status: 502, message: 'gateway timed out' });
      expect(result.retryable).toBe(true);
      expect(result.code).toBe('HTTP_502');
    });

    it('ZodError wins over a retryable-looking code', () => {
      const zodErr = new ZodError([]);
      (zodErr as unknown as { code: string }).code = 'ETIMEDOUT';
      const result = classifyError(zodErr);
      expect(result.retryable).toBe(false);
    });
  });
});
