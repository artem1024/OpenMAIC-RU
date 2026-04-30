import { promises as fs } from 'fs';
import path from 'path';
import type { NextRequest } from 'next/server';
import type { Scene, Stage } from '@/lib/types/stage';
import type { ClassroomManifest } from '@/lib/types/manifest';
import { fixSlideLayouts } from '@/lib/server/slide-layout-fix';

export const CLASSROOMS_DIR = path.join(process.cwd(), 'data', 'classrooms');
export const CLASSROOM_JOBS_DIR = path.join(process.cwd(), 'data', 'classroom-jobs');

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

export async function ensureClassroomsDir() {
  await ensureDir(CLASSROOMS_DIR);
}

export async function ensureClassroomJobsDir() {
  await ensureDir(CLASSROOM_JOBS_DIR);
}

export async function writeJsonFileAtomic(filePath: string, data: unknown) {
  const dir = path.dirname(filePath);
  await ensureDir(dir);

  const tempFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const content = JSON.stringify(data, null, 2);
  await fs.writeFile(tempFilePath, content, 'utf-8');
  await fs.rename(tempFilePath, filePath);
}

/**
 * Build the origin used to construct `pollUrl` / `classroomUrl` etc.
 *
 * See remediation-plan-v3 P1.9:
 *   - ALWAYS prefer `process.env.PUBLIC_BASE_URL` when set.
 *   - Never trust `x-forwarded-host` / `x-forwarded-proto` — they are attacker-controlled
 *     and cause host-header poisoning of persisted URLs.
 *   - Fall back to `req.nextUrl.origin` only in dev when PUBLIC_BASE_URL is unset.
 */
// DEPRECATED: old implementation trusted x-forwarded-host, see remediation-plan-v3 P1.9.
export function buildRequestOrigin(req: NextRequest): string {
  const configured = process.env.PUBLIC_BASE_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }
  return req.nextUrl.origin;
}

export interface PersistedClassroomData {
  id: string;
  stage: Stage;
  scenes: Scene[];
  createdAt: string;
  /**
   * Optional asset manifest describing media (image/video) and interactive
   * HTML versions. Absent on legacy classrooms generated before the manifest
   * layer; new generations and partial regens populate it. Readers MUST
   * tolerate `manifest === undefined` for backwards compatibility.
   */
  manifest?: ClassroomManifest;
}

export function isValidClassroomId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id);
}

export async function readClassroom(id: string): Promise<PersistedClassroomData | null> {
  const filePath = path.join(CLASSROOMS_DIR, `${id}.json`);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as PersistedClassroomData;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function persistClassroom(
  data: {
    id: string;
    stage: Stage;
    scenes: Scene[];
    manifest?: ClassroomManifest;
  },
  baseUrl: string,
): Promise<PersistedClassroomData & { url: string }> {
  // Auto-correct layout violations (offscreen cards, title-at-bottom, undersized
  // text boxes) before persistence. Mutates scenes in place.
  const layoutReports = fixSlideLayouts(data.scenes);
  if (layoutReports.length > 0) {
    const total = layoutReports.reduce((s, r) => s + r.changes, 0);
    console.log(
      `[persistClassroom ${data.id}] layout-fix applied ${total} changes across ${layoutReports.length} scenes`,
    );
    for (const r of layoutReports) {
      console.log(
        `  scene #${r.sceneIndex} "${r.sceneTitle.slice(0, 50)}": ${r.messages.join('; ')}`,
      );
    }
  }

  const classroomData: PersistedClassroomData = {
    id: data.id,
    stage: data.stage,
    scenes: data.scenes,
    createdAt: new Date().toISOString(),
    ...(data.manifest ? { manifest: data.manifest } : {}),
  };

  await ensureClassroomsDir();
  const filePath = path.join(CLASSROOMS_DIR, `${data.id}.json`);
  await writeJsonFileAtomic(filePath, classroomData);

  return {
    ...classroomData,
    url: `${baseUrl}/classroom/${data.id}`,
  };
}
