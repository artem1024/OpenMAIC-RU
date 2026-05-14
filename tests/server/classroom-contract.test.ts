import { promises as fs } from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DELETE, PUT } from '@/app/api/classroom/route';
import { middleware } from '@/middleware';

const mediaMocks = vi.hoisted(() => ({
  createClassroomManifest: vi.fn(),
  findCanvasElement: vi.fn(),
  generateTTSForClassroom: vi.fn(),
  regenerateAssetElement: vi.fn(),
  regenerateInteractiveSlide: vi.fn(),
}));

const llmMocks = vi.hoisted(() => ({
  callLLM: vi.fn(),
}));

const modelMocks = vi.hoisted(() => ({
  resolveModel: vi.fn(),
}));

vi.mock('@/lib/server/classroom-media-generation', () => mediaMocks);
vi.mock('@/lib/ai/llm', () => llmMocks);
vi.mock('@/lib/server/resolve-model', () => modelMocks);

const classroomIds = new Set<string>();

function testId(prefix: string): string {
  const id = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  classroomIds.add(id);
  return id;
}

function classroomJsonPath(id: string): string {
  return path.join(process.cwd(), 'data', 'classrooms', `${id}.json`);
}

function classroomDirPath(id: string): string {
  return path.join(process.cwd(), 'data', 'classrooms', id);
}

async function seedClassroom(id: string, overrides: Record<string, unknown> = {}) {
  await fs.mkdir(path.dirname(classroomJsonPath(id)), { recursive: true });
  await fs.writeFile(
    classroomJsonPath(id),
    JSON.stringify({
      id,
      stage: { id },
      scenes: [],
      createdAt: '2026-05-02T00:00:00.000Z',
      ...overrides,
    }),
    'utf-8',
  );
}

afterEach(async () => {
  vi.resetAllMocks();
  vi.resetModules();
  vi.unstubAllEnvs();
  await Promise.all(
    [...classroomIds].map(async (id) => {
      await fs.rm(classroomJsonPath(id), { force: true });
      await fs.rm(classroomDirPath(id), { recursive: true, force: true });
    }),
  );
  classroomIds.clear();
});

describe('OpenMAIC classroom internal contract', () => {
  it('DELETE /api/classroom?id=... is idempotent', async () => {
    const id = testId('delete_contract');
    await seedClassroom(id);
    await fs.mkdir(path.join(classroomDirPath(id), 'media'), { recursive: true });
    await fs.writeFile(path.join(classroomDirPath(id), 'media', 'asset.txt'), 'asset');

    const first = await DELETE(
      new NextRequest(`http://localhost/api/classroom?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    );
    expect(first.status).toBe(200);
    await expect(fs.access(classroomJsonPath(id))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(classroomDirPath(id))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await first.json()).toMatchObject({ success: true, id, deleted: true });

    const second = await DELETE(
      new NextRequest(`http://localhost/api/classroom?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ success: true, id, deleted: false });
  });

  it('PUT /api/classroom?id=... syncs sourceClassroomJson into scratch JSON', async () => {
    const id = testId('sync_contract');
    await seedClassroom(id);

    const response = await PUT(
      new NextRequest(`http://localhost/api/classroom?id=${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sourceClassroomJson: {
            id: 'source_id',
            stage: { id: 'source_id', title: 'Draft source' },
            scenes: [
              {
                id: 'scene_1',
                actions: [
                  {
                    id: 'speech_1',
                    type: 'speech',
                    audioUrl: 'asset://audio/speech_1/v001.mp3',
                  },
                ],
              },
            ],
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, id, synced: true });

    const stored = JSON.parse(await fs.readFile(classroomJsonPath(id), 'utf-8'));
    expect(stored.id).toBe(id);
    expect(stored.stage.id).toBe(id);
    expect(stored.scenes[0].actions[0].audioUrl).toBe(
      `/api/classroom-media/${id}/audio/speech_1/v001.mp3`,
    );
  });

  it('middleware requires X-Internal-Key for /api/classroom when configured', () => {
    vi.stubEnv('INTERNAL_ACCESS_KEY', 'test-secret');

    const denied = middleware(
      new NextRequest('http://localhost/api/classroom?id=abc', { method: 'DELETE' }),
    );
    expect(denied.status).toBe(403);

    const allowed = middleware(
      new NextRequest('http://localhost/api/classroom?id=abc', {
        method: 'DELETE',
        headers: { 'X-Internal-Key': 'test-secret' },
      }),
    );
    expect(allowed.status).toBe(200);
  });

  it('POST /api/classroom/[id]/regenerate-tts returns content address fields', async () => {
    const id = testId('tts_contract');
    const classroom = {
      id,
      stage: { id },
      scenes: [{ id: 'scene_1', actions: [{ id: 'speech_1', type: 'speech', text: 'Hello' }] }],
    };
    await seedClassroom(id, classroom);
    vi.resetModules();
    mediaMocks.generateTTSForClassroom.mockResolvedValue({
      count: 1,
      providerId: 'mock-tts',
      regenerated: [
        {
          actionId: 'speech_1',
          versionNo: 3,
          audioUrl: `/api/classroom-media/${id}/audio/speech_1/v003.mp3`,
          textHash: 'text-hash',
          relativePath: 'audio/speech_1/v003.mp3',
          sha256: 'a'.repeat(64),
          contentType: 'audio/mpeg',
        },
      ],
      skipped: [],
    });

    const { POST } = await import('@/app/api/classroom/[id]/regenerate-tts/route');
    const response = await POST(
      new NextRequest(`http://localhost/api/classroom/${id}/regenerate-tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actionIds: ['speech_1'], force: true }),
      }),
      { params: Promise.resolve({ id }) },
    );

    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({
      success: true,
      id,
      count: 1,
      regenerated: [
        {
          actionId: 'speech_1',
          relativePath: 'audio/speech_1/v003.mp3',
          sha256: 'a'.repeat(64),
          contentType: 'audio/mpeg',
        },
      ],
    });
  });

  it.each([
    {
      kind: 'image' as const,
      relativePath: 'media/asset_1/v002.png',
      contentType: 'image/png',
      src: '/api/classroom-media/asset_contract/media/asset_1/v002.png',
    },
    {
      kind: 'video' as const,
      relativePath: 'media/asset_1/v002.mp4',
      contentType: 'video/mp4',
      src: '/api/classroom-media/asset_contract/media/asset_1/v002.mp4',
    },
  ])(
    'POST /api/classroom/[id]/regenerate-asset returns content address fields for $kind',
    async ({ kind, relativePath, contentType, src }) => {
      const id = testId('asset_contract');
      const classroom = {
        id,
        stage: { id },
        scenes: [
          {
            id: 'scene_1',
            type: 'slide',
            content: { canvas: { elements: [{ id: 'asset_1', type: kind }] } },
          },
        ],
      };
      await seedClassroom(id, classroom);
      vi.resetModules();
      mediaMocks.createClassroomManifest.mockReturnValue({ schemaVersion: 1, assets: {} });
      mediaMocks.findCanvasElement.mockReturnValue({
        scene: classroom.scenes[0],
        element: { id: 'asset_1', type: kind },
      });
      mediaMocks.regenerateAssetElement.mockResolvedValue({
        elementId: 'asset_1',
        kind,
        versionNo: 2,
        src,
        prompt: 'Regenerate this asset',
        relativePath,
        sha256: 'b'.repeat(64),
        contentType,
        provider: 'mock-provider',
        model: 'mock-model',
      });

      const { POST } = await import('@/app/api/classroom/[id]/regenerate-asset/route');
      const response = await POST(
        new NextRequest(`http://localhost/api/classroom/${id}/regenerate-asset`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ elementId: 'asset_1', prompt: 'Regenerate this asset' }),
        }),
        { params: Promise.resolve({ id }) },
      );

      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(body).toMatchObject({
        success: true,
        id,
        elementId: 'asset_1',
        kind,
        relativePath,
        sha256: 'b'.repeat(64),
        contentType,
      });
    },
  );

  it('POST /api/classroom/[id]/regenerate-interactive returns content address fields', async () => {
    const id = testId('interactive_contract');
    const classroom = {
      id,
      stage: { id },
      scenes: [
        {
          id: 'interactive_1',
          type: 'interactive',
          title: 'Interactive scene',
          content: { type: 'interactive', html: '<html></html>' },
        },
      ],
    };
    await seedClassroom(id, classroom);
    vi.resetModules();
    mediaMocks.createClassroomManifest.mockReturnValue({
      schemaVersion: 1,
      assets: {},
      interactiveSlides: {},
    });
    mediaMocks.regenerateInteractiveSlide.mockResolvedValue({
      sceneId: 'interactive_1',
      versionNo: 4,
      htmlPath: 'interactive/interactive_1/v004.html',
      relativePath: 'interactive/interactive_1/v004.html',
      sha256: 'c'.repeat(64),
      contentType: 'text/html',
      html: '<!DOCTYPE html><html><body>Updated</body></html>',
    });
    modelMocks.resolveModel.mockReturnValue({
      model: 'mock-language-model',
      modelInfo: { outputWindow: 4096 },
      modelString: 'mock-model',
    });

    const { POST } = await import('@/app/api/classroom/[id]/regenerate-interactive/route');
    const response = await POST(
      new NextRequest(`http://localhost/api/classroom/${id}/regenerate-interactive`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sceneId: 'interactive_1', prompt: 'Make it interactive' }),
      }),
      { params: Promise.resolve({ id }) },
    );

    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({
      success: true,
      id,
      sceneId: 'interactive_1',
      htmlPath: 'interactive/interactive_1/v004.html',
      relativePath: 'interactive/interactive_1/v004.html',
      sha256: 'c'.repeat(64),
      contentType: 'text/html',
    });
  });
});
