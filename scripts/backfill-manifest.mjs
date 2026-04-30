#!/usr/bin/env node
// @ts-check
/**
 * scripts/backfill-manifest.mjs — Wave 2 / Task C of lesson-editor plan.
 *
 * Adds an `asset manifest` and per-SpeechAction `tts` metadata to classrooms
 * that were generated before Wave 1B introduced these structures (commit
 * e792de2). New classrooms generated after that commit already have manifest +
 * tts populated and are skipped (idempotent).
 *
 * Side effect: legacy file paths are migrated to the versioned layout used by
 * Wave 1B and beyond:
 *   - `media/{elementId}.{ext}`        →  `media/{elementId}/v001.{ext}`
 *   - `audio/tts_{actionId}.{format}`  →  `audio/{actionId}/v001.{format}`
 * This is done by **copy-then-delete**, not atomic rename. A crash mid-run
 * leaves the legacy file in place; rerunning is safe.
 *
 * For legacy assets, `prompt`, `provider` and `model` are intentionally
 * recorded as `unknown-legacy` / empty — there is no way to recover the
 * original generation parameters from disk. This is documented in plan §10
 * question 3 and is acceptable for the editor's per-asset history (the v001
 * row anchors the version chain; later regens carry full metadata).
 *
 * USAGE
 *   # Dry-run, no writes:
 *   docker exec openmaic node scripts/backfill-manifest.mjs --dry-run
 *
 *   # Single classroom:
 *   docker exec openmaic node scripts/backfill-manifest.mjs --id=<classroomId>
 *
 *   # Cautious rollout — process the first N classrooms:
 *   docker exec openmaic node scripts/backfill-manifest.mjs --limit=5
 *
 *   # Live run, all classrooms:
 *   docker exec openmaic node scripts/backfill-manifest.mjs
 *
 * EXIT CODES
 *   0  — script completed (per-classroom warnings included in summary)
 *   1  — script-level failure (data dir missing, unreadable, etc.)
 *
 * IDEMPOTENCY
 *   A classroom whose JSON already has `manifest.schemaVersion === 1` is
 *   logged as "skip:already-backfilled" and not touched. Re-running this
 *   script over a fully backfilled corpus is a no-op.
 *
 * LOCATION DEPARTURE FROM PLAN
 *   Plan §2.6 specifies `osvaivai/backend/scripts/backfill_manifest.py`. The
 *   script needs read+write access to OpenMAIC's `data/classrooms/` tree,
 *   which lives inside the OpenMAIC container. Running from osvaivai requires
 *   either (a) a shared volume (cross-container coupling, brittle) or (b)
 *   adding HTTP endpoints in OpenMAIC just to drive the migration. Both
 *   options are worse than placing the script inside OpenMAIC and reusing the
 *   existing on-disk classroom layout helpers. Hence `.mjs` here.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants — kept aligned with lib/server/classroom-storage.ts and
// lib/types/manifest.ts. These small duplications are intentional: the script
// is a plain `.mjs` so it can run via `node` without a TS compile step. If
// the canonical sources change, update these in lockstep (see the git log on
// the referenced files).
// ---------------------------------------------------------------------------

const MANIFEST_SCHEMA_VERSION = 1;
const TTS_SCHEMA_VERSION = 1;
const LEGACY_PROVIDER = 'unknown-legacy';
const LEGACY_MODEL = 'unknown-legacy';
const LEGACY_VOICE = 'unknown';
const LEGACY_CONFIG_VERSION = 'legacy';
const LEGACY_FORMAT_DEFAULT = 'mp3';

/** Classroom data root. Mirrors `CLASSROOMS_DIR` in classroom-storage.ts. */
const CLASSROOMS_DIR = path.join(process.cwd(), 'data', 'classrooms');

/** Format a version number as `vNNN` — same rule as `formatVersionTag`. */
function formatVersionTag(versionNo) {
  return `v${String(versionNo).padStart(3, '0')}`;
}

/**
 * Normalize speech text for hashing: trim, collapse whitespace, lowercase.
 * Mirrors `normalizeTextForHash` in classroom-media-generation.ts. This is a
 * wire contract — osvaivai computes the same hash. Do not drift.
 */
function normalizeTextForHash(text) {
  return text.trim().replace(/\s+/gu, ' ').toLowerCase();
}

/** sha256 of normalized text. Mirrors `computeTextHash` in media generation. */
function computeTextHash(text) {
  return createHash('sha256').update(normalizeTextForHash(text), 'utf-8').digest('hex');
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    id: /** @type {string | null} */ (null),
    limit: /** @type {number | null} */ (null),
    help: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--id=')) opts.id = arg.slice('--id='.length).trim() || null;
    else if (arg.startsWith('--limit=')) {
      const n = Number.parseInt(arg.slice('--limit='.length), 10);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`Invalid --limit value: ${arg}`);
      }
      opts.limit = n;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return opts;
}

function printHelpAndExit() {
  console.log(
    `Usage: node scripts/backfill-manifest.mjs [options]\n\n` +
      `Options:\n` +
      `  --dry-run        Read all classrooms, log planned changes, do not write.\n` +
      `  --id=<id>        Process only the given classroom id.\n` +
      `  --limit=N        Process at most N classrooms (after id filter).\n` +
      `  --help, -h       Show this help.\n`,
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

async function pathExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    throw err;
  }
}

async function fileMtimeIso(p) {
  try {
    const st = await fs.stat(p);
    return st.mtime.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/**
 * Copy `src` to `dst`, then delete `src`. Crash-safe in the sense that the
 * legacy file remains on disk until the new file is fully written. Same-FS
 * `fs.rename` would be atomic but loses the safety net on partial writes.
 */
async function safeMigrateFile(src, dst) {
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.copyFile(src, dst);
  await fs.unlink(src);
}

async function listClassroomIds() {
  let entries;
  try {
    entries = await fs.readdir(CLASSROOMS_DIR, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new Error(`Classrooms directory not found: ${CLASSROOMS_DIR}`);
    }
    throw err;
  }
  /** @type {string[]} */
  const ids = [];
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.json')) {
      ids.push(e.name.slice(0, -'.json'.length));
    }
  }
  ids.sort();
  return ids;
}

async function readClassroom(id) {
  const filePath = path.join(CLASSROOMS_DIR, `${id}.json`);
  const content = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(content);
}

async function writeClassroomAtomic(id, data) {
  const filePath = path.join(CLASSROOMS_DIR, `${id}.json`);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  await fs.rename(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Asset / TTS helpers
// ---------------------------------------------------------------------------

/**
 * Walk every slide-canvas image/video element in a classroom. Yields
 * `{ scene, element }` for each candidate (those with a string `src`).
 */
function* iterMediaElements(classroom) {
  for (const scene of classroom.scenes ?? []) {
    if (scene.type !== 'slide') continue;
    const elements = scene?.content?.canvas?.elements;
    if (!Array.isArray(elements)) continue;
    for (const element of elements) {
      if (!element || typeof element !== 'object') continue;
      if (element.type !== 'image' && element.type !== 'video') continue;
      if (typeof element.src !== 'string') continue;
      yield { scene, element };
    }
  }
}

/** Iterate every speech action across all scenes. */
function* iterSpeechActions(classroom) {
  for (const scene of classroom.scenes ?? []) {
    if (!Array.isArray(scene?.actions)) continue;
    for (const action of scene.actions) {
      if (action?.type === 'speech' && typeof action.id === 'string') {
        yield { scene, action };
      }
    }
  }
}

/**
 * Resolve a media `src` URL against the classroom's `media/` directory.
 * Returns `{ kind, relInsideMediaDir, ext }` or `null` if the URL doesn't
 * point at this classroom's media.
 *
 * Recognized layouts:
 *   /api/classroom-media/{id}/media/{elementId}.{ext}            (legacy)
 *   /api/classroom-media/{id}/media/{elementId}/v{NNN}.{ext}     (versioned)
 */
function classifyMediaSrc(src, classroomId, elementId) {
  const prefix = `/api/classroom-media/${classroomId}/media/`;
  if (!src.startsWith(prefix)) return null;
  const rel = src.slice(prefix.length); // e.g. "img_1.png" or "img_1/v001.png"
  const segments = rel.split('/');
  if (segments.length === 1) {
    // Legacy flat: {filename}
    const filename = segments[0];
    const ext = path.extname(filename).slice(1) || 'bin';
    return { layout: 'legacy', rel, ext };
  }
  if (segments.length === 2 && segments[0] === elementId && /^v\d{3}\./.test(segments[1])) {
    // Versioned: {elementId}/v{NNN}.{ext}
    const ext = path.extname(segments[1]).slice(1) || 'bin';
    return { layout: 'versioned', rel, ext };
  }
  // Unknown layout (e.g. relative folder mismatch). Treat as opaque legacy
  // file under media/.
  const ext = path.extname(rel).slice(1) || 'bin';
  return { layout: 'legacy', rel, ext };
}

/**
 * Resolve an `audioUrl` against the classroom's `audio/` directory.
 * Recognized layouts:
 *   /api/classroom-media/{id}/audio/tts_{actionId}.{format}       (legacy)
 *   /api/classroom-media/{id}/audio/{actionId}/v{NNN}.{format}    (versioned)
 */
function classifyAudioUrl(audioUrl, classroomId, actionId) {
  const prefix = `/api/classroom-media/${classroomId}/audio/`;
  if (!audioUrl.startsWith(prefix)) return null;
  const rel = audioUrl.slice(prefix.length);
  const segments = rel.split('/');
  if (segments.length === 1) {
    const filename = segments[0];
    const format = path.extname(filename).slice(1) || LEGACY_FORMAT_DEFAULT;
    return { layout: 'legacy', rel, format };
  }
  if (segments.length === 2 && segments[0] === actionId && /^v\d{3}\./.test(segments[1])) {
    const format = path.extname(segments[1]).slice(1) || LEGACY_FORMAT_DEFAULT;
    return { layout: 'versioned', rel, format };
  }
  const format = path.extname(rel).slice(1) || LEGACY_FORMAT_DEFAULT;
  return { layout: 'legacy', rel, format };
}

// ---------------------------------------------------------------------------
// Per-classroom backfill
// ---------------------------------------------------------------------------

/**
 * @param {string} classroomId
 * @param {{ dryRun: boolean }} opts
 * @returns {Promise<{
 *   action: 'skip' | 'backfilled' | 'no-op',
 *   reason?: string,
 *   counts: { assets: number; tts: number; interactive: number; warnings: number },
 * }>}
 */
async function backfillClassroom(classroomId, opts) {
  const counts = { assets: 0, tts: 0, interactive: 0, warnings: 0 };

  /** @type {any} */
  let classroom;
  try {
    classroom = await readClassroom(classroomId);
  } catch (err) {
    log({ id: classroomId, action: 'error', stage: 'read', error: String(err?.message ?? err) });
    counts.warnings += 1;
    return { action: 'no-op', reason: 'unreadable', counts };
  }

  if (classroom?.manifest?.schemaVersion === MANIFEST_SCHEMA_VERSION) {
    log({ id: classroomId, action: 'skip', reason: 'already-backfilled' });
    return { action: 'skip', reason: 'already-backfilled', counts };
  }

  const mediaDir = path.join(CLASSROOMS_DIR, classroomId, 'media');
  const audioDir = path.join(CLASSROOMS_DIR, classroomId, 'audio');

  /** @type {Record<string, any>} */
  const assets = {};

  // ---- Pass 1: media (image/video) elements ----
  for (const { scene, element } of iterMediaElements(classroom)) {
    const elementId = typeof element.id === 'string' ? element.id : null;
    if (!elementId) {
      log({
        id: classroomId,
        action: 'warn',
        stage: 'media',
        reason: 'element-without-id',
        sceneId: scene.id,
      });
      counts.warnings += 1;
      continue;
    }

    const classified = classifyMediaSrc(element.src, classroomId, elementId);
    if (!classified) {
      log({
        id: classroomId,
        action: 'warn',
        stage: 'media',
        reason: 'src-not-recognized',
        elementId,
        src: element.src,
      });
      counts.warnings += 1;
      continue;
    }

    let versionedRel; // path inside media/, e.g. "img_1/v001.png"
    let absVersionedPath;
    let mtimeSourcePath;

    if (classified.layout === 'versioned') {
      versionedRel = classified.rel;
      absVersionedPath = path.join(mediaDir, versionedRel);
      mtimeSourcePath = absVersionedPath;
      if (!(await pathExists(absVersionedPath))) {
        log({
          id: classroomId,
          action: 'warn',
          stage: 'media',
          reason: 'versioned-file-missing',
          elementId,
          path: versionedRel,
        });
        counts.warnings += 1;
        continue;
      }
    } else {
      // Legacy flat layout — migrate to media/{elementId}/v001.{ext}
      const legacyAbs = path.join(mediaDir, classified.rel);
      if (!(await pathExists(legacyAbs))) {
        log({
          id: classroomId,
          action: 'warn',
          stage: 'media',
          reason: 'legacy-file-missing',
          elementId,
          path: classified.rel,
        });
        counts.warnings += 1;
        continue;
      }
      versionedRel = `${elementId}/${formatVersionTag(1)}.${classified.ext}`;
      absVersionedPath = path.join(mediaDir, versionedRel);
      mtimeSourcePath = legacyAbs;

      if (opts.dryRun) {
        log({
          id: classroomId,
          action: 'plan',
          stage: 'media',
          elementId,
          from: classified.rel,
          to: versionedRel,
        });
      } else {
        await safeMigrateFile(legacyAbs, absVersionedPath);
        log({
          id: classroomId,
          action: 'migrate',
          stage: 'media',
          elementId,
          from: classified.rel,
          to: versionedRel,
        });
        // Update src in scene to the new versioned URL.
        element.src = `/api/classroom-media/${classroomId}/media/${versionedRel}`;
      }
    }

    const generatedAt = await fileMtimeIso(mtimeSourcePath);
    assets[elementId] = {
      kind: element.type, // 'image' | 'video'
      elementId,
      sceneId: scene.id,
      // Unrecoverable for legacy — see plan §10 question 3.
      prompt: '',
      provider: LEGACY_PROVIDER,
      model: LEGACY_MODEL,
      params: {},
      currentVersion: 1,
      versions: [
        {
          versionNo: 1,
          path: `media/${versionedRel}`,
          promptUsed: '',
          paramsUsed: {},
          generatedAt,
        },
      ],
    };
    counts.assets += 1;
  }

  // ---- Pass 2: TTS metadata for SpeechActions ----
  for (const { action } of iterSpeechActions(classroom)) {
    if (action.tts && typeof action.tts === 'object') {
      // Already backfilled or natively populated — preserve as-is.
      continue;
    }
    if (typeof action.audioUrl !== 'string' || action.audioUrl.length === 0) {
      // No audio on disk; cannot backfill metadata. Leave action intact.
      continue;
    }
    const text = typeof action.text === 'string' ? action.text : '';
    const classified = classifyAudioUrl(action.audioUrl, classroomId, action.id);
    if (!classified) {
      log({
        id: classroomId,
        action: 'warn',
        stage: 'tts',
        reason: 'audioUrl-not-recognized',
        actionId: action.id,
        audioUrl: action.audioUrl,
      });
      counts.warnings += 1;
      continue;
    }

    let versionedRel; // path inside audio/, e.g. "speech_3/v001.mp3"
    let absVersionedPath;
    let mtimeSourcePath;
    let newAudioUrl;

    if (classified.layout === 'versioned') {
      versionedRel = classified.rel;
      absVersionedPath = path.join(audioDir, versionedRel);
      mtimeSourcePath = absVersionedPath;
      newAudioUrl = action.audioUrl;
      if (!(await pathExists(absVersionedPath))) {
        log({
          id: classroomId,
          action: 'warn',
          stage: 'tts',
          reason: 'versioned-audio-missing',
          actionId: action.id,
          path: versionedRel,
        });
        counts.warnings += 1;
        continue;
      }
    } else {
      const legacyAbs = path.join(audioDir, classified.rel);
      if (!(await pathExists(legacyAbs))) {
        log({
          id: classroomId,
          action: 'warn',
          stage: 'tts',
          reason: 'legacy-audio-missing',
          actionId: action.id,
          path: classified.rel,
        });
        counts.warnings += 1;
        continue;
      }
      versionedRel = `${action.id}/${formatVersionTag(1)}.${classified.format}`;
      absVersionedPath = path.join(audioDir, versionedRel);
      mtimeSourcePath = legacyAbs;
      newAudioUrl = `/api/classroom-media/${classroomId}/audio/${versionedRel}`;

      if (opts.dryRun) {
        log({
          id: classroomId,
          action: 'plan',
          stage: 'tts',
          actionId: action.id,
          from: classified.rel,
          to: versionedRel,
        });
      } else {
        await safeMigrateFile(legacyAbs, absVersionedPath);
        log({
          id: classroomId,
          action: 'migrate',
          stage: 'tts',
          actionId: action.id,
          from: classified.rel,
          to: versionedRel,
        });
        action.audioUrl = newAudioUrl;
      }
    }

    const generatedAt = await fileMtimeIso(mtimeSourcePath);
    const textHash = computeTextHash(text);
    action.tts = {
      schemaVersion: TTS_SCHEMA_VERSION,
      providerId: LEGACY_PROVIDER,
      model: LEGACY_MODEL,
      voice: LEGACY_VOICE,
      format: classified.format || LEGACY_FORMAT_DEFAULT,
      textHash,
      configVersion: LEGACY_CONFIG_VERSION,
      generatedAt,
      currentVersion: 1,
      versions: [
        {
          versionNo: 1,
          audioUrl: newAudioUrl,
          textHash,
          generatedAt,
        },
      ],
    };
    counts.tts += 1;
  }

  // ---- Pass 3: interactive slides (best-effort, file-based only) ----
  /** @type {Record<string, any>} */
  const interactiveSlides = {};
  const interactiveDir = path.join(CLASSROOMS_DIR, classroomId, 'interactive');
  if (await pathExists(interactiveDir)) {
    for (const scene of classroom.scenes ?? []) {
      if (scene.type !== 'interactive') continue;
      const sceneDir = path.join(interactiveDir, scene.id);
      if (!(await pathExists(sceneDir))) continue;
      // Best-effort: pick a v001.html if present.
      const candidate = `${formatVersionTag(1)}.html`;
      const abs = path.join(sceneDir, candidate);
      if (!(await pathExists(abs))) continue;
      const generatedAt = await fileMtimeIso(abs);
      interactiveSlides[scene.id] = {
        sceneId: scene.id,
        prompt: '',
        model: LEGACY_MODEL,
        currentVersion: 1,
        versions: [
          {
            versionNo: 1,
            htmlPath: `interactive/${scene.id}/${candidate}`,
            prompt: '',
            generatedAt,
          },
        ],
      };
      counts.interactive += 1;
    }
  }
  // Note: when interactive HTML is embedded inline in scene content (the
  // common case), we deliberately do not record a manifest entry — there's
  // no separate file to track, and the inline content already lives in the
  // classroom JSON which itself is versioned via lesson revisions (Wave 2).

  // ---- Compose manifest and write back ----
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    assets,
    ...(Object.keys(interactiveSlides).length > 0
      ? { interactiveSlides }
      : {}),
  };
  classroom.manifest = manifest;

  if (opts.dryRun) {
    log({
      id: classroomId,
      action: 'would-backfill',
      assets: counts.assets,
      tts: counts.tts,
      interactive: counts.interactive,
      warnings: counts.warnings,
    });
  } else {
    await writeClassroomAtomic(classroomId, classroom);
    log({
      id: classroomId,
      action: 'backfilled',
      assets: counts.assets,
      tts: counts.tts,
      interactive: counts.interactive,
      warnings: counts.warnings,
    });
  }
  return { action: 'backfilled', counts };
}

// ---------------------------------------------------------------------------
// Logging — one JSON-ish line per event for easy grep/awk.
// ---------------------------------------------------------------------------

function log(record) {
  const parts = [];
  for (const [k, v] of Object.entries(record)) {
    parts.push(`${k}=${JSON.stringify(v)}`);
  }
  console.log(parts.join(' '));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv);
  } catch (err) {
    console.error(String(err?.message ?? err));
    process.exit(2);
  }
  if (opts.help) printHelpAndExit();

  log({
    event: 'start',
    dryRun: opts.dryRun,
    id: opts.id,
    limit: opts.limit,
    classroomsDir: CLASSROOMS_DIR,
  });

  let allIds;
  try {
    allIds = await listClassroomIds();
  } catch (err) {
    console.error(String(err?.message ?? err));
    process.exit(1);
  }

  let ids = allIds;
  if (opts.id) ids = ids.filter((id) => id === opts.id);
  if (typeof opts.limit === 'number') ids = ids.slice(0, opts.limit);

  log({ event: 'plan', total: allIds.length, processing: ids.length });

  const totals = {
    scanned: 0,
    backfilled: 0,
    skipped: 0,
    failed: 0,
    assets: 0,
    tts: 0,
    interactive: 0,
    warnings: 0,
  };

  for (const id of ids) {
    totals.scanned += 1;
    try {
      const result = await backfillClassroom(id, opts);
      if (result.action === 'skip') totals.skipped += 1;
      else if (result.action === 'backfilled') totals.backfilled += 1;
      totals.assets += result.counts.assets;
      totals.tts += result.counts.tts;
      totals.interactive += result.counts.interactive;
      totals.warnings += result.counts.warnings;
    } catch (err) {
      totals.failed += 1;
      log({
        id,
        action: 'error',
        stage: 'process',
        error: String(err?.message ?? err),
        stack: err?.stack ?? null,
      });
      // Continue with the next classroom — one failure must not abort the run.
    }
  }

  log({
    event: 'summary',
    dryRun: opts.dryRun,
    scanned: totals.scanned,
    backfilled: totals.backfilled,
    skipped: totals.skipped,
    failed: totals.failed,
    assets: totals.assets,
    tts: totals.tts,
    interactive: totals.interactive,
    warnings: totals.warnings,
  });

  // Always exit 0 even with per-classroom warnings/failures — those are
  // visible in the summary. Reserve non-zero for script-level failures
  // (handled above with explicit process.exit(1)).
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
