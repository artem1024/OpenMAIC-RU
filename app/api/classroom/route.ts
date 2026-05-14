import { type NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import path from 'path';
import { apiSuccess, apiError, API_ERROR_CODES } from '@/lib/server/api-response';
import {
  CLASSROOMS_DIR,
  buildRequestOrigin,
  deleteClassroom,
  ensureClassroomsDir,
  isValidClassroomId,
  persistClassroom,
  readClassroom,
  writeJsonFileAtomic,
} from '@/lib/server/classroom-storage';
import { rewriteAssetUrls } from '@/lib/server/signed-url';

const MAX_SYNC_JSON_BYTES = 5 * 1024 * 1024;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { stage, scenes } = body;

    if (!stage || !scenes) {
      return apiError(
        API_ERROR_CODES.MISSING_REQUIRED_FIELD,
        400,
        'Missing required fields: stage, scenes',
      );
    }

    const id = stage.id || randomUUID();
    const baseUrl = buildRequestOrigin(request);

    const persisted = await persistClassroom({ id, stage: { ...stage, id }, scenes }, baseUrl);

    return apiSuccess({ id: persisted.id, url: persisted.url }, 201);
  } catch (error) {
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to store classroom',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get('id');

    if (!id) {
      return apiError(
        API_ERROR_CODES.MISSING_REQUIRED_FIELD,
        400,
        'Missing required parameter: id',
      );
    }

    if (!isValidClassroomId(id)) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id');
    }

    const classroom = await readClassroom(id);
    if (!classroom) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Classroom not found');
    }

    return apiSuccess({ classroom });
  } catch (error) {
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to retrieve classroom',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get('id');

    if (!id) {
      return apiError(
        API_ERROR_CODES.MISSING_REQUIRED_FIELD,
        400,
        'Missing required parameter: id',
      );
    }

    if (!isValidClassroomId(id)) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id');
    }

    const existing = await readClassroom(id);
    if (!existing) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Classroom not found');
    }

    let body: { sourceClassroomJson?: unknown };
    try {
      body = await request.json();
    } catch {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid JSON body');
    }
    if (!body || typeof body !== 'object') {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Body must be a JSON object');
    }

    const { sourceClassroomJson } = body;
    if (!sourceClassroomJson || typeof sourceClassroomJson !== 'object') {
      return apiError(
        API_ERROR_CODES.MISSING_REQUIRED_FIELD,
        400,
        'sourceClassroomJson is required',
      );
    }

    const jsonText = JSON.stringify(sourceClassroomJson);
    if (jsonText.length > MAX_SYNC_JSON_BYTES) {
      return apiError(
        API_ERROR_CODES.INVALID_REQUEST,
        413,
        `sourceClassroomJson exceeds ${MAX_SYNC_JSON_BYTES} bytes`,
      );
    }

    const replacement = `/api/classroom-media/${id}/`;
    const rewrittenJson = rewriteAssetUrls(
      sourceClassroomJson as Record<string, unknown>,
      replacement,
    );

    const stage = (rewrittenJson as { stage?: unknown }).stage;
    const scenes = (rewrittenJson as { scenes?: unknown }).scenes;
    if (!stage || typeof stage !== 'object' || !Array.isArray(scenes)) {
      return apiError(
        API_ERROR_CODES.INVALID_REQUEST,
        400,
        'sourceClassroomJson missing stage/scenes',
      );
    }

    const manifest = (rewrittenJson as { manifest?: unknown }).manifest;
    const sourceCreatedAt = (sourceClassroomJson as { createdAt?: unknown }).createdAt;
    const classroom = {
      id,
      stage: { ...(stage as Record<string, unknown>), id },
      scenes,
      createdAt: typeof sourceCreatedAt === 'string' ? sourceCreatedAt : existing.createdAt,
      ...(manifest && typeof manifest === 'object' ? { manifest } : {}),
    };

    await ensureClassroomsDir();
    await writeJsonFileAtomic(path.join(CLASSROOMS_DIR, `${id}.json`), classroom);

    return apiSuccess({ id, synced: true });
  } catch (error) {
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to sync classroom',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get('id');

    if (!id) {
      return apiError(
        API_ERROR_CODES.MISSING_REQUIRED_FIELD,
        400,
        'Missing required parameter: id',
      );
    }

    if (!isValidClassroomId(id)) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 400, 'Invalid classroom id');
    }

    const result = await deleteClassroom(id);
    return apiSuccess({ id, ...result });
  } catch (error) {
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to delete classroom',
      error instanceof Error ? error.message : String(error),
    );
  }
}
