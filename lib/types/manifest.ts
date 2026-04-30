/**
 * Asset manifest types for classroom storage.
 *
 * The manifest describes media (image / video) and interactive HTML assets
 * attached to a classroom, including their version history. It enables:
 *   - Versioned media paths (`media/{elementId}/v{NNN}.{ext}`)
 *     instead of deterministic single-file names — required for rollback.
 *   - Recording per-version generation parameters (prompt, provider, model)
 *     for reproducibility / re-generation with the same params.
 *   - Cross-process consumers (osvaivai) reading metadata without re-deriving
 *     it from filesystem layout.
 *
 * The manifest is OPTIONAL on `PersistedClassroomData` — existing classrooms
 * predate this layer and do not have a manifest. New generations populate it;
 * editing flows (per-asset regen) read+update it.
 *
 * Zod schemas mirror the TypeScript interfaces and serve as the single source
 * of truth for downstream JSON Schema export (Wave 2). Keep TS interfaces and
 * Zod schemas in sync.
 */
import { z } from 'zod';

export const MANIFEST_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// AssetEntry: image / video element generated for a slide canvas
// ---------------------------------------------------------------------------

export const assetVersionRecordSchema = z.object({
  versionNo: z.number().int().min(1),
  /** Path relative to the classroom directory, e.g. `media/img_42/v003.png`. */
  path: z.string().min(1),
  promptUsed: z.string(),
  paramsUsed: z.record(z.string(), z.unknown()),
  generatedAt: z.string().min(1),
});
export type AssetVersionRecord = z.infer<typeof assetVersionRecordSchema>;

export const assetEntrySchema = z.object({
  kind: z.enum(['image', 'video']),
  elementId: z.string().min(1),
  sceneId: z.string().min(1),
  prompt: z.string(),
  provider: z.string(),
  model: z.string(),
  params: z.record(z.string(), z.unknown()),
  currentVersion: z.number().int().min(0),
  versions: z.array(assetVersionRecordSchema),
});
export type AssetEntry = z.infer<typeof assetEntrySchema>;

// ---------------------------------------------------------------------------
// InteractiveSlideEntry: LLM-generated HTML for an interactive slide
// ---------------------------------------------------------------------------

export const interactiveSlideVersionSchema = z.object({
  versionNo: z.number().int().min(1),
  htmlPath: z.string().min(1),
  prompt: z.string(),
  generatedAt: z.string().min(1),
});
export type InteractiveSlideVersion = z.infer<typeof interactiveSlideVersionSchema>;

export const interactiveSlideEntrySchema = z.object({
  sceneId: z.string().min(1),
  prompt: z.string(),
  model: z.string(),
  currentVersion: z.number().int().min(0),
  versions: z.array(interactiveSlideVersionSchema),
});
export type InteractiveSlideEntry = z.infer<typeof interactiveSlideEntrySchema>;

// ---------------------------------------------------------------------------
// ClassroomManifest: top-level container persisted alongside scenes
// ---------------------------------------------------------------------------

export const classroomManifestSchema = z.object({
  schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
  /** Keyed by elementId. */
  assets: z.record(z.string(), assetEntrySchema),
  /** Keyed by sceneId. Optional — only present for classrooms with interactive scenes. */
  interactiveSlides: z.record(z.string(), interactiveSlideEntrySchema).optional(),
});
export type ClassroomManifest = z.infer<typeof classroomManifestSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a version number as `vNNN` (zero-padded to 3 digits). */
export function formatVersionTag(versionNo: number): string {
  return `v${String(versionNo).padStart(3, '0')}`;
}

/** Build an empty manifest (used on first regen for legacy classrooms). */
export function createEmptyManifest(): ClassroomManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    assets: {},
  };
}
