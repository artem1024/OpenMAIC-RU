import { type NextRequest } from 'next/server';
import { apiError, apiSuccess, API_ERROR_CODES } from '@/lib/server/api-response';
import {
  createClassroomManifest,
  findCanvasElement,
  regenerateAssetElement,
} from '@/lib/server/classroom-media-generation';
import {
  buildRequestOrigin,
  isValidClassroomId,
  persistClassroom,
  readClassroom,
} from '@/lib/server/classroom-storage';

export const dynamic = 'force-dynamic';
export const maxDuration = 1800;

// Per-element image/video regeneration. Авторизация — через middleware
// (X-Internal-Key, см. middleware.ts → matcher: /api/:path*).
//
// Body:
//   {
//     elementId: string,
//     prompt?: string,                  // если отсутствует — берётся из manifest
//     params?: { aspectRatio?: string } // override параметров генерации
//   }
//
// Response:
//   { success: true, id, elementId, kind, versionNo, src, prompt }
//
// Errors:
//   400 — invalid body / element not image|video / нет промпта (ни в body, ни в manifest)
//   404 — classroom не найден / element не найден ни на одном слайде
//   502 — провайдер сгенерировал ошибку (после ретраев)
//
// Семантика:
//   - Если manifest отсутствует у classroom (legacy урок) — создаётся новый
//     пустой manifest и в него пушится первая версия.
//   - Если в body передан `prompt`, он сохраняется в `manifest.assets[id].prompt`
//     для следующих регенов (как и параметры из `params`).
//   - Новый файл пишется по versioned пути `media/{elementId}/v{NNN}.{ext}`,
//     `currentVersion` инкрементируется.
//   - `src` элемента в scene обновляется, classroom JSON персистится.
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!isValidClassroomId(id)) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id');
    }

    let body: { elementId?: string; prompt?: string; params?: Record<string, unknown> };
    try {
      body = await req.json();
    } catch {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid JSON body');
    }
    const elementId = typeof body.elementId === 'string' ? body.elementId.trim() : '';
    if (!elementId) {
      return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, 'elementId is required');
    }
    const prompt = typeof body.prompt === 'string' ? body.prompt : undefined;
    const params =
      body.params && typeof body.params === 'object' && !Array.isArray(body.params)
        ? (body.params as Record<string, unknown>)
        : undefined;

    const classroom = await readClassroom(id);
    if (!classroom) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Classroom not found');
    }

    // Pre-flight: 404 если элемент не найден; 400 если он не image/video.
    // Делаем это до создания manifest'а, чтобы не подменять manifest на legacy
    // уроке только ради того, чтобы вернуть ошибку.
    const found = findCanvasElement(classroom.scenes, elementId);
    if (!found) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, `Element "${elementId}" not found`);
    }
    if (found.element.type !== 'image' && found.element.type !== 'video') {
      return apiError(
        API_ERROR_CODES.INVALID_REQUEST,
        400,
        `Element "${elementId}" has type "${String(found.element.type)}"; only image/video supported`,
      );
    }

    // Manifest: legacy classrooms могут не иметь его — создаём пустой и
    // персистим вместе с новым ассетом.
    const manifest = classroom.manifest ?? createClassroomManifest();

    const baseUrl = buildRequestOrigin(req);

    let result;
    try {
      result = await regenerateAssetElement(classroom.scenes, manifest, id, baseUrl, {
        elementId,
        prompt,
        params,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Ошибки «нет промпта» и валидационные превращаем в 400; остальное — 502.
      if (msg.includes('No prompt provided')) {
        return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, msg);
      }
      if (msg.includes('No API key') || msg.includes('No image provider') || msg.includes('No video provider')) {
        return apiError(API_ERROR_CODES.MISSING_API_KEY, 500, msg);
      }
      return apiError(API_ERROR_CODES.UPSTREAM_ERROR, 502, 'Asset generation failed', msg);
    }

    await persistClassroom(
      {
        id,
        stage: classroom.stage,
        scenes: classroom.scenes,
        manifest,
      },
      baseUrl,
    );

    return apiSuccess({
      id,
      elementId: result.elementId,
      kind: result.kind,
      versionNo: result.versionNo,
      src: result.src,
      prompt: result.prompt,
    });
  } catch (error) {
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to regenerate asset',
      error instanceof Error ? error.message : String(error),
    );
  }
}
