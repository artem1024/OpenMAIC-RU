/**
 * Smoke tests for the SSRF + concurrency wrapper around web-search providers.
 *
 * These mock `validateUrlForSSRF` and `proxyFetch`, so no real DNS resolution
 * or network call happens; we just verify our adapter contract.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const validateUrlForSSRFMock = vi.hoisted(() => vi.fn());
const proxyFetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/ssrf-guard', () => ({
  validateUrlForSSRF: validateUrlForSSRFMock,
}));

vi.mock('@/lib/server/proxy-fetch', () => ({
  proxyFetch: proxyFetchMock,
}));

import { safeWebSearchFetch, __resetWebSearchLimitersForTests } from '@/lib/web-search/safe-fetch';

describe('safeWebSearchFetch', () => {
  beforeEach(() => {
    validateUrlForSSRFMock.mockReset();
    proxyFetchMock.mockReset();
    __resetWebSearchLimitersForTests();
    delete process.env.WEB_SEARCH_TAVILY_CONCURRENCY;
  });

  afterEach(() => {
    delete process.env.WEB_SEARCH_TAVILY_CONCURRENCY;
  });

  it('rejects URLs that fail SSRF validation', async () => {
    validateUrlForSSRFMock.mockRejectedValueOnce(new Error('Blocked: 127.0.0.1'));

    await expect(
      safeWebSearchFetch('tavily', 'https://api.tavily.com/search', { method: 'POST' }),
    ).rejects.toThrow('Blocked: 127.0.0.1');
    expect(proxyFetchMock).not.toHaveBeenCalled();
  });

  it('rejects URLs the validator returns null for', async () => {
    validateUrlForSSRFMock.mockResolvedValueOnce(null);

    await expect(
      safeWebSearchFetch('brave', 'https://search.brave.com/search?q=x'),
    ).rejects.toThrow(/SSRF guard rejected/);
    expect(proxyFetchMock).not.toHaveBeenCalled();
  });

  it('forwards to proxyFetch when SSRF passes', async () => {
    validateUrlForSSRFMock.mockResolvedValueOnce('1.2.3.4');
    proxyFetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const res = await safeWebSearchFetch('tavily', 'https://api.tavily.com/search', {
      method: 'POST',
    });

    expect(res.status).toBe(200);
    expect(proxyFetchMock).toHaveBeenCalledWith(
      'https://api.tavily.com/search',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('serialises bursts beyond the concurrency cap (per provider)', async () => {
    process.env.WEB_SEARCH_TAVILY_CONCURRENCY = '1';
    __resetWebSearchLimitersForTests();
    validateUrlForSSRFMock.mockResolvedValue('1.2.3.4');

    let inFlight = 0;
    let peak = 0;
    proxyFetchMock.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Yield to event loop so other callers race the limiter.
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return new Response('ok', { status: 200 });
    });

    await Promise.all([
      safeWebSearchFetch('tavily', 'https://api.tavily.com/search'),
      safeWebSearchFetch('tavily', 'https://api.tavily.com/search'),
      safeWebSearchFetch('tavily', 'https://api.tavily.com/search'),
    ]);

    expect(peak).toBe(1);
    expect(proxyFetchMock).toHaveBeenCalledTimes(3);
  });
});
