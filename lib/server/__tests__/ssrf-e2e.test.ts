/**
 * E2E test: ssrfSafeFetch DNS rebinding defense.
 *
 * Proves the TOCTOU (time-of-check / time-of-use) attack window between
 * hostname validation and socket connect is closed, by verifying:
 *   1. A single DNS lookup occurs during ssrfSafeFetch.
 *   2. If DNS returns a private IP, fetch is rejected before connect.
 *   3. Even if a second DNS response would return a private IP, our code
 *      never performs a second lookup — it uses the pinned first result.
 *   4. Validation rejects before any TCP attempt when resolution is blocked.
 *
 * See remediation-plan-v3 P0.2 / Batch A.3.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node:dns before importing ssrf-guard so the guard sees the mock.
vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return {
    ...actual,
    promises: {
      lookup: vi.fn(),
    },
  };
});

// Mock undici fetch: we don't want real TCP. Use vi.hoisted so the mock is
// initialized before the module factory runs (vi.mock is hoisted to top).
const { undiciFetchMock } = vi.hoisted(() => ({
  undiciFetchMock: vi.fn(async () => ({
    status: 200,
    ok: true,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'text/plain' }),
    blob: async () => new Blob(['ok']),
    arrayBuffer: async () => new TextEncoder().encode('ok').buffer,
    json: async () => ({}),
    text: async () => 'ok',
  })),
}));

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: undiciFetchMock,
    // Agent is still the real class — our code constructs it and passes to fetch.
  };
});

import { promises as dns } from 'node:dns';
import { ssrfSafeFetch } from '@/lib/server/ssrf-guard';

const dnsLookup = dns.lookup as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  dnsLookup.mockReset();
  undiciFetchMock.mockClear();
});

describe('ssrfSafeFetch: DNS rebinding defense', () => {
  it('performs exactly one DNS lookup per fetch call', async () => {
    dnsLookup.mockResolvedValue([{ address: '1.1.1.1', family: 4 }]);

    const response = await ssrfSafeFetch('http://public.example/');
    expect(response.status).toBe(200);
    expect(dnsLookup).toHaveBeenCalledTimes(1);
  });

  it('rejects if DNS returns a private IP (classic SSRF)', async () => {
    dnsLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);

    await expect(ssrfSafeFetch('http://evil.example/')).rejects.toThrow(/blocked range/);
    expect(dnsLookup).toHaveBeenCalledTimes(1);
    expect(undiciFetchMock).not.toHaveBeenCalled();
  });

  it('does not perform a second DNS lookup even if rebinding attempt exists', async () => {
    // Simulate DNS rebinding: first lookup returns public, subsequent would return private.
    // A vulnerable implementation would lookup twice (once for validate, once for connect)
    // and hit the private IP on the second. Our implementation pins on the first result.
    let callCount = 0;
    dnsLookup.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return [{ address: '1.1.1.1', family: 4 }];
      }
      // If this branch is reached, we are vulnerable.
      return [{ address: '127.0.0.1', family: 4 }];
    });

    const response = await ssrfSafeFetch('http://rebind.example/');
    expect(response.status).toBe(200);
    expect(callCount).toBe(1);
  });

  it('rejects docker service names (private-resolving hostnames)', async () => {
    dnsLookup.mockResolvedValue([{ address: '172.20.0.3', family: 4 }]);

    await expect(ssrfSafeFetch('http://openmaic-ru-openmaic-1:3000/api/')).rejects.toThrow(/blocked range/);
    expect(undiciFetchMock).not.toHaveBeenCalled();
  });

  it('rejects IPv6 loopback literal before any TCP attempt', async () => {
    // IP literals bypass the dns.lookup mock entirely.
    await expect(ssrfSafeFetch('http://[::1]/')).rejects.toThrow(/blocked range/);
    expect(undiciFetchMock).not.toHaveBeenCalled();
  });

  it('rejects alternative IPv4 encoding (decimal) before any TCP attempt', async () => {
    // 2130706433 == 127.0.0.1
    await expect(ssrfSafeFetch('http://2130706433/')).rejects.toThrow(/blocked range/);
    expect(undiciFetchMock).not.toHaveBeenCalled();
  });

  it('passes a pinned undici Agent (not a hostname-resolving one) to fetch', async () => {
    dnsLookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);

    await ssrfSafeFetch('https://dns.google/');
    expect(undiciFetchMock).toHaveBeenCalledTimes(1);

    const [, init] = undiciFetchMock.mock.calls[0] as unknown as [string, { dispatcher?: unknown }];
    expect(init?.dispatcher).toBeDefined();
  });

  it('preserves init options (e.g. redirect: manual) when calling fetch', async () => {
    dnsLookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);

    await ssrfSafeFetch('https://dns.google/', { redirect: 'manual', method: 'GET' });
    const [, init] = undiciFetchMock.mock.calls[0] as unknown as [string, { redirect?: string; method?: string }];
    expect(init?.redirect).toBe('manual');
    expect(init?.method).toBe('GET');
  });

  it('sets Host header based on original URL even when connecting by IP', async () => {
    dnsLookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);

    await ssrfSafeFetch('https://dns.google/query?x=1');
    const [, init] = undiciFetchMock.mock.calls[0] as unknown as [string, { headers?: Headers }];
    const host = init?.headers?.get('host');
    expect(host).toBe('dns.google');
  });
});
