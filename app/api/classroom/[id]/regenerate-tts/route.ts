import { type NextRequest } from 'next/server';
import { apiError, apiSuccess, API_ERROR_CODES } from '@/lib/server/api-response';
import { generateTTSForClassroom } from '@/lib/server/classroom-media-generation';
import {
  buildRequestOrigin,
  isValidClassroomId,
  persistClassroom,
  readClassroom,
} from '@/lib/server/classroom-storage';

export const dynamic = 'force-dynamic';
export const maxDuration = 1800;

// Перегенерирует mp3-файлы озвучки для существующего classroom. Поддерживает
// два режима:
//
//   - Whole-classroom (тело пустое или actionIds отсутствует/пустой) — старое
//     поведение, перегенерируется вся озвучка с учётом textHash idempotency
//     (если force != true).
//   - Partial (`actionIds: [...]`) — перегенерируются только указанные
//     speech-actions; остальные не трогаются.
//
// `force=true` обходит textHash idempotency (revoice / corrupt-mp3 recovery /
// смена TTS-провайдера). Без `force` действия с неизменившимся текстом
// пропускаются и попадают в `skipped`.
//
// Контракт ответа:
//   {
//     success: true,
//     id,
//     count,                    // = regenerated.length, для backwards-compat
//     providerId,               // последний использованный TTS-провайдер
//     regenerated: [{ actionId, versionNo, audioUrl, textHash }],
//     skipped:     [{ actionId, reason: 'textHashMatch' }]
//   }
//
// Classroom JSON персистится только если был хотя бы один реальный регенен —
// иначе диск не трогаем (это полностью no-op запрос).
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;

    if (!isValidClassroomId(id)) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id');
    }

    const classroom = await readClassroom(id);
    if (!classroom) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Classroom not found');
    }

    // Body опционален: GET-style запросы (без body) и пустой body должны
    // работать как whole-classroom regen, чтобы старые osvaivai-вызовы не сломались.
    let body: { actionIds?: string[]; force?: boolean } = {};
    try {
      const text = await req.text();
      if (text.trim().length > 0) {
        body = JSON.parse(text);
      }
    } catch {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid JSON body');
    }

    const actionIds = Array.isArray(body.actionIds)
      ? body.actionIds.filter((s): s is string => typeof s === 'string' && s.length > 0)
      : undefined;
    const force = body.force === true;

    const baseUrl = buildRequestOrigin(req);
    const stats = await generateTTSForClassroom(classroom.scenes, id, baseUrl, undefined, {
      ...(actionIds && actionIds.length > 0 ? { actionIds } : {}),
      force,
    });

    // Persist updated audioUrl + tts metadata back to disk so the player
    // resolves the new versioned paths. Skip persist on pure no-op.
    if (stats.regenerated.length > 0) {
      await persistClassroom(
        {
          id,
          stage: classroom.stage,
          scenes: classroom.scenes,
          ...(classroom.manifest ? { manifest: classroom.manifest } : {}),
        },
        baseUrl,
      );
    }

    return apiSuccess({
      id,
      count: stats.regenerated.length,
      providerId: stats.providerId,
      regenerated: stats.regenerated,
      skipped: stats.skipped,
    });
  } catch (error) {
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to regenerate TTS',
      error instanceof Error ? error.message : String(error),
    );
  }
}
