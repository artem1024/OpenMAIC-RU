/**
 * GET /api/classroom/export/{id}
 *
 * Streams the classroom as a `.maic.zip` archive containing:
 *   - meta.json         (format version, integrity hashes, source id, app version)
 *   - classroom.json    (full PersistedClassroomData incl. manifest history)
 *   - media/, audio/, interactive/  (versioned files referenced from manifest)
 *
 * Auth: relies on the global `INTERNAL_ACCESS_KEY` middleware (managed-mode
 * deployments). For self-hosted instances without that env, the route is
 * publicly readable — same posture as `GET /api/classroom/{id}`.
 *
 * No body / query params besides the path id.
 *
 * Errors via apiError envelope.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { apiError, API_ERROR_CODES } from '@/lib/server/api-response';
import { isValidClassroomId } from '@/lib/server/classroom-storage';
import {
  exportClassroomToZip,
  maxImportBytes,
} from '@/lib/server/classroom-zip';
import { CLASSROOM_ZIP_MIME_TYPE } from '@/lib/export/classroom-zip-types';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 min — large media trees can take a while

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!isValidClassroomId(id)) {
    return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'invalid classroom id');
  }
  let result;
  try {
    result = await exportClassroomToZip(id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'classroom not found') {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'classroom not found');
    }
    if (msg.includes('exceeds ZIP_IMPORT_MAX_BYTES')) {
      return apiError(
        API_ERROR_CODES.INVALID_REQUEST,
        413,
        `classroom too large to export under current cap (${maxImportBytes()} bytes); raise ZIP_IMPORT_MAX_BYTES`,
        msg,
      );
    }
    return apiError(API_ERROR_CODES.INTERNAL_ERROR, 500, 'export failed', msg);
  }

  // eslint-disable-next-line no-console
  console.log(
    `[classroom-export] ${JSON.stringify({
      classroomId: id,
      bytes: result.buffer.length,
      fileCount: result.meta.fileCount,
      mediaBytes: result.meta.totalBytes,
    })}`,
  );

  // Cast through unknown — Next's BodyInit lib doesn't include Buffer<ArrayBufferLike>
  // but the runtime accepts it (same trick as /api/proxy-media).
  return new NextResponse(result.buffer as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': CLASSROOM_ZIP_MIME_TYPE,
      'Content-Disposition': `attachment; filename="${result.filename}"`,
      'Content-Length': String(result.buffer.length),
      'Cache-Control': 'no-store',
    },
  });
}
