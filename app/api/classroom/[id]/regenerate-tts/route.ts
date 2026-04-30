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

// Перегенерирует ТОЛЬКО mp3-файлы озвучки для существующего classroom,
// сохраняя сцены/слайды/контент без изменений. Используется когда озвучка
// деградировала (например, cascade fallback на edge-tts из-за глюка Vertex),
// а сам урок переделывать не нужно. Слайдовые layouts намеренно не трогаются.
//
// С переходом на versioned paths (`audio/{actionId}/v{NNN}.mp3`) audioUrl
// меняется при каждом регене, поэтому JSON нужно persist'ить, чтобы плеер
// читал новые ссылки. TTS-метаданные (`speechAction.tts`) тоже обновляются.
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

    const baseUrl = buildRequestOrigin(req);
    const stats = await generateTTSForClassroom(classroom.scenes, id, baseUrl);

    // Persist updated audioUrl + tts metadata back to disk so the player
    // resolves the new versioned paths. Manifest (image/video) is preserved
    // as-is — TTS regen does not touch media assets.
    await persistClassroom(
      {
        id,
        stage: classroom.stage,
        scenes: classroom.scenes,
        ...(classroom.manifest ? { manifest: classroom.manifest } : {}),
      },
      baseUrl,
    );

    return apiSuccess({
      id,
      count: stats.count,
      providerId: stats.providerId,
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
