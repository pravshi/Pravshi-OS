/**
 * Frontend search integration tests (Phase 8, Workstream D).
 *
 * Covers the UI↔API contract surface owned by the Search Frontend workstream:
 * URL construction for GET /api/search, error mapping (400/401/403), safe
 * navigation URL handling (XSS + person-result graceful degradation), type
 * param parsing against the 8-type allowlist, and the entity icon/label
 * registry. Pure unit/integration level — no database, no Neon.
 *
 * NOTE (ownership): Workstream F owns tests/search/ for QA/security.
 * This file is D's workstream-scoped coverage of its own frontend contract;
 * F may fold or relocate it during the QA pass.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SEARCH_ENTITY_TYPES } from '@/lib/search/types';
import { ENTITY_META } from '@/components/search/entity-meta';
import { personResultUrl, sanitizeResultUrl } from '@/components/search/sanitize';
import { parseTypeParams } from '@/components/search/search-params';
import { buildSearchUrl, SearchApiError, searchApi } from '@/components/search/search-client';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sanitizeResultUrl', () => {
  it('accepts same-origin app paths', () => {
    expect(sanitizeResultUrl('/crm/contacts/123')).toBe('/crm/contacts/123');
    expect(sanitizeResultUrl('/admin/users')).toBe('/admin/users');
    expect(sanitizeResultUrl('/search?q=x')).toBe('/search?q=x');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeResultUrl('  /work/tasks/1  ')).toBe('/work/tasks/1');
  });

  it('rejects absolute, protocol-relative, and javascript: URLs (XSS)', () => {
    expect(sanitizeResultUrl('https://evil.example/x')).toBeNull();
    expect(sanitizeResultUrl('http://evil.example/x')).toBeNull();
    expect(sanitizeResultUrl('//evil.example/x')).toBeNull();
    expect(sanitizeResultUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeResultUrl('JaVaScRiPt:alert(1)')).toBeNull();
    expect(sanitizeResultUrl('data:text/html,<h1>x</h1>')).toBeNull();
  });

  it('rejects backslash tricks browsers normalize to slashes', () => {
    expect(sanitizeResultUrl('/\\evil.example/x')).toBeNull();
    expect(sanitizeResultUrl('\\/evil.example')).toBeNull();
  });

  it('rejects empty and non-string input', () => {
    expect(sanitizeResultUrl('')).toBeNull();
    expect(sanitizeResultUrl('   ')).toBeNull();
    expect(sanitizeResultUrl(null)).toBeNull();
    expect(sanitizeResultUrl(undefined)).toBeNull();
    expect(sanitizeResultUrl(42)).toBeNull();
  });
});

describe('personResultUrl', () => {
  it('links to the users list when the viewer holds users.view', () => {
    expect(personResultUrl(true)).toBe('/admin/users');
  });

  it('renders no link when the viewer lacks users.view (graceful, no /access-denied bounce)', () => {
    expect(personResultUrl(false)).toBeNull();
  });
});

describe('ENTITY_META', () => {
  it('covers exactly the 8 approved entity types — no lead, no extras', () => {
    expect(Object.keys(ENTITY_META).sort()).toEqual([...SEARCH_ENTITY_TYPES].sort());
    expect(Object.keys(ENTITY_META)).not.toContain('lead');
  });

  it('gives every type a label, plural, and icon component', () => {
    for (const type of SEARCH_ENTITY_TYPES) {
      const meta = ENTITY_META[type];
      expect(meta.label).toBeTruthy();
      expect(meta.plural).toBeTruthy();
      // lucide-react icons are components: functions or memo/forwardRef objects.
      expect(meta.icon).toBeTruthy();
      expect(['function', 'object']).toContain(typeof meta.icon);
    }
  });
});

describe('parseTypeParams', () => {
  it('parses a single type', () => {
    expect(parseTypeParams('deal')).toEqual(['deal']);
  });

  it('parses repeated type params', () => {
    expect(parseTypeParams(['deal', 'task'])).toEqual(['deal', 'task']);
  });

  it('parses comma-separated types (API-compatible)', () => {
    expect(parseTypeParams('deal,task')).toEqual(['deal', 'task']);
  });

  it('drops unknown types and the forbidden lead type', () => {
    expect(parseTypeParams(['deal', 'lead', 'bogus', 'task'])).toEqual(['deal', 'task']);
  });

  it('dedupes and trims', () => {
    expect(parseTypeParams('deal, deal ,task')).toEqual(['deal', 'task']);
  });

  it('returns [] for undefined', () => {
    expect(parseTypeParams(undefined)).toEqual([]);
  });
});

describe('buildSearchUrl', () => {
  it('builds the contract URL with q, repeated type params, and limit', () => {
    const url = buildSearchUrl('acme', { types: ['deal', 'task'], limit: 8 });
    expect(url.startsWith('/api/search?')).toBe(true);
    const params = new URLSearchParams(url.slice('/api/search?'.length));
    expect(params.get('q')).toBe('acme');
    expect(params.getAll('type')).toEqual(['deal', 'task']);
    expect(params.get('limit')).toBe('8');
  });

  it('clamps limit to the server 1-50 range', () => {
    expect(
      new URLSearchParams(buildSearchUrl('x', { limit: 500 }).split('?')[1]).get('limit'),
    ).toBe('50');
    expect(new URLSearchParams(buildSearchUrl('x', { limit: 0 }).split('?')[1]).get('limit')).toBe(
      '1',
    );
  });

  it('omits offset unless provided', () => {
    const params = new URLSearchParams(buildSearchUrl('x').split('?')[1]);
    expect(params.get('offset')).toBeNull();
    const withOffset = new URLSearchParams(buildSearchUrl('x', { offset: 20 }).split('?')[1]);
    expect(withOffset.get('offset')).toBe('20');
  });
});

function mockFetchOnce(response: Partial<Response> & { jsonBody?: unknown }) {
  const json = async () => {
    if ('jsonBody' in response) return response.jsonBody;
    throw new Error('no json');
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, status: 500, json, ...response }) as Response),
  );
  return fetch as unknown as ReturnType<typeof vi.fn>;
}

describe('searchApi', () => {
  it('returns the parsed SearchResponse on 200', async () => {
    const body = { results: [], total: 0, limit: 20, offset: 0, query: 'acme' };
    const fetchMock = mockFetchOnce({ ok: true, status: 200, jsonBody: body });
    const data = await searchApi('acme');
    expect(data).toEqual(body);
    const calledUrl = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(calledUrl).toContain('q=acme');
  });

  it('sends the abort signal through for typeahead cancellation', async () => {
    const controller = new AbortController();
    const fetchMock = mockFetchOnce({ ok: true, status: 200, jsonBody: { results: [] } });
    await searchApi('acme', { signal: controller.signal });
    expect((fetchMock.mock.calls[0] as unknown[])[1]).toMatchObject({ signal: controller.signal });
  });

  it('rejects empty queries client-side without hitting the network', async () => {
    const fetchMock = mockFetchOnce({ ok: true, status: 200, jsonBody: {} });
    await expect(searchApi('   ')).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps 400 to INVALID_REQUEST with the server message', async () => {
    mockFetchOnce({ status: 400, jsonBody: { error: 'INVALID_REQUEST', message: 'q: too long' } });
    const error = await searchApi('x'.repeat(201)).catch((e) => e);
    expect(error).toBeInstanceOf(SearchApiError);
    expect(error.code).toBe('INVALID_REQUEST');
    expect(error.message).toContain('too long');
  });

  it('maps 401 to UNAUTHORIZED', async () => {
    mockFetchOnce({ status: 401, jsonBody: {} });
    await expect(searchApi('acme')).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
  });

  it('maps 403 to FORBIDDEN', async () => {
    mockFetchOnce({ status: 403, jsonBody: {} });
    await expect(searchApi('acme')).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });

  it('maps 500 to SERVER_ERROR', async () => {
    mockFetchOnce({ status: 500, jsonBody: {} });
    await expect(searchApi('acme')).rejects.toMatchObject({ code: 'SERVER_ERROR', status: 500 });
  });

  it('maps network failure to REQUEST_FAILED', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    await expect(searchApi('acme')).rejects.toMatchObject({ code: 'REQUEST_FAILED' });
  });

  it('rethrows AbortError untouched so callers can ignore cancellations', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('aborted', 'AbortError');
      }),
    );
    const error = await searchApi('acme').catch((e) => e);
    expect(error).toBeInstanceOf(DOMException);
    expect(error.name).toBe('AbortError');
  });
});
