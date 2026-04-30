/**
 * GET /api/schema/classroom
 *
 * Exports the JSON Schema describing `PersistedClassroomData` (the on-disk
 * classroom shape: id, stage, scenes[], createdAt, optional manifest with
 * assets/interactiveSlides, scenes' actions[] including SpeechAction with
 * optional `tts` metadata).
 *
 * --- Contract surface ---
 * The response IS the contract between OpenMAIC (producer of classroom JSON)
 * and osvaivai (consumer that validates classroom JSON before publishing /
 * editing). osvaivai pins `schemaVersion: 1`; if this version changes
 * unexpectedly, osvaivai's contract test must fail and the migration must be
 * coordinated explicitly. Bumping `schemaVersion` is a breaking change — keep
 * it in sync with `MANIFEST_SCHEMA_VERSION` in `lib/types/manifest.ts`.
 *
 * Response body:
 *   {
 *     schemaVersion: number,           // currently 1, mirrors MANIFEST_SCHEMA_VERSION
 *     openmaicCommit: string,          // git HEAD or 'unknown'
 *     validationLevel: 'shape' | 'full',
 *     generatedAt: string,             // ISO timestamp of this response
 *     schema: object                   // the JSON Schema (draft-07)
 *   }
 *
 * --- Validation level: 'shape' (current) ---
 * The schema is generated at build/dev time with `typescript-json-schema` from
 * the TypeScript types in `lib/types/{stage,action,manifest,slides}.ts`. This
 * captures structural shape (required fields, types, unions) but NOT runtime
 * refinements (regex, min/max, custom validators). osvaivai treats the schema
 * as a structural gate; semantic validation (e.g. that audioId references an
 * existing AssetVersion) lives in osvaivai itself.
 *
 * If/when the full classroom shape is ported to Zod (right now only `manifest`
 * has Zod — see `lib/types/manifest.ts`), switch this endpoint to derive the
 * schema via `zod-to-json-schema` and bump `validationLevel` to `'full'`.
 *
 * --- Auth ---
 * Gated by the global `middleware.ts` `INTERNAL_ACCESS_KEY` check. When that
 * env var is set, callers MUST send `X-Internal-Key`. To expose the schema
 * publicly (e.g. for documentation), set `SCHEMA_PUBLIC=1`; the middleware has
 * a carve-out for this single route.
 *
 * --- Cache ---
 * `Cache-Control: public, max-age=300, stale-while-revalidate=86400` — the
 * schema is build-stable but rebuilds may change it; 5-minute fresh + 1-day
 * stale-while-revalidate balances freshness vs upstream load.
 *
 * --- Regenerating the schema file ---
 * The schema is checked into `lib/generated/classroom.schema.json`. To
 * regenerate after changing `lib/types/*`:
 *
 *     npx typescript-json-schema tsconfig.json PersistedClassroomData \
 *       --required --strictNullChecks --skipLibCheck --esModuleInterop \
 *       --ignoreErrors --include 'lib/**\/*.ts' --topRef --aliasRefs \
 *       --out lib/generated/classroom.schema.json
 *
 * Or via the npm script: `pnpm run schema:classroom`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { MANIFEST_SCHEMA_VERSION } from '@/lib/types/manifest';
import { apiError, API_ERROR_CODES } from '@/lib/server/api-response';

const SCHEMA_FILE_PATH = path.join(process.cwd(), 'lib', 'generated', 'classroom.schema.json');

/**
 * Resolved once at module load. Order:
 *   1. process.env.OPENMAIC_COMMIT   (set by Docker build / deploy script)
 *   2. process.env.GIT_COMMIT        (some CI conventions)
 *   3. `git rev-parse HEAD`          (works in dev / source checkouts)
 *   4. 'unknown'
 */
function resolveOpenmaicCommit(): string {
  const envCommit = process.env.OPENMAIC_COMMIT?.trim() || process.env.GIT_COMMIT?.trim();
  if (envCommit) return envCommit;
  try {
    const out = execSync('git rev-parse HEAD', {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.toString().trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

const OPENMAIC_COMMIT = resolveOpenmaicCommit();

/**
 * 'shape' — typescript-json-schema-derived (structure only).
 * 'full'  — zod-derived (structure + runtime refinements).
 */
const VALIDATION_LEVEL: 'shape' | 'full' = 'shape';

let cachedSchema: unknown | null = null;

async function loadSchema(): Promise<unknown> {
  if (cachedSchema !== null) return cachedSchema;
  const raw = await fs.readFile(SCHEMA_FILE_PATH, 'utf-8');
  cachedSchema = JSON.parse(raw);
  return cachedSchema;
}

export async function GET(_request: NextRequest) {
  try {
    const schema = await loadSchema();
    const body = {
      success: true as const,
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      openmaicCommit: OPENMAIC_COMMIT,
      validationLevel: VALIDATION_LEVEL,
      generatedAt: new Date().toISOString(),
      schema,
    };
    return NextResponse.json(body, {
      status: 200,
      headers: {
        'Cache-Control': 'public, max-age=300, stale-while-revalidate=86400',
      },
    });
  } catch (error) {
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to load classroom schema',
      error instanceof Error ? error.message : String(error),
    );
  }
}
