/**
 * POST /api/classroom/import
 *
 * Imports a classroom from a `.maic.zip` archive produced by
 * `GET /api/classroom/export/{id}`. The imported classroom always lands at a
 * **new** id with suffix `<sourcePrefix>-imported-<ts>-<nanoid>`; the original
 * is never touched.
 *
 * Request: raw `application/zip` body OR `multipart/form-data` with field
 *          `file`. `application/zip` is preferred (lower overhead).
 *
 * Auth: relies on `INTERNAL_ACCESS_KEY` middleware. Additionally feature-gated
 *       by `ZIP_IMPORT_ENABLED=true` (default false) to keep self-hosted
 *       deployments closed by default.
 *
 * Limits:
 *   - ZIP_IMPORT_MAX_BYTES   — default 100 MB, applies to total uncompressed
 *                              size AND per-entry size.
 *   - File-count cap         — 10 000 entries (hardcoded).
 *   - Allowed top dirs       — media/, audio/, interactive/.
 *
 * Security:
 *   - Path-escape guard rejects `..`, absolute, drive-letter, NUL, symlink-bait.
 *   - Integrity hashes (sha256 over classroom.json + media index) verified
 *     when present in meta.json.
 *   - Server picks the new classroom id; clients cannot influence the suffix.
 *   - Import does NOT trigger any LLM/TTS/image generation — managed-mode
 *     boundaries (and ai-gateway access) remain intact.
 */
import type { NextRequest } from 'next/server';
import { apiError, apiSuccess, API_ERROR_CODES } from '@/lib/server/api-response';
import { buildRequestOrigin } from '@/lib/server/classroom-storage';
import {
  importClassroomFromZip,
  isImportEnabled,
  maxImportBytes,
} from '@/lib/server/classroom-zip';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  if (!isImportEnabled()) {
    return apiError(
      API_ERROR_CODES.INVALID_REQUEST,
      403,
      'classroom ZIP import is disabled',
      'set ZIP_IMPORT_ENABLED=true on the server to enable',
    );
  }

  const maxBytes = maxImportBytes();
  const declaredLen = Number.parseInt(req.headers.get('content-length') || '0', 10);
  if (Number.isFinite(declaredLen) && declaredLen > maxBytes + 1024 * 1024) {
    return apiError(
      API_ERROR_CODES.INVALID_REQUEST,
      413,
      `request body exceeds ZIP_IMPORT_MAX_BYTES (${maxBytes})`,
    );
  }

  // Accept either raw application/zip or multipart with `file` field.
  let zipBuffer: Buffer;
  const contentType = (req.headers.get('content-type') || '').toLowerCase();
  try {
    if (contentType.startsWith('multipart/form-data')) {
      const form = await req.formData();
      const file = form.get('file');
      if (!(file instanceof Blob)) {
        return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'multipart missing `file` field');
      }
      const arr = await file.arrayBuffer();
      zipBuffer = Buffer.from(arr);
    } else {
      const arr = await req.arrayBuffer();
      zipBuffer = Buffer.from(arr);
    }
  } catch (err) {
    return apiError(
      API_ERROR_CODES.INVALID_REQUEST,
      400,
      'failed to read request body',
      err instanceof Error ? err.message : String(err),
    );
  }

  if (zipBuffer.length === 0) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'empty body');
  }
  if (zipBuffer.length > maxBytes) {
    return apiError(
      API_ERROR_CODES.INVALID_REQUEST,
      413,
      `zip exceeds ZIP_IMPORT_MAX_BYTES (${zipBuffer.length} > ${maxBytes})`,
    );
  }

  const baseUrl = buildRequestOrigin(req);

  try {
    const result = await importClassroomFromZip(zipBuffer, { baseUrl });
    // eslint-disable-next-line no-console
    console.log(
      `[classroom-import] ${JSON.stringify({
        outcome: 'success',
        sourceClassroomId: result.sourceClassroomId,
        newClassroomId: result.classroomId,
        fileCount: result.fileCount,
        bytes: result.totalBytes,
        durationMs: result.durationMs,
      })}`,
    );
    return apiSuccess(
      {
        classroomId: result.classroomId,
        sourceClassroomId: result.sourceClassroomId,
        fileCount: result.fileCount,
        totalBytes: result.totalBytes,
        durationMs: result.durationMs,
      },
      201,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.log(
      `[classroom-import] ${JSON.stringify({ outcome: 'failed', reason: msg })}`,
    );
    // Map common validation messages to 400.
    if (
      msg.startsWith('zip ') ||
      msg.startsWith('unsafe ') ||
      msg.startsWith('classroom.json') ||
      msg.startsWith('classroom.manifest') ||
      msg.includes('sha256 does not match') ||
      msg.includes('unsupported zip formatVersion') ||
      msg.startsWith('uncompressed zip total')
    ) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'invalid zip', msg);
    }
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'import failed', msg);
  }
}
