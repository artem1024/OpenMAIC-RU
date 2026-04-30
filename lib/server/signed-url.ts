/**
 * Helpers for validating S3 / MinIO presigned URLs (SigV4 query-string form).
 *
 * Used by the secured `/api/classroom/clone` endpoint to enforce a hard upper
 * bound on signed-URL lifetimes — callers must mint short-lived URLs (≤ 5 min)
 * for every asset they ask OpenMAIC to download. We do NOT trust the caller's
 * own TTL claims; we re-derive expiration from the signed parameters.
 *
 * Reference: https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
 */

/** Parse `YYYYMMDDTHHMMSSZ` (basic ISO-8601, used by SigV4) into a Date. */
export function parseAmzDate(value: string): Date | null {
  // 20260501T123456Z -> 2026-05-01T12:34:56Z
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

export interface SignedUrlInspection {
  ok: boolean;
  reason?: string;
  expiresAt?: Date;
}

/**
 * Inspect a presigned URL for SigV4 query parameters and verify the
 * effective expiration is no later than `now + maxTtlSeconds`.
 *
 * Rejects when:
 *   - URL is unparseable
 *   - `X-Amz-Date` or `X-Amz-Expires` is missing or malformed
 *   - `X-Amz-Expires` is not a positive integer
 *   - The implied expiration window exceeds `maxTtlSeconds` from "now"
 *   - The URL is already expired (allow up to `clockSkewSeconds` slack)
 *
 * Conservative on purpose — see plan §3.3 "OpenMAIC clone endpoint security".
 */
export function inspectSignedUrlTtl(
  signedUrl: string,
  options: { maxTtlSeconds: number; clockSkewSeconds?: number; now?: Date } = {
    maxTtlSeconds: 300,
  },
): SignedUrlInspection {
  const maxTtl = options.maxTtlSeconds;
  const skew = options.clockSkewSeconds ?? 30;
  const now = options.now ?? new Date();

  let parsed: URL;
  try {
    parsed = new URL(signedUrl);
  } catch {
    return { ok: false, reason: 'Invalid URL' };
  }

  // Accept either casing — S3 SigV4 mandates canonical casing but proxies
  // sometimes lowercase query keys.
  const params = parsed.searchParams;
  const amzDate = params.get('X-Amz-Date') ?? params.get('x-amz-date');
  const amzExpires = params.get('X-Amz-Expires') ?? params.get('x-amz-expires');

  if (!amzDate || !amzExpires) {
    return { ok: false, reason: 'Missing X-Amz-Date / X-Amz-Expires' };
  }

  const issuedAt = parseAmzDate(amzDate);
  if (!issuedAt) {
    return { ok: false, reason: 'Malformed X-Amz-Date' };
  }

  const expiresSec = Number.parseInt(amzExpires, 10);
  if (!Number.isFinite(expiresSec) || expiresSec <= 0 || expiresSec > 7 * 24 * 3600) {
    return { ok: false, reason: 'Malformed X-Amz-Expires' };
  }

  const expiresAt = new Date(issuedAt.getTime() + expiresSec * 1000);
  const ceiling = new Date(now.getTime() + maxTtl * 1000);

  if (expiresAt.getTime() > ceiling.getTime() + skew * 1000) {
    return {
      ok: false,
      reason: `Signed URL TTL too long (expires ${expiresAt.toISOString()}, ceiling ${ceiling.toISOString()})`,
      expiresAt,
    };
  }

  if (expiresAt.getTime() + skew * 1000 < now.getTime()) {
    return { ok: false, reason: 'Signed URL already expired', expiresAt };
  }

  return { ok: true, expiresAt };
}

/**
 * Convert a canonical asset path (`asset://audio/sp_1/v003.mp3`) to the
 * relative on-disk path inside a classroom dir (`audio/sp_1/v003.mp3`).
 *
 * Returns null if the path uses any unsafe segment (.., absolute, drive,
 * empty). Used as a sanitiser before writing assets onto disk.
 */
export function canonicalAssetPathToRelative(canonical: string): string | null {
  if (typeof canonical !== 'string') return null;
  if (!canonical.startsWith('asset://')) return null;
  const rel = canonical.slice('asset://'.length);
  if (rel.length === 0) return null;
  // Disallow absolute, traversal, backslash, NUL, leading slash.
  if (rel.startsWith('/') || rel.startsWith('\\')) return null;
  if (rel.includes('\0')) return null;
  const parts = rel.split('/');
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..') return null;
    if (p.includes('\\')) return null;
  }
  return rel;
}

/**
 * Recursively rewrite every string in a JSON value: replace `asset://` prefix
 * with the given replacement (e.g. `/api/classroom-media/{id}/`).
 *
 * Operates by structural walk; does not mutate the input. Used at the
 * persistence boundary (clone endpoint) to convert canonical paths in the
 * incoming `sourceClassroomJson` into classroom-bound serving URLs.
 */
export function rewriteAssetUrls<T>(value: T, replacement: string): T {
  return walk(value, replacement) as T;
}

function walk(value: unknown, replacement: string): unknown {
  if (typeof value === 'string') {
    if (value.startsWith('asset://')) {
      return replacement + value.slice('asset://'.length);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => walk(v, replacement));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v, replacement);
    }
    return out;
  }
  return value;
}
