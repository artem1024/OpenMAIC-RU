import { type NextRequest } from 'next/server';
import { apiError, apiSuccess, API_ERROR_CODES } from '@/lib/server/api-response';
import {
  createClassroomManifest,
  regenerateInteractiveSlide,
} from '@/lib/server/classroom-media-generation';
import {
  buildRequestOrigin,
  isValidClassroomId,
  persistClassroom,
  readClassroom,
} from '@/lib/server/classroom-storage';
import { callLLM } from '@/lib/ai/llm';
import { resolveModel } from '@/lib/server/resolve-model';

export const dynamic = 'force-dynamic';
export const maxDuration = 1800;

// Per-scene interactive HTML regeneration. Авторизация — через middleware
// (X-Internal-Key).
//
// Body:
//   { sceneId: string, prompt?: string }
//
// Response:
//   { success: true, id, sceneId, versionNo, htmlPath }
//
// Errors:
//   400 — invalid body / scene не interactive / нет промпта
//   404 — classroom не найден / scene не найден
//   502 — LLM упал / не вернул валидный HTML
//
// Security:
//   HTML рендерится в sandboxed iframe (allow-scripts, без allow-same-origin)
//   с CSP `connect-src 'none'; frame-src 'none'; object-src 'none'`. Здесь
//   дополнительно (defense-in-depth) вырезаем `<iframe>/<object>/<embed>/<applet>`
//   на этапе записи в файл — см. sanitizeInteractiveHtml в
//   classroom-media-generation.ts. Renderer тоже стрипает на чтении, чтобы
//   старые файлы тоже были безопасны.
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!isValidClassroomId(id)) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id');
    }

    let body: { sceneId?: string; prompt?: string };
    try {
      body = await req.json();
    } catch {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid JSON body');
    }
    const sceneId = typeof body.sceneId === 'string' ? body.sceneId.trim() : '';
    if (!sceneId) {
      return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, 'sceneId is required');
    }
    const prompt = typeof body.prompt === 'string' ? body.prompt : undefined;

    const classroom = await readClassroom(id);
    if (!classroom) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Classroom not found');
    }

    const scene = classroom.scenes.find((s) => s.id === sceneId);
    if (!scene) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, `Scene "${sceneId}" not found`);
    }
    if (scene.type !== 'interactive') {
      return apiError(
        API_ERROR_CODES.INVALID_REQUEST,
        400,
        `Scene "${sceneId}" has type "${scene.type}"; only interactive scenes supported`,
      );
    }

    const manifest = classroom.manifest ?? createClassroomManifest();
    const baseUrl = buildRequestOrigin(req);

    // Резолвим модель так же, как при полной генерации — DEFAULT_MODEL из env
    // (в managed mode перебивает любое клиентское значение). Wrapper-aiCall
    // дальше пробрасывается в helper, который не знает про конкретного провайдера.
    const { model: languageModel, modelInfo, modelString } = resolveModel({});
    const aiCall = async (system: string, user: string): Promise<string> => {
      const result = await callLLM(
        {
          model: languageModel,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          // Interactive HTML обрезается без достаточного outputWindow — фиксим
          // как в основном пайплайне: тянем maxOutputTokens из modelInfo.
          maxOutputTokens: modelInfo?.outputWindow,
        },
        'regenerate-interactive',
      );
      return result.text;
    };

    let result;
    try {
      result = await regenerateInteractiveSlide(classroom.scenes, manifest, id, {
        sceneId,
        prompt,
        aiCall,
        modelLabel: modelString,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('No prompt provided')) {
        return apiError(API_ERROR_CODES.MISSING_REQUIRED_FIELD, 400, msg);
      }
      if (msg.includes('did not contain a recognizable HTML document')) {
        return apiError(API_ERROR_CODES.UPSTREAM_ERROR, 502, msg);
      }
      return apiError(API_ERROR_CODES.UPSTREAM_ERROR, 502, 'Interactive HTML generation failed', msg);
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
      sceneId: result.sceneId,
      versionNo: result.versionNo,
      htmlPath: result.htmlPath,
    });
  } catch (error) {
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to regenerate interactive slide',
      error instanceof Error ? error.message : String(error),
    );
  }
}
