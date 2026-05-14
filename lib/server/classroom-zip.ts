// lib/server/classroom-zip.ts
//
// Server-side ZIP export/import helpers for OpenMAIC-RU classrooms.
//
// Export: walks `data/classrooms/<id>.json` + the per-classroom media tree
// (`data/classrooms/<id>/{audio,media,interactive}/...`), builds a deterministic
// ZIP archive containing `classroom.json`, `meta.json`, and all media files
// referenced from the manifest + speech-action audio refs.
//
// Import: parses an in-memory ZIP buffer, validates structure / size / hashes,
// generates a fresh classroom id with `-imported-<ts>-<nanoid>` suffix,
// re-creates `data/classrooms/<newId>/...` mirror, rewrites `/api/classroom-media/<oldId>/`
// references to the new id, and persists via `persistClassroom`.
//
// Security gates (import side):
//   - Feature flag ZIP_IMPORT_ENABLED must be 'true' (or '1') to even allow the route.
//   - ZIP_IMPORT_MAX_BYTES (default 100 MB) — uncompressed total + per-entry cap.
//   - Path-escape guard: every entry must be a relative POSIX path that stays
//     inside the staging dir. Symlinks / `..` segments / absolute paths reject.
//   - Allowed top-level dirs ONLY: `media/`, `audio/`, `interactive/`. Anything
//     else under root (besides the two JSON files) → reject.
//   - File counts: hard cap (default 10_000) to bound zip-bomb fan-out.
//   - integrity hashes in meta.json must verify before persist.
//   - INTERNAL_ACCESS_KEY validation is enforced by middleware.ts (route lives
//     under /api/ so the global guard kicks in).
//   - We do NOT reach back to ai-gateway during import (no LLM/TTS calls);
//     managed-mode boundaries are preserved.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { nanoid } from 'nanoid';

import {
  CLASSROOMS_DIR,
  isValidClassroomId,
  persistClassroom,
  readClassroom,
  type PersistedClassroomData,
} from '@/lib/server/classroom-storage';
import { rewriteAssetUrls } from '@/lib/server/signed-url';
import { classroomManifestSchema } from '@/lib/types/manifest';
import {
  CLASSROOM_ZIP_FORMAT_VERSION,
  ZIP_ENTRY_CLASSROOM_JSON,
  ZIP_ENTRY_META_JSON,
  type ClassroomZipMeta,
} from '@/lib/export/classroom-zip-types';

import packageJson from '../../package.json';

// ─── Limits & feature flags ────────────────────────────────────────────────

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024; // 100 MB
const HARD_FILE_COUNT_LIMIT = 10_000;
const ALLOWED_TOP_DIRS = new Set(['media', 'audio', 'interactive']);

export function isImportEnabled(): boolean {
  const raw = (process.env.ZIP_IMPORT_ENABLED ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
}

export function maxImportBytes(): number {
  const raw = process.env.ZIP_IMPORT_MAX_BYTES;
  if (!raw) return DEFAULT_MAX_BYTES;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

// ─── Internal helpers ──────────────────────────────────────────────────────

async function statSafe(p: string) {
  try {
    return await fs.stat(p);
  } catch {
    return null;
  }
}

/** Walk a directory and yield {relPath, absPath, size} for each regular file. */
async function* walkFiles(
  rootDir: string,
  prefix = '',
): AsyncGenerator<{ relPath: string; absPath: string; size: number }> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const abs = path.join(rootDir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      yield* walkFiles(abs, rel);
    } else if (entry.isFile()) {
      const st = await statSafe(abs);
      if (st) yield { relPath: rel, absPath: abs, size: st.size };
    }
    // Symlinks and other entry types are intentionally skipped.
  }
}

function sha256Hex(buf: Buffer | string): string {
  const h = createHash('sha256');
  h.update(typeof buf === 'string' ? Buffer.from(buf, 'utf-8') : buf);
  return h.digest('hex');
}

interface MediaIndexEntry {
  path: string;
  sha256: string;
  size: number;
}

/** Build the deterministic mediaIndex hash from an array of `{path, sha256}`. */
function computeMediaIndexHash(entries: MediaIndexEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const lines = sorted.map((e) => `${e.path}\n${e.sha256}\n`).join('');
  return sha256Hex(lines);
}

// ─── Export ────────────────────────────────────────────────────────────────

export interface ExportResult {
  /** ZIP file as a Buffer (small/medium classrooms). For multi-GB exports a
   *  streaming variant would be needed — out of scope for Phase 6. */
  buffer: Buffer;
  /** Suggested download filename (no path component). */
  filename: string;
  /** Echo of meta.json for diagnostics / structured logs. */
  meta: ClassroomZipMeta;
}

export async function exportClassroomToZip(classroomId: string): Promise<ExportResult> {
  if (!isValidClassroomId(classroomId)) {
    throw new Error('invalid classroom id');
  }
  const classroom = await readClassroom(classroomId);
  if (!classroom) {
    throw new Error('classroom not found');
  }

  const classroomDir = path.join(CLASSROOMS_DIR, classroomId);
  const dirStat = await statSafe(classroomDir);
  // dirStat may legitimately be null for legacy classrooms with no media at all.

  const zip = new JSZip();

  // 1) classroom.json — canonicalise via JSON.stringify (sorted-key not strictly
  //    required because we always read+rewrite this file the same way).
  const classroomJsonText = JSON.stringify(classroom, null, 2);
  const classroomJsonSha256 = sha256Hex(classroomJsonText);
  zip.file(ZIP_ENTRY_CLASSROOM_JSON, classroomJsonText);

  // 2) Walk media directories and add files. Restrict to known subdirs.
  const mediaEntries: MediaIndexEntry[] = [];
  let totalBytes = 0;
  if (dirStat?.isDirectory()) {
    for (const sub of ALLOWED_TOP_DIRS) {
      const subDir = path.join(classroomDir, sub);
      const subStat = await statSafe(subDir);
      if (!subStat?.isDirectory()) continue;
      for await (const f of walkFiles(subDir, sub)) {
        if (f.size > maxImportBytes()) {
          // Refuse to export an archive that wouldn't import (one media file
          // bigger than the import-side per-entry cap). Caller can raise
          // ZIP_IMPORT_MAX_BYTES if they really need to ship huge assets.
          throw new Error(
            `classroom file ${f.relPath} (${f.size} bytes) exceeds ZIP_IMPORT_MAX_BYTES`,
          );
        }
        const buf = await fs.readFile(f.absPath);
        zip.file(f.relPath, buf);
        mediaEntries.push({ path: f.relPath, sha256: sha256Hex(buf), size: f.size });
        totalBytes += f.size;
      }
    }
  }

  const meta: ClassroomZipMeta = {
    formatVersion: CLASSROOM_ZIP_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: `${packageJson.version}-osvaivai-ru`,
    sourceClassroomId: classroomId,
    integrity: {
      algo: 'sha256',
      classroomJsonSha256,
      mediaIndexSha256: computeMediaIndexHash(mediaEntries),
    },
    fileCount: mediaEntries.length,
    totalBytes,
    fork: 'osvaivai-ru',
  };

  zip.file(ZIP_ENTRY_META_JSON, JSON.stringify(meta, null, 2));

  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  // Clamp final filename: classroom-id is already validated against /^[A-Za-z0-9_-]+$/.
  const filename = `${classroomId}.maic.zip`;
  return { buffer, filename, meta };
}

// ─── Import ────────────────────────────────────────────────────────────────

export interface ImportResult {
  classroomId: string;
  sourceClassroomId: string;
  fileCount: number;
  totalBytes: number;
  durationMs: number;
}

interface ParsedImportEntry {
  relPath: string;
  absPathInStaging: string;
  buffer: Buffer;
}

function isSafeRelativePath(p: string): boolean {
  if (!p) return false;
  if (p.startsWith('/') || p.startsWith('\\')) return false;
  if (path.isAbsolute(p)) return false;
  // POSIX-style normalise then re-check.
  const norm = path.posix.normalize(p);
  if (norm.startsWith('..') || norm.includes('/../') || norm.endsWith('/..')) {
    return false;
  }
  if (norm !== p) return false;
  // Disallow Windows drive letters / NUL bytes.
  if (/^[A-Za-z]:/.test(p) || p.includes('\0')) return false;
  return true;
}

/**
 * Recursively walk a JSON-shaped value and replace every occurrence of
 * `oldPrefix` with `newPrefix` in string fields. Returns a fresh object.
 */
function remapServingPrefix<T>(value: T, oldPrefix: string, newPrefix: string): T {
  function w(v: unknown): unknown {
    if (typeof v === 'string') {
      if (v.includes(oldPrefix)) return v.split(oldPrefix).join(newPrefix);
      return v;
    }
    if (Array.isArray(v)) return v.map(w);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
        out[k] = w(vv);
      }
      return out;
    }
    return v;
  }
  return w(value) as T;
}

function generateImportedClassroomId(sourcePrefix: string | undefined): string {
  // Mirrors clone/route.ts slug+nanoid pattern but with `-imported-<ts>-<nano>`
  // suffix so that imports are visually distinguishable in the catalog.
  const slug = (sourcePrefix ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const suffix = `imported-${ts}-${nanoid(6)}`;
  return slug ? `${slug}-${suffix}` : suffix;
}

export async function importClassroomFromZip(
  zipBuffer: Buffer,
  opts: { baseUrl: string },
): Promise<ImportResult> {
  if (!isImportEnabled()) {
    throw new Error('ZIP import is disabled (set ZIP_IMPORT_ENABLED=true to allow)');
  }
  const maxBytes = maxImportBytes();
  if (zipBuffer.length > maxBytes) {
    throw new Error(`zip exceeds ZIP_IMPORT_MAX_BYTES (${zipBuffer.length} > ${maxBytes})`);
  }

  const startedAt = Date.now();
  const zip = await JSZip.loadAsync(zipBuffer);

  // ── Sanity: required entries exist ──
  const metaEntry = zip.file(ZIP_ENTRY_META_JSON);
  const classroomEntry = zip.file(ZIP_ENTRY_CLASSROOM_JSON);
  if (!metaEntry) throw new Error(`zip missing ${ZIP_ENTRY_META_JSON}`);
  if (!classroomEntry) throw new Error(`zip missing ${ZIP_ENTRY_CLASSROOM_JSON}`);

  const metaText = await metaEntry.async('text');
  let meta: ClassroomZipMeta;
  try {
    meta = JSON.parse(metaText) as ClassroomZipMeta;
  } catch {
    throw new Error(`${ZIP_ENTRY_META_JSON}: invalid JSON`);
  }
  if (typeof meta?.formatVersion !== 'number') {
    throw new Error(`${ZIP_ENTRY_META_JSON}: missing formatVersion`);
  }
  if (meta.formatVersion > CLASSROOM_ZIP_FORMAT_VERSION) {
    throw new Error(
      `unsupported zip formatVersion ${meta.formatVersion} (max ${CLASSROOM_ZIP_FORMAT_VERSION})`,
    );
  }

  const classroomText = await classroomEntry.async('text');
  const classroomJsonSha256 = sha256Hex(classroomText);
  if (
    meta.integrity?.algo === 'sha256' &&
    meta.integrity.classroomJsonSha256 &&
    meta.integrity.classroomJsonSha256 !== classroomJsonSha256
  ) {
    throw new Error('classroom.json sha256 does not match meta.integrity.classroomJsonSha256');
  }

  let parsedClassroom: PersistedClassroomData;
  try {
    parsedClassroom = JSON.parse(classroomText) as PersistedClassroomData;
  } catch {
    throw new Error(`${ZIP_ENTRY_CLASSROOM_JSON}: invalid JSON`);
  }
  if (!parsedClassroom.id || !parsedClassroom.stage || !Array.isArray(parsedClassroom.scenes)) {
    throw new Error(`${ZIP_ENTRY_CLASSROOM_JSON}: missing id/stage/scenes`);
  }
  if (parsedClassroom.manifest !== undefined) {
    const parsed = classroomManifestSchema.safeParse(parsedClassroom.manifest);
    if (!parsed.success) {
      throw new Error(`classroom.manifest invalid: ${parsed.error.issues[0]?.message ?? 'schema'}`);
    }
  }

  // ── Walk all entries; collect media files; enforce caps ──
  const collected: ParsedImportEntry[] = [];
  let totalBytes = 0;
  let fileCount = 0;

  // Stable enumeration order for deterministic media-index hash.
  const allPaths = Object.keys(zip.files).sort();
  for (const entryPath of allPaths) {
    const entry = zip.files[entryPath];
    if (!entry) continue;
    if (entry.dir) continue;
    if (entryPath === ZIP_ENTRY_META_JSON || entryPath === ZIP_ENTRY_CLASSROOM_JSON) continue;

    if (!isSafeRelativePath(entryPath)) {
      throw new Error(`unsafe zip entry path: ${entryPath}`);
    }
    const topDir = entryPath.split('/')[0];
    if (!ALLOWED_TOP_DIRS.has(topDir)) {
      throw new Error(`zip entry not in allowed top dir: ${entryPath}`);
    }

    fileCount += 1;
    if (fileCount > HARD_FILE_COUNT_LIMIT) {
      throw new Error(`zip exceeds file count limit (${HARD_FILE_COUNT_LIMIT})`);
    }

    const buf = (await entry.async('nodebuffer')) as Buffer;
    if (buf.length > maxBytes) {
      throw new Error(`zip entry ${entryPath} exceeds per-file ${maxBytes} bytes`);
    }
    totalBytes += buf.length;
    if (totalBytes > maxBytes) {
      throw new Error(`uncompressed zip total ${totalBytes} exceeds ${maxBytes} bytes`);
    }
    collected.push({ relPath: entryPath, absPathInStaging: entryPath, buffer: buf });
  }

  // ── Verify mediaIndex hash if present ──
  if (meta.integrity?.mediaIndexSha256) {
    const idx: MediaIndexEntry[] = collected.map((c) => ({
      path: c.relPath,
      sha256: sha256Hex(c.buffer),
      size: c.buffer.length,
    }));
    const have = computeMediaIndexHash(idx);
    if (have !== meta.integrity.mediaIndexSha256) {
      throw new Error('media index sha256 does not match meta.integrity.mediaIndexSha256');
    }
  }

  // ── Allocate new classroom id and stage on disk ──
  const newClassroomId = generateImportedClassroomId(parsedClassroom.id);
  if (!isValidClassroomId(newClassroomId)) {
    throw new Error('failed to generate valid classroom id');
  }
  const finalDir = path.join(CLASSROOMS_DIR, newClassroomId);
  const stagingDir = path.join(CLASSROOMS_DIR, `.tmp-import-${newClassroomId}-${randomUUID()}`);
  if (await statSafe(finalDir)) {
    throw new Error('generated classroom id collided (retry)');
  }
  await fs.mkdir(stagingDir, { recursive: true });

  try {
    // Write all media files into staging, with path-escape defence-in-depth.
    for (const c of collected) {
      const target = path.resolve(stagingDir, c.relPath);
      const stagingResolved = path.resolve(stagingDir);
      if (!target.startsWith(stagingResolved + path.sep) && target !== stagingResolved) {
        throw new Error(`zip entry escapes staging dir: ${c.relPath}`);
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(tmp, c.buffer);
      await fs.rename(tmp, target);
    }

    // Atomic rename staging → final.
    await fs.rename(stagingDir, finalDir);
  } catch (err) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  // ── Rewrite serving URLs in classroom + manifest from old id to new id ──
  // Both `/api/classroom-media/<oldId>/...` (already-rewritten serving URLs
  // baked into scenes/manifest) and `asset://...` (canonical paths, in case
  // somebody exported a clone-input style document) are normalised.
  const oldServingPrefix = `/api/classroom-media/${parsedClassroom.id}/`;
  const newServingPrefix = `/api/classroom-media/${newClassroomId}/`;
  const docToPersist = remapServingPrefix(
    parsedClassroom,
    oldServingPrefix,
    newServingPrefix,
  );
  // Fold any leftover `asset://` paths through the canonical rewriter so they
  // are bound to the new classroom too.
  const docFullyRewritten = rewriteAssetUrls(
    docToPersist as unknown as Record<string, unknown>,
    newServingPrefix,
  ) as unknown as PersistedClassroomData;

  try {
    await persistClassroom(
      {
        id: newClassroomId,
        stage: {
          ...(docFullyRewritten.stage as unknown as Record<string, unknown>),
          id: newClassroomId,
        } as never,
        scenes: docFullyRewritten.scenes as never,
        manifest: docFullyRewritten.manifest,
      },
      opts.baseUrl,
    );
  } catch (err) {
    // Persist failed — clean up the renamed dir to avoid orphaned media.
    await fs.rm(finalDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  return {
    classroomId: newClassroomId,
    sourceClassroomId: parsedClassroom.id,
    fileCount,
    totalBytes,
    durationMs: Date.now() - startedAt,
  };
}
