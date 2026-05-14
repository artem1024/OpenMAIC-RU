// tests/server/classroom-zip.test.ts
//
// Round-trip + safety tests for the server-side ZIP export/import path
// (Phase 6 / upstream #17, RU adaptation).
//
// We monkey-patch CLASSROOMS_DIR via process.cwd → temp dir so the persistence
// layer writes/reads from an ephemeral location for each test. Tests do NOT
// depend on the dev server, ai-gateway, or any external network.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import JSZip from 'jszip';

// We have to set the process.cwd-derived constants BEFORE the modules under
// test are loaded, because they capture `path.join(process.cwd(), 'data', ...)`
// at import time. We use a per-test tmp dir and a `vi.resetModules()` between
// runs to re-evaluate `lib/server/classroom-storage`.

let originalCwd: string;
let tmpDir: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'maic-zip-test-'));
  await fs.mkdir(path.join(tmpDir, 'data', 'classrooms'), { recursive: true });
  process.chdir(tmpDir);
  vi.resetModules();
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  vi.unstubAllEnvs();
});

interface MinimalClassroomFixture {
  id: string;
  jsonBytes: Buffer;
  files: Array<{ rel: string; content: Buffer }>;
}

function buildFixture(id: string): MinimalClassroomFixture {
  const classroom = {
    id,
    stage: {
      id,
      name: 'Тестовый урок',
      description: 'roundtrip',
      agents: [
        {
          id: 'teacher_main',
          name: 'Анна',
          role: 'teacher',
          persona: 'тёплый дружелюбный учитель',
          avatar: 'A',
          color: '#3cc68a',
          priority: 1,
        },
      ],
    },
    scenes: [
      {
        id: 'scene_1',
        type: 'slide',
        title: 'Сцена 1',
        actions: [
          {
            id: 'sp_1',
            type: 'speech',
            text: 'Здравствуйте',
            audioId: undefined,
            audioUrl: `/api/classroom-media/${id}/audio/sp_1/v001.mp3`,
          },
        ],
        whiteboards: [],
        content: {
          slide: {
            id: 'slide_1',
            type: 'content',
            elements: [
              {
                id: 'img_42',
                type: 'image',
                src: `/api/classroom-media/${id}/media/img_42/v001.png`,
              },
            ],
          },
        },
      },
    ],
    createdAt: new Date().toISOString(),
    manifest: {
      schemaVersion: 1 as const,
      assets: {
        img_42: {
          kind: 'image' as const,
          elementId: 'img_42',
          sceneId: 'scene_1',
          prompt: 'a simple test image',
          provider: 'test',
          model: 'test-model',
          params: {},
          currentVersion: 1,
          versions: [
            {
              versionNo: 1,
              path: 'media/img_42/v001.png',
              promptUsed: 'a simple test image',
              paramsUsed: {},
              generatedAt: new Date().toISOString(),
            },
          ],
        },
      },
      interactiveSlides: {},
    },
  };
  return {
    id,
    jsonBytes: Buffer.from(JSON.stringify(classroom, null, 2), 'utf-8'),
    files: [
      // PNG header bytes (just enough to look real); content immaterial for round-trip.
      {
        rel: 'media/img_42/v001.png',
        content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde, 0xad]),
      },
      {
        rel: 'audio/sp_1/v001.mp3',
        content: Buffer.from('fake-mp3-bytes-for-round-trip-test'),
      },
    ],
  };
}

async function plantFixture(fix: MinimalClassroomFixture): Promise<void> {
  const dataDir = path.join(process.cwd(), 'data', 'classrooms');
  await fs.writeFile(path.join(dataDir, `${fix.id}.json`), fix.jsonBytes);
  for (const f of fix.files) {
    const abs = path.join(dataDir, fix.id, f.rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, f.content);
  }
}

describe('classroom-zip: export', () => {
  it('produces a valid ZIP with classroom.json + meta.json + media tree', async () => {
    const fix = buildFixture('test-export-1');
    await plantFixture(fix);

    const { exportClassroomToZip } = await import('@/lib/server/classroom-zip');
    const result = await exportClassroomToZip(fix.id);

    expect(result.buffer.length).toBeGreaterThan(0);
    expect(result.filename).toBe(`${fix.id}.maic.zip`);
    expect(result.meta.formatVersion).toBe(1);
    expect(result.meta.fork).toBe('osvaivai-ru');
    expect(result.meta.sourceClassroomId).toBe(fix.id);
    expect(result.meta.fileCount).toBe(2);
    expect(result.meta.totalBytes).toBe(
      fix.files.reduce((s, f) => s + f.content.length, 0),
    );
    expect(result.meta.integrity.algo).toBe('sha256');
    expect(result.meta.integrity.classroomJsonSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.meta.integrity.mediaIndexSha256).toMatch(/^[a-f0-9]{64}$/);

    const z = await JSZip.loadAsync(result.buffer);
    expect(z.file('classroom.json')).toBeTruthy();
    expect(z.file('meta.json')).toBeTruthy();
    expect(z.file('media/img_42/v001.png')).toBeTruthy();
    expect(z.file('audio/sp_1/v001.mp3')).toBeTruthy();
  });

  it('rejects an unknown classroom id', async () => {
    const { exportClassroomToZip } = await import('@/lib/server/classroom-zip');
    await expect(exportClassroomToZip('does-not-exist')).rejects.toThrow(/not found/i);
  });

  it('rejects a malformed classroom id', async () => {
    const { exportClassroomToZip } = await import('@/lib/server/classroom-zip');
    await expect(exportClassroomToZip('../../etc')).rejects.toThrow(/invalid/i);
  });
});

describe('classroom-zip: import (feature flag)', () => {
  it('refuses when ZIP_IMPORT_ENABLED is unset', async () => {
    const { importClassroomFromZip } = await import('@/lib/server/classroom-zip');
    await expect(importClassroomFromZip(Buffer.from([1, 2, 3]), { baseUrl: 'http://x' })).rejects.toThrow(
      /disabled/,
    );
  });
});

describe('classroom-zip: round-trip', () => {
  it('export → import lands a NEW classroom with -imported- suffix and identical media', async () => {
    vi.stubEnv('ZIP_IMPORT_ENABLED', 'true');

    const fix = buildFixture('roundtrip-classroom-a');
    await plantFixture(fix);

    const { exportClassroomToZip, importClassroomFromZip } = await import(
      '@/lib/server/classroom-zip'
    );
    const exported = await exportClassroomToZip(fix.id);

    const result = await importClassroomFromZip(exported.buffer, {
      baseUrl: 'http://localhost:3000',
    });

    expect(result.sourceClassroomId).toBe(fix.id);
    expect(result.classroomId).not.toBe(fix.id);
    expect(result.classroomId).toMatch(/-imported-\d{14}-[A-Za-z0-9_-]{6}$/);
    expect(result.fileCount).toBe(2);

    // Original classroom must be untouched.
    const origJson = await fs.readFile(
      path.join(process.cwd(), 'data', 'classrooms', `${fix.id}.json`),
      'utf-8',
    );
    expect(JSON.parse(origJson).id).toBe(fix.id);

    // New classroom JSON exists with rewritten id and serving-URL prefix.
    const newJsonPath = path.join(
      process.cwd(),
      'data',
      'classrooms',
      `${result.classroomId}.json`,
    );
    const newJson = JSON.parse(await fs.readFile(newJsonPath, 'utf-8'));
    expect(newJson.id).toBe(result.classroomId);
    expect(newJson.stage.id).toBe(result.classroomId);

    // No leftover references to the source id in serving URLs.
    const newJsonText = await fs.readFile(newJsonPath, 'utf-8');
    expect(newJsonText).not.toContain(`/api/classroom-media/${fix.id}/`);
    expect(newJsonText).toContain(`/api/classroom-media/${result.classroomId}/`);

    // Manifest history preserved (versions array intact, full asset entry).
    expect(newJson.manifest).toBeTruthy();
    expect(newJson.manifest.assets.img_42.versions).toHaveLength(1);
    expect(newJson.manifest.assets.img_42.versions[0].path).toBe('media/img_42/v001.png');

    // Media files mirrored byte-for-byte.
    for (const f of fix.files) {
      const mirrored = await fs.readFile(
        path.join(process.cwd(), 'data', 'classrooms', result.classroomId, f.rel),
      );
      expect(mirrored.equals(f.content)).toBe(true);
    }
  });

  it('rejects a zip with path-escape entry', async () => {
    vi.stubEnv('ZIP_IMPORT_ENABLED', 'true');
    const z = new JSZip();
    z.file(
      'classroom.json',
      JSON.stringify({ id: 'x', stage: {}, scenes: [], createdAt: 'now' }),
    );
    z.file(
      'meta.json',
      JSON.stringify({
        formatVersion: 1,
        exportedAt: 'now',
        appVersion: 't',
        sourceClassroomId: 'x',
        integrity: { algo: 'sha256', classroomJsonSha256: '', mediaIndexSha256: '' },
        fileCount: 0,
        totalBytes: 0,
      }),
    );
    z.file('../etc/passwd', 'x');
    const buf = await z.generateAsync({ type: 'nodebuffer' });

    const { importClassroomFromZip } = await import('@/lib/server/classroom-zip');
    await expect(importClassroomFromZip(buf, { baseUrl: 'http://x' })).rejects.toThrow(
      /unsafe|not in allowed/,
    );
  });

  it('rejects a zip whose total bytes exceed ZIP_IMPORT_MAX_BYTES', async () => {
    vi.stubEnv('ZIP_IMPORT_ENABLED', 'true');
    vi.stubEnv('ZIP_IMPORT_MAX_BYTES', '1024');
    const z = new JSZip();
    z.file(
      'classroom.json',
      JSON.stringify({ id: 'x', stage: {}, scenes: [], createdAt: 'now' }),
    );
    z.file(
      'meta.json',
      JSON.stringify({
        formatVersion: 1,
        exportedAt: 'now',
        appVersion: 't',
        sourceClassroomId: 'x',
        integrity: { algo: 'sha256', classroomJsonSha256: '', mediaIndexSha256: '' },
        fileCount: 0,
        totalBytes: 0,
      }),
    );
    z.file('media/big.bin', Buffer.alloc(2048));
    const buf = await z.generateAsync({ type: 'nodebuffer' });

    const { importClassroomFromZip } = await import('@/lib/server/classroom-zip');
    await expect(importClassroomFromZip(buf, { baseUrl: 'http://x' })).rejects.toThrow(
      /exceeds|per-file/,
    );
  });
});
