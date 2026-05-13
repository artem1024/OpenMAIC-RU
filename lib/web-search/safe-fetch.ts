/**
 * SSRF-guarded, rate-limited fetch wrapper for web-search providers.
 *
 * RU fork invariant (Phase 3 / upstream #12 web-search):
 *   - every outbound web-search request MUST be validated against our
 *     async `validateUrlForSSRF` before the connection is opened. Upstream
 *     providers call `proxyFetch` directly which lacks DNS/IPv6/CGNAT/Teredo
 *     hardening; that hardening lives in `lib/server/ssrf-guard.ts`.
 *   - per-provider concurrency is throttled via a tiny in-memory token-bucket
 *     queue. Public web-search APIs (Brave HTML scrape, Baidu, Bocha) are
 *     rate-limited upstream and the official Tavily plan is bursty, so we
 *     cap concurrent in-flight requests *per provider id* and serialise the
 *     rest. Default concurrency = 4, override via `WEB_SEARCH_<ID>_CONCURRENCY`.
 *   - the wrapper preserves the existing `proxyFetch` HTTP/HTTPS proxy
 *     behaviour by delegating to it after the URL passes SSRF validation.
 *
 * Usage in providers:
 *     import { safeWebSearchFetch } from './safe-fetch';
 *     const res = await safeWebSearchFetch('brave', url, { method: 'GET' });
 */

import { proxyFetch } from '@/lib/server/proxy-fetch';
import { validateUrlForSSRF } from '@/lib/server/ssrf-guard';
import { createLogger } from '@/lib/logger';
import type { WebSearchProviderId } from './types';

const log = createLogger('WebSearchFetch');

// ---------------------------------------------------------------------------
// Per-provider concurrency limiter (no external p-limit dep — minimal queue).
// ---------------------------------------------------------------------------

interface Limiter {
  active: number;
  max: number;
  queue: Array<() => void>;
}

const limiters = new Map<string, Limiter>();

function envConcurrencyOverride(providerId: WebSearchProviderId): number | undefined {
  const raw = process.env[`WEB_SEARCH_${providerId.toUpperCase()}_CONCURRENCY`];
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 64) return undefined;
  return n;
}

function getLimiter(providerId: WebSearchProviderId): Limiter {
  let lim = limiters.get(providerId);
  if (!lim) {
    lim = { active: 0, max: envConcurrencyOverride(providerId) ?? 4, queue: [] };
    limiters.set(providerId, lim);
  }
  return lim;
}

async function acquire(providerId: WebSearchProviderId): Promise<() => void> {
  const lim = getLimiter(providerId);
  if (lim.active < lim.max) {
    lim.active += 1;
    return () => release(lim);
  }
  await new Promise<void>((resolve) => lim.queue.push(resolve));
  lim.active += 1;
  return () => release(lim);
}

function release(lim: Limiter): void {
  lim.active -= 1;
  const next = lim.queue.shift();
  if (next) next();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function safeWebSearchFetch(
  providerId: WebSearchProviderId,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  // 1) SSRF guard — async DNS resolution + IPv4/IPv6/CGNAT/Teredo blocks.
  //    We re-resolve every call (DNS rebinding defence). The validator either
  //    returns a safe IP literal to pin to, or throws on a violation.
  let safeIp: string | null = null;
  try {
    safeIp = await validateUrlForSSRF(url);
  } catch (err) {
    log.warn(`[${providerId}] SSRF validation rejected URL ${url.slice(0, 120)}`, err);
    throw err;
  }
  if (!safeIp) {
    throw new Error(`Web search SSRF guard rejected URL: ${url.slice(0, 120)}`);
  }

  // 2) Per-provider concurrency throttle.
  const release = await acquire(providerId);
  try {
    return await proxyFetch(url, init);
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------
// Test helpers (not part of the public surface)
// ---------------------------------------------------------------------------

export function __resetWebSearchLimitersForTests(): void {
  limiters.clear();
}
