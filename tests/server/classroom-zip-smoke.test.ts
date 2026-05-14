// tests/server/classroom-zip-smoke.test.ts
//
// Smoke test: verify that exporting a 56-MB-shaped classroom completes well
// within a reasonable budget. This is a sanity check on the deflate pipeline
// for the largest in-prod classrooms today.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let originalCwd: string;
let tmpDir: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'maic-smoke-'));
  await fs.mkdir(path.join(tmpDir, 'data', 'classrooms'), { recursive: true });
  process.chdir(tmpDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
});

describe('classroom-zip: smoke', () => {
  it('exports a ~56 MB classroom within 30s', { timeout: 60_000 }, async () => {
    const id = 'smoke-56mb';
    const big = Buffer.alloc(4 * 1024 * 1024, 0x42); // 4 MB chunk
    const classroom = {
      id,
      stage: { id, name: 'Smoke 56MB', agents: [] },
      scenes: [
        {
          id: 's1',
          type: 'slide' as const,
          title: 'S',
          actions: [],
          whiteboards: [],
          content: {
            slide: { id: 'sl', type: 'content', elements: [] },
          },
        },
      ],
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(
      path.join(process.cwd(), 'data', 'classrooms', `${id}.json`),
      JSON.stringify(classroom, null, 2),
    );
    for (let i = 0; i < 14; i++) {
      const dir = path.join(process.cwd(), 'data', 'classrooms', id, 'audio', `sp_${i}`);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'v001.mp3'), big);
    }

    const { exportClassroomToZip } = await import('@/lib/server/classroom-zip');
    const t0 = Date.now();
    const r = await exportClassroomToZip(id);
    const ms = Date.now() - t0;

    expect(r.meta.fileCount).toBe(14);
    expect(r.meta.totalBytes).toBe(14 * 4 * 1024 * 1024);
    // Highly compressible 0x42 buffer → tiny zip; just sanity-check it ran.
    expect(r.buffer.length).toBeGreaterThan(0);
    // Generous budget; mainly to catch O(n^2) regressions.
    expect(ms).toBeLessThan(30_000);
    // eslint-disable-next-line no-console
    console.log(`[smoke] export 56 MB classroom: ${ms}ms, zip=${r.buffer.length} bytes`);
  });
});
