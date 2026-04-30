/**
 * POST /api/classroom/clone — secured publisher endpoint.
 *
 * Used by osvaivai's revision publisher (lesson editor, Wave 3) to materialise
 * a new OpenMAIC classroom from a JSON snapshot + a list of asset references
 * in osvaivai-side MinIO. OpenMAIC downloads each asset over the network,
 * verifies its sha256, rewrites canonical `asset://...` paths in the snapshot
 * to classroom-bound serving URLs, and persists the result on local disk.
 *
 * ─── Wire contract (do NOT change without coordinating with osvaivai) ───────
 *
 * Auth: existing `X-Internal-Key` middleware (see middleware.ts). This route
 *       does NOT add additional auth — it relies on the global guard.
 *
 * Request body:
 *   {
 *     sourceClassroomJson: PersistedClassroomData,  // canonical asset:// paths
 *     manifest:            ClassroomManifest,       // explicit; not derived
 *     assets: Array<{
 *       canonicalPath: string,  // e.g. "asset://audio/sp_1/v003.mp3"
 *       signedUrl:     string,  // SigV4 presigned URL on osvaivai MinIO
 *       sha256:        string,  // hex; OpenMAIC verifies after download
 *     }>,
 *     preferredPrefix?: string, // optional — slugified, suffixed with -nanoid(8)
 *   }
 *
 * Success response:
 *   { success: true, classroomId: string, assetsWritten: number, durationMs: number }
 *
 * Errors: standard apiError envelope. Status mapping:
 *   400 — malformed body, schema/size/path violations
 *   403 — host allowlist / SSRF / signed-URL-TTL failure (no detail leaked)
 *   408 — download stalled / per-asset timeout
 *   429 — rate limit
 *   502 — non-security download failure
 *   500 — internal error after security checks pass
 *
 * ─── Security gates (every one is independent; failing any → reject) ────────
 *
 *   1. Host allowlist          — signedUrl host ∈ OSVAIVAI_MINIO_HOST list
 *   2. SSRF guard              — DNS resolve, reject private/loopback IPs
 *                                unless ALLOW_PRIVATE_OSVAIVAI=1 (docker dev)
 *   3. Signed-URL TTL          — derive expiry from X-Amz-Date+X-Amz-Expires,
 *                                require ≤ now + 300s (5 minutes)
 *   4. sha256 verification     — verify after download; mismatch → reject + GC
 *   5. Payload size limits     — JSON ≤ 5MB; assets ≤ 200; per-asset ≤ 100MB
 *   6. Rate limit              — 10 req/min per X-Internal-Key (in-memory)
 *   7. Server-generated ID     — clients cannot pick classroomId; we slug
 *                                preferredPrefix + append nanoid(8)
 *
 * Path canonicalization at the boundary:
 *   The incoming `sourceClassroomJson` carries `asset://...` paths. Before
 *   `persistClassroom`, we rewrite every such string to
 *   `/api/classroom-media/{newClassroomId}/...` so the runtime player can
 *   serve assets via the existing media route. The on-disk asset files are
 *   stored at `data/classrooms/{newClassroomId}/{audio|media|interactive}/...`.
 *
 * ─── Env vars ────────────────────────────────────────────────────────────────
 *   INTERNAL_ACCESS_KEY        — existing; consumed by middleware.ts
 *   OSVAIVAI_MINIO_HOST        — required; comma-separated host[:port] list
 *   ALLOW_PRIVATE_OSVAIVAI     — default 0; opt-in for docker-compose internal
 *                                addressing where MinIO is on a private IP
 *   MAX_ASSET_BYTES            — default 104857600 (100 MB)
 *   CLONE_RATE_LIMIT_PER_MIN   — default 10
 */

import { type NextRequest } from 'next/server';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { nanoid } from 'nanoid';

import { apiError, apiSuccess, API_ERROR_CODES } from '@/lib/server/api-response';
import {
  CLASSROOMS_DIR,
  buildRequestOrigin,
  isValidClassroomId,
  persistClassroom,
} from '@/lib/server/classroom-storage';
import { resolveAndValidateHost, ssrfSafeFetch } from '@/lib/server/ssrf-guard';
import {
  canonicalAssetPathToRelative,
  inspectSignedUrlTtl,
  rewriteAssetUrls,
} from '@/lib/server/signed-url';
import { classroomManifestSchema } from '@/lib/types/manifest';

export const dynamic = 'force-dynamic';
export const maxDuration = 1800;

// ─── Limits & config ────────────────────────────────────────────────────────

const MAX_JSON_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_ASSETS = 200;
const SIGNED_URL_TTL_CEILING_SEC = 300; // 5 minutes
const PER_ASSET_DOWNLOAD_TIMEOUT_MS = 60_000;

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function maxAssetBytes(): number {
  return envInt('MAX_ASSET_BYTES', 100 * 1024 * 1024);
}

function cloneRateLimitPerMin(): number {
  return envInt('CLONE_RATE_LIMIT_PER_MIN', 10);
}

function allowedMinioHosts(): string[] {
  const raw = process.env.OSVAIVAI_MINIO_HOST?.trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

function allowPrivateOsvaivai(): boolean {
  return process.env.ALLOW_PRIVATE_OSVAIVAI === '1';
}

// ─── Rate limiter (in-memory, leaky bucket per INTERNAL_ACCESS_KEY) ─────────
//
// Notes:
//   - Limits are PER-PROCESS. Multi-replica deployments will get
//     `replicas × CLONE_RATE_LIMIT_PER_MIN` effective ceiling. Acceptable for
//     MVP given clones are infrequent and the only legitimate caller is
//     osvaivai (which throttles its own publisher).
//   - Bucket is keyed on INTERNAL_ACCESS_KEY value, so a key rotation flushes
//     state naturally on the next request. We do NOT key on caller IP — the
//     caller is always the osvaivai backend behind a fixed key.

type Bucket = { tokens: number; lastRefillMs: number };
const RATE_BUCKETS = new Map<string, Bucket>();
const RATE_REFILL_INTERVAL_MS = 60_000;

function tryAcquireRateToken(key: string): boolean {
  const limit = cloneRateLimitPerMin();
  const now = Date.now();
  const existing = RATE_BUCKETS.get(key);
  if (!existing) {
    RATE_BUCKETS.set(key, { tokens: limit - 1, lastRefillMs: now });
    return true;
  }
  // Refill proportional to elapsed time (leaky-bucket-style)
  const elapsed = now - existing.lastRefillMs;
  if (elapsed > 0) {
    const refill = (elapsed / RATE_REFILL_INTERVAL_MS) * limit;
    existing.tokens = Math.min(limit, existing.tokens + refill);
    existing.lastRefillMs = now;
  }
  if (existing.tokens >= 1) {
    existing.tokens -= 1;
    return true;
  }
  return false;
}

// ─── classroomId generation ─────────────────────────────────────────────────

function slugifyPrefix(input: string | undefined): string {
  if (!input) return '';
  const s = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  return s;
}

function generateClassroomId(preferredPrefix?: string): string {
  const slug = slugifyPrefix(preferredPrefix);
  const suffix = nanoid(8).replace(/[^a-zA-Z0-9_-]/g, ''); // belt-and-braces
  return slug ? `${slug}-${suffix}` : suffix;
}

// ─── Logging helper (structured, signed URLs scrubbed) ──────────────────────

interface CloneLog {
  requestId: string;
  ts: string;
  outcome: 'success' | 'rejected' | 'failed';
  reason?: string;
  assetCount: number;
  durationMs: number;
  classroomId?: string;
  rateLimited?: boolean;
  hostAllowlist?: 'pass' | 'fail';
  ssrf?: 'pass' | 'fail';
  ttl?: 'pass' | 'fail';
}

function logClone(entry: CloneLog): void {
  // eslint-disable-next-line no-console
  console.log(`[classroom-clone] ${JSON.stringify(entry)}`);
}

// ─── Main handler ───────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const requestId = randomUUID();
  const startedAt = Date.now();
  let stagingDir: string | null = null;
  let finalDir: string | null = null;
  let finalJsonPath: string | null = null;

  try {
    // [Gate 6] Rate limit per INTERNAL_ACCESS_KEY (the middleware has already
    // verified the header matches; we just key on it for accounting).
    const internalKey = req.headers.get('X-Internal-Key') ?? 'anon';
    if (!tryAcquireRateToken(internalKey)) {
      logClone({
        requestId,
        ts: new Date().toISOString(),
        outcome: 'rejected',
        reason: 'rate-limit',
        assetCount: 0,
        durationMs: Date.now() - startedAt,
        rateLimited: true,
      });
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 429, 'Rate limit exceeded');
    }

    // [Gate 5] Body size guard — peek at content-length first, then re-check
    // after JSON.stringify since callers can lie about content-length.
    const declaredLen = Number.parseInt(req.headers.get('content-length') || '0', 10);
    if (declaredLen > MAX_JSON_BYTES + 1024 * 1024) {
      // Allow some slack for assets metadata vs the json subkey.
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 413, 'Request body too large');
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid JSON body');
    }
    if (!body || typeof body !== 'object') {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Body must be a JSON object');
    }
    const {
      sourceClassroomJson,
      manifest,
      assets,
      preferredPrefix,
    } = body as {
      sourceClassroomJson?: unknown;
      manifest?: unknown;
      assets?: unknown;
      preferredPrefix?: unknown;
    };

    // ── Field shape & size checks ──
    if (!sourceClassroomJson || typeof sourceClassroomJson !== 'object') {
      return apiError(
        API_ERROR_CODES.MISSING_REQUIRED_FIELD,
        400,
        'sourceClassroomJson is required',
      );
    }
    const jsonText = JSON.stringify(sourceClassroomJson);
    if (jsonText.length > MAX_JSON_BYTES) {
      return apiError(
        API_ERROR_CODES.INVALID_REQUEST,
        413,
        `sourceClassroomJson exceeds ${MAX_JSON_BYTES} bytes`,
      );
    }

    if (!manifest || typeof manifest !== 'object') {
      return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, 'manifest is required');
    }
    const manifestParsed = classroomManifestSchema.safeParse(manifest);
    if (!manifestParsed.success) {
      return apiError(
        API_ERROR_CODES.INVALID_REQUEST,
        400,
        'manifest failed schema validation',
        manifestParsed.error.message,
      );
    }

    if (!Array.isArray(assets)) {
      return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, 'assets must be an array');
    }
    if (assets.length > MAX_ASSETS) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, `too many assets (max ${MAX_ASSETS})`);
    }

    if (preferredPrefix !== undefined && typeof preferredPrefix !== 'string') {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'preferredPrefix must be a string');
    }

    // ── Per-asset shape check ──
    type AssetEntry = { canonicalPath: string; signedUrl: string; sha256: string; relPath: string };
    const parsedAssets: AssetEntry[] = [];
    const seenRel = new Set<string>();
    for (let i = 0; i < assets.length; i += 1) {
      const a = assets[i] as unknown;
      if (!a || typeof a !== 'object') {
        return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, `assets[${i}]: must be an object`);
      }
      const { canonicalPath, signedUrl, sha256 } = a as {
        canonicalPath?: unknown;
        signedUrl?: unknown;
        sha256?: unknown;
      };
      if (typeof canonicalPath !== 'string' || typeof signedUrl !== 'string' || typeof sha256 !== 'string') {
        return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, `assets[${i}]: missing fields`);
      }
      const rel = canonicalAssetPathToRelative(canonicalPath);
      if (!rel) {
        return apiError(
          API_ERROR_CODES.INVALID_REQUEST,
          400,
          `assets[${i}]: invalid canonicalPath`,
        );
      }
      if (!/^[0-9a-fA-F]{64}$/.test(sha256)) {
        return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, `assets[${i}]: invalid sha256`);
      }
      if (seenRel.has(rel)) {
        return apiError(
          API_ERROR_CODES.INVALID_REQUEST,
          400,
          `assets[${i}]: duplicate canonicalPath`,
        );
      }
      seenRel.add(rel);
      parsedAssets.push({ canonicalPath, signedUrl, sha256: sha256.toLowerCase(), relPath: rel });
    }

    // ── [Gate 1] Host allowlist + [Gate 2] SSRF + [Gate 3] TTL ──
    const allowed = allowedMinioHosts();
    if (allowed.length === 0) {
      logClone({
        requestId,
        ts: new Date().toISOString(),
        outcome: 'failed',
        reason: 'OSVAIVAI_MINIO_HOST not configured',
        assetCount: parsedAssets.length,
        durationMs: Date.now() - startedAt,
      });
      return apiError(
        API_ERROR_CODES.INTERNAL_ERROR,
        500,
        'Clone endpoint is not configured',
      );
    }
    const allowPriv = allowPrivateOsvaivai();

    for (let i = 0; i < parsedAssets.length; i += 1) {
      const a = parsedAssets[i];
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(a.signedUrl);
      } catch {
        logClone({
          requestId,
          ts: new Date().toISOString(),
          outcome: 'rejected',
          reason: 'invalid-url',
          assetCount: parsedAssets.length,
          durationMs: Date.now() - startedAt,
          hostAllowlist: 'fail',
        });
        return apiError(API_ERROR_CODES.INVALID_URL, 400, `assets[${i}]: invalid signedUrl`);
      }
      if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
        return apiError(API_ERROR_CODES.INVALID_URL, 400, `assets[${i}]: scheme not allowed`);
      }

      // Gate 1 — host (hostname only, optionally with port). We compare against
      // the configured list; a configured entry without `:` matches any port.
      const hostnameOnly = parsedUrl.hostname.toLowerCase();
      const hostnameWithPort = parsedUrl.port
        ? `${hostnameOnly}:${parsedUrl.port}`
        : hostnameOnly;
      const hostMatches = allowed.some(
        (h) => h === hostnameOnly || h === hostnameWithPort,
      );
      if (!hostMatches) {
        logClone({
          requestId,
          ts: new Date().toISOString(),
          outcome: 'rejected',
          reason: 'host-allowlist',
          assetCount: parsedAssets.length,
          durationMs: Date.now() - startedAt,
          hostAllowlist: 'fail',
        });
        return apiError(API_ERROR_CODES.INVALID_URL, 403, 'asset host not allowed');
      }

      // Gate 2 — SSRF (DNS-resolve + private-IP block).
      // ALLOW_PRIVATE_OSVAIVAI=1 is the documented escape hatch for
      // docker-compose where MinIO sits on the same overlay network and
      // therefore on a private IP. In that mode we *still* check the host
      // allowlist (Gate 1) — the override is purely about the IP-range gate.
      if (!allowPriv) {
        const r = await resolveAndValidateHost(parsedUrl.hostname);
        if (!r.ok) {
          logClone({
            requestId,
            ts: new Date().toISOString(),
            outcome: 'rejected',
            reason: 'ssrf-block',
            assetCount: parsedAssets.length,
            durationMs: Date.now() - startedAt,
            hostAllowlist: 'pass',
            ssrf: 'fail',
          });
          return apiError(API_ERROR_CODES.INVALID_URL, 403, 'asset host failed SSRF check');
        }
      }

      // Gate 3 — signed URL TTL ≤ 300s.
      const ttl = inspectSignedUrlTtl(a.signedUrl, { maxTtlSeconds: SIGNED_URL_TTL_CEILING_SEC });
      if (!ttl.ok) {
        logClone({
          requestId,
          ts: new Date().toISOString(),
          outcome: 'rejected',
          reason: `ttl: ${ttl.reason}`,
          assetCount: parsedAssets.length,
          durationMs: Date.now() - startedAt,
          hostAllowlist: 'pass',
          ssrf: 'pass',
          ttl: 'fail',
        });
        return apiError(API_ERROR_CODES.INVALID_URL, 403, 'asset signed URL is too long-lived');
      }
    }

    // ── [Gate 7] Server-generated classroomId ──
    const newClassroomId = generateClassroomId(
      typeof preferredPrefix === 'string' ? preferredPrefix : undefined,
    );
    if (!isValidClassroomId(newClassroomId)) {
      // Defence in depth — the slug+nanoid output should always pass.
      return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Failed to generate classroomId');
    }
    finalDir = path.join(CLASSROOMS_DIR, newClassroomId);
    finalJsonPath = path.join(CLASSROOMS_DIR, `${newClassroomId}.json`);

    // Refuse to clobber an existing classroom (vanishingly unlikely with nanoid(8)).
    try {
      await fs.access(finalDir);
      return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'Generated classroomId collided');
    } catch {
      /* ENOENT — good */
    }

    // ── Stage assets into a temp dir, then atomic rename ──
    stagingDir = path.join(CLASSROOMS_DIR, `.tmp-${newClassroomId}-${Date.now()}`);
    await fs.mkdir(stagingDir, { recursive: true });

    const maxBytesPerAsset = maxAssetBytes();

    for (let i = 0; i < parsedAssets.length; i += 1) {
      const a = parsedAssets[i];
      const targetAbs = path.join(stagingDir, a.relPath);
      // Defence-in-depth: ensure resolved path stays inside the staging dir.
      const resolvedTarget = path.resolve(targetAbs);
      const resolvedStaging = path.resolve(stagingDir);
      if (!resolvedTarget.startsWith(resolvedStaging + path.sep)) {
        await safeRm(stagingDir);
        return apiError(
          API_ERROR_CODES.INVALID_REQUEST,
          400,
          `assets[${i}]: path escapes staging dir`,
        );
      }

      await fs.mkdir(path.dirname(resolvedTarget), { recursive: true });

      // Download — pinned IP, host header preserved, scheme http(s) only.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), PER_ASSET_DOWNLOAD_TIMEOUT_MS);
      let buf: Buffer;
      try {
        const resp = await ssrfSafeFetch(a.signedUrl, {
          method: 'GET',
          signal: controller.signal,
          // No-cache: signed URLs are single-use by design.
          headers: { 'cache-control': 'no-cache' },
        });
        if (!resp.ok) {
          await safeRm(stagingDir);
          return apiError(
            API_ERROR_CODES.UPSTREAM_ERROR,
            502,
            `assets[${i}]: download failed with status ${resp.status}`,
          );
        }
        const contentLen = Number.parseInt(resp.headers.get('content-length') ?? '0', 10);
        if (Number.isFinite(contentLen) && contentLen > maxBytesPerAsset) {
          await safeRm(stagingDir);
          return apiError(
            API_ERROR_CODES.INVALID_REQUEST,
            413,
            `assets[${i}]: declared content-length exceeds limit`,
          );
        }
        const arr = await resp.arrayBuffer();
        buf = Buffer.from(arr);
        if (buf.length > maxBytesPerAsset) {
          await safeRm(stagingDir);
          return apiError(
            API_ERROR_CODES.INVALID_REQUEST,
            413,
            `assets[${i}]: payload exceeds ${maxBytesPerAsset} bytes`,
          );
        }
      } catch (e) {
        await safeRm(stagingDir);
        const msg = e instanceof Error ? e.message : String(e);
        const aborted = (e as { name?: string })?.name === 'AbortError';
        return apiError(
          aborted ? API_ERROR_CODES.UPSTREAM_ERROR : API_ERROR_CODES.UPSTREAM_ERROR,
          aborted ? 408 : 502,
          aborted ? 'asset download timed out' : 'asset download failed',
          // Strip signed URL — only log host+path on the server side.
          msg.replace(/https?:\/\/[^\s]+/g, '<redacted>'),
        );
      } finally {
        clearTimeout(timeout);
      }

      // Gate 4 — sha256 verification.
      const computed = createHash('sha256').update(buf).digest('hex');
      if (computed.toLowerCase() !== a.sha256) {
        await safeRm(stagingDir);
        return apiError(
          API_ERROR_CODES.INVALID_REQUEST,
          400,
          `assets[${i}]: sha256 mismatch`,
        );
      }

      // Atomic write: tmp file → rename.
      const tmpFile = `${resolvedTarget}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmpFile, buf);
      await fs.rename(tmpFile, resolvedTarget);
    }

    // ── Path canonicalization: rewrite asset:// → /api/classroom-media/{newId}/ ──
    const replacement = `/api/classroom-media/${newClassroomId}/`;
    const rewrittenJson = rewriteAssetUrls(
      sourceClassroomJson as Record<string, unknown>,
      replacement,
    );
    const rewrittenManifest = rewriteAssetUrls(manifestParsed.data, replacement);

    // The persisted JSON must contain the new id, not whatever the source had.
    const stage = (rewrittenJson as { stage?: unknown }).stage;
    const scenes = (rewrittenJson as { scenes?: unknown }).scenes;
    if (!stage || !scenes) {
      await safeRm(stagingDir);
      return apiError(
        API_ERROR_CODES.INVALID_REQUEST,
        400,
        'sourceClassroomJson missing stage/scenes',
      );
    }

    // Atomic-rename the staging dir into final location BEFORE writing JSON,
    // so the JSON file is never published while assets are partially staged.
    await fs.rename(stagingDir, finalDir);
    stagingDir = null; // ownership transferred — no longer GC target

    const baseUrl = buildRequestOrigin(req);
    try {
      await persistClassroom(
        {
          id: newClassroomId,
          stage: { ...(stage as Record<string, unknown>), id: newClassroomId } as never,
          scenes: scenes as never,
          manifest: rewrittenManifest,
        },
        baseUrl,
      );
    } catch (e) {
      // JSON write failed — clean up the renamed dir.
      await safeRm(finalDir);
      finalDir = null;
      throw e;
    }

    const durationMs = Date.now() - startedAt;
    logClone({
      requestId,
      ts: new Date().toISOString(),
      outcome: 'success',
      assetCount: parsedAssets.length,
      durationMs,
      classroomId: newClassroomId,
      hostAllowlist: 'pass',
      ssrf: allowPriv ? undefined : 'pass',
      ttl: 'pass',
    });

    return apiSuccess(
      {
        classroomId: newClassroomId,
        assetsWritten: parsedAssets.length,
        durationMs,
      },
      201,
    );
  } catch (error) {
    // Best-effort cleanup of any partial state.
    if (stagingDir) await safeRm(stagingDir);
    if (finalDir) await safeRm(finalDir);
    if (finalJsonPath) {
      await fs.unlink(finalJsonPath).catch(() => undefined);
    }
    logClone({
      requestId,
      ts: new Date().toISOString(),
      outcome: 'failed',
      reason: error instanceof Error ? error.message : String(error),
      assetCount: 0,
      durationMs: Date.now() - startedAt,
    });
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to clone classroom',
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function safeRm(target: string): Promise<void> {
  try {
    await fs.rm(target, { recursive: true, force: true });
  } catch {
    /* swallow — best effort */
  }
}
