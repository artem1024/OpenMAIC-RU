/**
 * SSRF (Server-Side Request Forgery) protection utilities.
 *
 * Validates URLs to prevent requests to internal/private network addresses.
 * Used by any API route that fetches a user-supplied URL server-side.
 *
 * Strategy (see remediation-plan-v3 P0.2):
 *   1. Parse URL and enforce HTTP(S) scheme.
 *   2. Reject decoded alternative IP forms (decimal, octal, hex, IPv4-mapped IPv6).
 *   3. DNS-resolve every A/AAAA record for the hostname.
 *   4. Reject if any resolved IP lies in private / loopback / link-local / ULA space.
 *      This automatically blocks docker service names (they resolve to private IPs).
 *   5. Provide `ssrfSafeFetch` that pins the connection to a validated IP while
 *      preserving the original Host header and TLS SNI.
 */

// DEPRECATED: replaced by async DNS-resolving validator below, see remediation-plan-v3 P0.2.
// Old synchronous string-blacklist implementation intentionally removed — it failed against
// decimal/octal/hex IP encodings, docker service names, and IPv4-mapped IPv6.

import { promises as dns } from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import { Agent, fetch as undiciFetch } from 'undici';
import type { RequestInit as UndiciRequestInit, Response as UndiciResponse } from 'undici';

/** IPv4 CIDR check. */
function ipv4InCidr(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr, 10);
  const ipNum = ipv4ToInt(ip);
  const rangeNum = ipv4ToInt(range);
  if (ipNum === null || rangeNum === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipNum & mask) === (rangeNum & mask);
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const v = parseInt(p, 10);
    if (v < 0 || v > 255) return null;
    n = (n << 8) + v;
  }
  return n >>> 0;
}

const PRIVATE_V4_CIDRS = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '0.0.0.0/8',
  '100.64.0.0/10', // CGNAT
  '198.18.0.0/15', // benchmark
  '192.0.0.0/24',
  '192.0.2.0/24',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved / 255.255.255.255
];

/** Returns true when `ip` is a literal that must never be reachable from the outside. */
export function isBlockedIPv4(ip: string): boolean {
  if (!net.isIPv4(ip)) return false;
  return PRIVATE_V4_CIDRS.some((cidr) => ipv4InCidr(ip, cidr));
}

/** Returns true when `ip` is a blocked IPv6 literal (loopback, link-local, ULA, IPv4-mapped to private). */
export function isBlockedIPv6(ip: string): boolean {
  if (!net.isIPv6(ip)) return false;
  const lower = ip.toLowerCase();
  // Loopback ::1
  if (lower === '::1' || lower === '::0001' || lower === '0:0:0:0:0:0:0:1') return true;
  // Unspecified ::
  if (lower === '::' || lower === '0:0:0:0:0:0:0:0') return true;
  // Link-local fe80::/10
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;
  // ULA fc00::/7 (fc00-fdff)
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  // Multicast ff00::/8
  if (lower.startsWith('ff')) return true;
  // IPv4-mapped IPv6: ::ffff:a.b.c.d or ::ffff:HHHH:HHHH
  const mapped = extractMappedIPv4(lower);
  if (mapped && isBlockedIPv4(mapped)) return true;
  // IPv4-compat (deprecated) ::a.b.c.d
  if (/^::\d+\.\d+\.\d+\.\d+$/.test(lower)) {
    const v4 = lower.slice(2);
    if (isBlockedIPv4(v4)) return true;
  }
  return false;
}

function extractMappedIPv4(ipv6Lower: string): string | null {
  // Forms: ::ffff:192.168.1.1 or ::ffff:c0a8:0101
  const m1 = ipv6Lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m1) return m1[1];
  const m2 = ipv6Lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (m2) {
    const hi = parseInt(m2[1], 16);
    const lo = parseInt(m2[2], 16);
    if (Number.isFinite(hi) && Number.isFinite(lo)) {
      return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
  }
  return null;
}

/**
 * Detect and normalize alternative IP representations that should be rejected outright
 * because they are attempts to bypass hostname-based filtering:
 *   - decimal:   http://2130706433/      -> 127.0.0.1
 *   - octal:     http://0177.0.0.1/       -> 127.0.0.1
 *   - hex:       http://0x7f000001/      -> 127.0.0.1
 *   - short:     http://127.1/            -> 127.0.0.1
 *
 * Returns the effective IPv4 string if the hostname is one of these forms, else null.
 */
export function decodeAlternativeIPv4(host: string): string | null {
  const raw = host.trim();
  if (raw.length === 0) return null;

  // Pure decimal integer (32-bit).
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 0xffffffff) {
      return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
    }
  }

  // Hex: 0x7f000001 or 0x7F.0x0.0x0.0x1
  if (/^0x[0-9a-f]+$/i.test(raw)) {
    const n = parseInt(raw, 16);
    if (Number.isFinite(n) && n >= 0 && n <= 0xffffffff) {
      return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join('.');
    }
  }

  // Dotted form — allow octal/hex octets or short forms like 127.1.
  if (/^[0-9a-fx.]+$/i.test(raw) && raw.includes('.')) {
    const parts = raw.split('.');
    if (parts.length >= 1 && parts.length <= 4) {
      const nums: number[] = [];
      for (const p of parts) {
        if (p.length === 0) return null;
        let n: number;
        if (/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p, 16);
        else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
        else if (/^\d+$/.test(p)) n = parseInt(p, 10);
        else return null;
        if (!Number.isFinite(n) || n < 0) return null;
        nums.push(n);
      }
      // Short forms: 127.1 means 127.0.0.1; a.b means a.0.0.b (standard inet_aton).
      let result: number;
      if (nums.length === 1) {
        result = nums[0];
      } else if (nums.length === 2) {
        if (nums[0] > 0xff || nums[1] > 0xffffff) return null;
        result = (nums[0] << 24) | nums[1];
      } else if (nums.length === 3) {
        if (nums[0] > 0xff || nums[1] > 0xff || nums[2] > 0xffff) return null;
        result = (nums[0] << 24) | (nums[1] << 16) | nums[2];
      } else {
        if (nums.some((v) => v > 0xff)) return null;
        result = (nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3];
      }
      result = result >>> 0;
      return [(result >>> 24) & 0xff, (result >>> 16) & 0xff, (result >>> 8) & 0xff, result & 0xff].join('.');
    }
  }

  return null;
}

function stripV6Brackets(host: string): string {
  if (host.startsWith('[') && host.endsWith(']')) return host.slice(1, -1);
  return host;
}

/**
 * Result of a successful DNS resolution that has been fully validated.
 */
export interface ResolvedHost {
  hostname: string;
  ip: string;
  family: 4 | 6;
}

/**
 * Resolve hostname to ALL A/AAAA records and return the first-validated-safe one.
 * Rejects if any resolved address is in a blocked range.
 */
export async function resolveAndValidateHost(hostname: string): Promise<
  { ok: true; resolved: ResolvedHost[] } | { ok: false; reason: string }
> {
  const cleaned = stripV6Brackets(hostname).toLowerCase();

  // Obviously banned literal names.
  if (cleaned === 'localhost' || cleaned === 'ip6-localhost' || cleaned === 'ip6-loopback') {
    return { ok: false, reason: 'Local/private hostname is not allowed' };
  }
  if (cleaned.endsWith('.localhost') || cleaned.endsWith('.local') || cleaned.endsWith('.internal') || cleaned.endsWith('.lan')) {
    return { ok: false, reason: 'Local/private hostname is not allowed' };
  }

  // If hostname is already an IP literal (including alt forms), validate directly.
  if (net.isIP(cleaned)) {
    const family = net.isIPv4(cleaned) ? 4 : 6;
    if (family === 4 && isBlockedIPv4(cleaned)) {
      return { ok: false, reason: 'Resolved IP is in a blocked range' };
    }
    if (family === 6 && isBlockedIPv6(cleaned)) {
      return { ok: false, reason: 'Resolved IP is in a blocked range' };
    }
    return { ok: true, resolved: [{ hostname: cleaned, ip: cleaned, family }] };
  }

  const alt = decodeAlternativeIPv4(cleaned);
  if (alt) {
    if (isBlockedIPv4(alt)) {
      return { ok: false, reason: 'Alternative IP form resolves to a blocked range' };
    }
    return { ok: true, resolved: [{ hostname: cleaned, ip: alt, family: 4 }] };
  }

  // Real DNS lookup — return ALL addresses so we catch dual-stack rebinding.
  let addrs: { address: string; family: number }[];
  try {
    addrs = await dns.lookup(cleaned, { all: true, verbatim: true });
  } catch (e) {
    return { ok: false, reason: `DNS resolution failed: ${(e as Error).message}` };
  }

  if (addrs.length === 0) {
    return { ok: false, reason: 'DNS returned no addresses' };
  }

  const resolved: ResolvedHost[] = [];
  for (const a of addrs) {
    if (a.family === 4) {
      if (isBlockedIPv4(a.address)) {
        return { ok: false, reason: `Resolved IP ${a.address} is in a blocked range` };
      }
      resolved.push({ hostname: cleaned, ip: a.address, family: 4 });
    } else if (a.family === 6) {
      if (isBlockedIPv6(a.address)) {
        return { ok: false, reason: `Resolved IP ${a.address} is in a blocked range` };
      }
      resolved.push({ hostname: cleaned, ip: a.address, family: 6 });
    }
  }

  if (resolved.length === 0) {
    return { ok: false, reason: 'No usable IP addresses resolved' };
  }

  return { ok: true, resolved };
}

/**
 * Validate a URL against SSRF attacks.
 *
 * Returns null if the URL is safe, or an error message string if blocked.
 *
 * Backward-compatible signature with the original sync validator, but now async because
 * it performs a DNS lookup. All 8+ callsites were updated to `await validateUrlForSSRF(...)`.
 */
export async function validateUrlForSSRF(url: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Invalid URL';
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'Only HTTP(S) URLs are allowed';
  }

  const hostname = parsed.hostname;
  if (!hostname) return 'URL has no hostname';

  const result = await resolveAndValidateHost(hostname);
  if (!result.ok) return result.reason;

  return null;
}

/**
 * Perform a `fetch` that is pinned to a validated IP.
 *
 * - Resolves hostname once, validates every returned address.
 * - Connects by IP, preserving the original Host header and TLS SNI so that vhosts
 *   and HTTPS certificates continue to work correctly.
 * - Protects against DNS rebinding between validation and connect.
 */
export async function ssrfSafeFetch(
  url: string,
  init: UndiciRequestInit = {},
): Promise<UndiciResponse> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Only HTTP(S) URLs are allowed');
  }
  const hostname = parsed.hostname;
  const servername = stripV6Brackets(hostname);
  const resolution = await resolveAndValidateHost(hostname);
  if (!resolution.ok) throw new Error(resolution.reason);

  // Pick first (prefer IPv4 for deterministic behavior).
  const v4 = resolution.resolved.find((r) => r.family === 4);
  const pinned = v4 ?? resolution.resolved[0];

  const agent = new Agent({
    connect: (opts, cb) => {
      const pinnedOpts = {
        ...opts,
        host: pinned.ip,
        servername,
      };
      if (parsed.protocol === 'https:') {
        const socket = tls.connect({
          ...pinnedOpts,
          host: pinned.ip,
          port: typeof opts.port === 'string' ? parseInt(opts.port, 10) : (opts.port as number),
          servername,
        });
        socket.once('secureConnect', () => {
          // Double-check the peer IP didn't somehow swap out from under us.
          const addr = socket.remoteAddress;
          if (addr && addr !== pinned.ip && !(pinned.family === 6 && addr === `::ffff:${pinned.ip}`)) {
            socket.destroy(new Error(`Peer IP mismatch: expected ${pinned.ip}, got ${addr}`));
            return;
          }
          cb(null, socket);
        });
        socket.once('error', (err) => cb(err as Error, null));
        return socket as unknown as ReturnType<typeof net.connect>;
      }
      const socket = net.connect({
        host: pinned.ip,
        port: typeof opts.port === 'string' ? parseInt(opts.port, 10) : (opts.port as number),
      });
      socket.once('connect', () => cb(null, socket));
      socket.once('error', (err) => cb(err as Error, null));
      return socket;
    },
  });

  const headers = new Headers(init.headers as HeadersInit | undefined);
  if (!headers.has('host')) {
    headers.set('host', parsed.host);
  }

  return undiciFetch(url, {
    ...init,
    headers,
    dispatcher: agent,
  });
}

/**
 * Synchronous best-effort SSRF pre-check used in code paths that cannot be easily
 * refactored to async (e.g. inside non-async helpers called from many sites).
 *
 * Covers: invalid URL, non-HTTP(S) scheme, IP-literal loopback/private/link-local/ULA,
 * alternative IPv4 encodings (decimal/octal/hex/short form), and obvious local/*.local
 * hostnames. Does NOT perform DNS resolution — callers that can afford async should
 * prefer `validateUrlForSSRF`.
 */
export function validateUrlForSSRFSync(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Invalid URL';
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'Only HTTP(S) URLs are allowed';
  }

  const hostnameRaw = parsed.hostname;
  if (!hostnameRaw) return 'URL has no hostname';

  const hostname = stripV6Brackets(hostnameRaw).toLowerCase();

  if (
    hostname === 'localhost' ||
    hostname === 'ip6-localhost' ||
    hostname === 'ip6-loopback' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.lan')
  ) {
    return 'Local/private hostname is not allowed';
  }

  if (net.isIP(hostname)) {
    if (net.isIPv4(hostname) && isBlockedIPv4(hostname)) return 'IP in blocked range';
    if (net.isIPv6(hostname) && isBlockedIPv6(hostname)) return 'IP in blocked range';
    return null;
  }

  const alt = decodeAlternativeIPv4(hostname);
  if (alt) {
    if (isBlockedIPv4(alt)) return 'Alternative IP form resolves to a blocked range';
    return null;
  }

  // Hostname without a dot that is not a known public TLD pattern — suspicious of docker names.
  if (!hostname.includes('.')) {
    return 'Bare hostname is not allowed (possible internal service)';
  }

  return null;
}

/**
 * Test-only export to exercise internals.
 */
export function __ssrfGuardInternals() {
  return { isBlockedIPv4, isBlockedIPv6, decodeAlternativeIPv4, resolveAndValidateHost };
}
