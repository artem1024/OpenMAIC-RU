/**
 * Server-side media and TTS generation for classrooms.
 *
 * Generates image/video files and TTS audio for a classroom,
 * writes them to disk, and returns serving URL mappings.
 */

import { promises as fs } from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import sharp from 'sharp';
import { createLogger } from '@/lib/logger';
import { CLASSROOMS_DIR } from '@/lib/server/classroom-storage';
import {
  type AssetEntry,
  type ClassroomManifest,
  type InteractiveSlideEntry,
  MANIFEST_SCHEMA_VERSION,
  formatVersionTag,
} from '@/lib/types/manifest';
import { postProcessInteractiveHtml } from '@/lib/generation/interactive-post-processor';
import type { TTSMetadata, TTSVersionRecord } from '@/lib/types/action';
import { generateImage } from '@/lib/media/image-providers';
import { generateVideo, normalizeVideoOptions } from '@/lib/media/video-providers';
import { generateTTS, generateGeminiTTS } from '@/lib/audio/tts-providers';
import { DEFAULT_TTS_VOICES, TTS_PROVIDERS } from '@/lib/audio/constants';
import { IMAGE_PROVIDERS } from '@/lib/media/image-providers';
import { VIDEO_PROVIDERS } from '@/lib/media/video-providers';
import { isMediaPlaceholder } from '@/lib/store/media-generation';
import {
  getServerImageProviders,
  getServerVideoProviders,
  getServerTTSProviders,
  resolveImageApiKey,
  resolveImageBaseUrl,
  resolveVideoApiKey,
  resolveVideoBaseUrl,
  resolveTTSApiKey,
  resolveTTSBaseUrl,
} from '@/lib/server/provider-config';
import type { SceneOutline } from '@/lib/types/generation';
import type { Scene } from '@/lib/types/stage';
import type { SpeechAction } from '@/lib/types/action';
import type { ImageProviderId } from '@/lib/media/types';
import type { VideoProviderId } from '@/lib/media/types';
import type { TTSProviderId } from '@/lib/audio/types';
import { splitLongSpeechActions } from '@/lib/audio/tts-utils';

const log = createLogger('ClassroomMedia');

export interface RemovedMedia {
  sceneId: string;
  elementId: string;
  type: 'image' | 'video';
  src: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

const DOWNLOAD_TIMEOUT_MS = 120_000; // 2 minutes
const DOWNLOAD_MAX_SIZE = 100 * 1024 * 1024; // 100 MB

const MEDIA_GEN_ATTEMPTS = 3;
const MEDIA_GEN_BASE_DELAY_MS = 1500;
const GENERATED_IMAGE_PREFIX = 'gen_img_';
const CANVAS_HEIGHT = 562.5;
const IMAGE_BOTTOM_MARGIN = 5;
const IMAGE_ELEMENT_GAP = 10;
const IMAGE_ASPECT_DRIFT_THRESHOLD = 0.15;
const VISUAL_OBJECT_RE =
  /(схем|картин|изображен|диаграмм|иллюстрац|визуал|график|diagram|image|picture|visual)/iu;
const VISUAL_CUE_RE =
  /(посмотр|смотрим|взглян|обратит[еь]?\s+вниман|на\s+экране|на\s+слайде|видите|look|see)/iu;

async function withRetries<T>(
  label: string,
  fn: (attempt: number) => Promise<T>,
  attempts = MEDIA_GEN_ATTEMPTS,
  baseMs = MEDIA_GEN_BASE_DELAY_MS,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      if (i < attempts) {
        const delay = baseMs * Math.pow(2, i - 1);
        log.warn(`${label} attempt ${i}/${attempts} failed, retrying in ${delay}ms: ${(err as Error)?.message || err}`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

async function downloadToBuffer(url: string): Promise<Buffer> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`Download failed: ${resp.status} ${resp.statusText}`);
  const contentLength = Number(resp.headers.get('content-length') || 0);
  if (contentLength > DOWNLOAD_MAX_SIZE) {
    throw new Error(`File too large: ${contentLength} bytes (max ${DOWNLOAD_MAX_SIZE})`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

function mediaServingUrl(_baseUrl: string, classroomId: string, subPath: string): string {
  // Use relative URL so it works both in direct access and via proxy/iframe
  return `/api/classroom-media/${classroomId}/${subPath}`;
}

/**
 * Normalize speech text for hashing: trim, collapse internal whitespace,
 * lowercase. Used to detect "no-op" TTS regens.
 *
 * IMPORTANT: this normalization is part of the wire contract — osvaivai
 * mirrors it to recompute hashes server-side. Do not change without
 * coordinating with the consumer.
 */
function normalizeTextForHash(text: string): string {
  return text.trim().replace(/\s+/gu, ' ').toLowerCase();
}

/**
 * Compute the canonical content hash of a speech action's text. Exported so
 * downstream consumers (osvaivai backend, partial-regen endpoints) can compute
 * the same hash without re-implementing the normalization rules.
 */
export function computeTextHash(text: string): string {
  return createHash('sha256').update(normalizeTextForHash(text), 'utf-8').digest('hex');
}

/**
 * Get-or-create an `AssetEntry` slot in the manifest, ready for a new
 * version push. Caller is expected to push to `versions[]` and bump
 * `currentVersion` after the asset file has been written.
 *
 * Backwards-compat: legacy classrooms have no manifest; this is invoked only
 * when the caller has already provided one (manifest is created at the start
 * of a generation pipeline, or by partial-regen flows for older classrooms).
 */
function ensureAssetEntry(
  manifest: ClassroomManifest,
  elementId: string,
  init: {
    kind: AssetEntry['kind'];
    sceneId: string;
    prompt: string;
    provider: string;
    model: string;
    params: Record<string, unknown>;
  },
): AssetEntry {
  const existing = manifest.assets[elementId];
  if (existing) {
    // Update mutable descriptive fields (next regen may use a new prompt /
    // provider) but keep version history intact.
    existing.kind = init.kind;
    existing.sceneId = init.sceneId;
    existing.prompt = init.prompt;
    existing.provider = init.provider;
    existing.model = init.model;
    existing.params = init.params;
    return existing;
  }
  const fresh: AssetEntry = {
    kind: init.kind,
    elementId,
    sceneId: init.sceneId,
    prompt: init.prompt,
    provider: init.provider,
    model: init.model,
    params: init.params,
    currentVersion: 0,
    versions: [],
  };
  manifest.assets[elementId] = fresh;
  return fresh;
}

/** Build a fresh empty manifest for a new generation. */
export function createClassroomManifest(): ClassroomManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    assets: {},
  };
}

function elementBounds(el: { left?: number; top?: number; width?: number; height?: number }) {
  if (
    typeof el.left !== 'number' ||
    typeof el.top !== 'number' ||
    typeof el.width !== 'number' ||
    typeof el.height !== 'number'
  ) {
    return null;
  }
  return {
    left: el.left,
    top: el.top,
    right: el.left + el.width,
    bottom: el.top + el.height,
    width: el.width,
    height: el.height,
  };
}

function xOverlapPx(
  a: { left: number; right: number },
  b: { left: number; right: number },
): number {
  return Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
}

/**
 * For a serving URL pointing at generated media, return the path relative to
 * the classroom's `media/` directory (suitable for `path.join(mediaDir, …)`).
 *
 * Supports both layouts:
 *   - Legacy: `media/{elementId}.{ext}` → returns `{elementId}.{ext}`
 *   - Versioned: `media/{elementId}/v{NNN}.{ext}` → returns `{elementId}/v{NNN}.{ext}`
 *
 * Returns `null` if the src is not a generated-image URL for this classroom.
 */
function generatedImageFilename(src: string, classroomId: string): string | null {
  const prefix = `/api/classroom-media/${classroomId}/media/`;
  if (!src.startsWith(prefix)) return null;
  const rel = src.slice(prefix.length);
  // First path segment must start with the generated-image prefix.
  const firstSegment = rel.split('/')[0];
  return firstSegment && firstSegment.startsWith(GENERATED_IMAGE_PREFIX) ? rel : null;
}

// ---------------------------------------------------------------------------
// Image / Video generation
// ---------------------------------------------------------------------------

export async function generateMediaForClassroom(
  outlines: SceneOutline[],
  classroomId: string,
  baseUrl: string,
  manifest?: ClassroomManifest,
): Promise<Record<string, string>> {
  const mediaDir = path.join(CLASSROOMS_DIR, classroomId, 'media');
  await ensureDir(mediaDir);

  // Collect all media generation requests from outlines, preserving sceneId
  // (= outline.id) for manifest entries.
  const requests = outlines.flatMap((o) =>
    (o.mediaGenerations ?? []).map((req) => ({ req, sceneId: o.id })),
  );
  if (requests.length === 0) return {};

  // Resolve providers
  const imageProviderIds = Object.keys(getServerImageProviders());
  const videoProviderIds = Object.keys(getServerVideoProviders());

  const mediaMap: Record<string, string> = {};

  // Separate image and video requests, generate each type sequentially
  // but run the two types in parallel (providers often have limited concurrency).
  const imageRequests = requests.filter(
    ({ req }) => req.type === 'image' && imageProviderIds.length > 0,
  );
  const videoRequests = requests.filter(
    ({ req }) => req.type === 'video' && videoProviderIds.length > 0,
  );

  const generateImages = async () => {
    for (const { req, sceneId } of imageRequests) {
      const providerId = imageProviderIds[0] as ImageProviderId;
      const apiKey = resolveImageApiKey(providerId);
      if (!apiKey) {
        log.warn(`No API key for image provider "${providerId}", skipping ${req.elementId}`);
        continue;
      }
      const providerConfig = IMAGE_PROVIDERS[providerId];
      const model = providerConfig?.models?.[0]?.id;

      try {
        await withRetries(`image ${req.elementId}`, async () => {
          const result = await generateImage(
            { providerId, apiKey, baseUrl: resolveImageBaseUrl(providerId), model },
            { prompt: req.prompt, aspectRatio: req.aspectRatio || '16:9' },
          );

          let buf: Buffer;
          let ext: string;
          if (result.base64) {
            buf = Buffer.from(result.base64, 'base64');
            ext = 'png';
          } else if (result.url) {
            buf = await downloadToBuffer(result.url);
            const urlExt = path.extname(new URL(result.url).pathname).replace('.', '');
            ext = ['png', 'jpg', 'jpeg', 'webp'].includes(urlExt) ? urlExt : 'png';
          } else {
            throw new Error('Image generation returned no data (neither base64 nor url)');
          }

          // Compute next version number from manifest (if any) and write
          // versioned path: media/{elementId}/v{NNN}.{ext}. We compute the
          // next version up front but only mutate the manifest after the
          // file write succeeds, so failed retries don't leave empty slots.
          const previousVersion = manifest?.assets[req.elementId]?.currentVersion ?? 0;
          const nextVersion = previousVersion + 1;
          const versionTag = formatVersionTag(nextVersion);
          const relPath = `media/${req.elementId}/${versionTag}.${ext}`;
          const absPath = path.join(mediaDir, req.elementId, `${versionTag}.${ext}`);
          await ensureDir(path.dirname(absPath));
          await fs.writeFile(absPath, buf);
          if (manifest) {
            const entry = ensureAssetEntry(manifest, req.elementId, {
              kind: 'image',
              sceneId,
              prompt: req.prompt,
              provider: providerId,
              model: model ?? '',
              params: { aspectRatio: req.aspectRatio || '16:9' },
            });
            entry.currentVersion = nextVersion;
            entry.versions.push({
              versionNo: nextVersion,
              path: relPath,
              promptUsed: req.prompt,
              paramsUsed: { aspectRatio: req.aspectRatio || '16:9' },
              generatedAt: new Date().toISOString(),
            });
          }
          mediaMap[req.elementId] = mediaServingUrl(baseUrl, classroomId, relPath);
          log.info(`Generated image: ${relPath}`);
        });
      } catch (err) {
        log.warn(`Image generation failed for ${req.elementId} after ${MEDIA_GEN_ATTEMPTS} attempts:`, err);
      }
    }
  };

  const generateVideos = async () => {
    for (const { req, sceneId } of videoRequests) {
      const providerId = videoProviderIds[0] as VideoProviderId;
      const apiKey = resolveVideoApiKey(providerId);
      if (!apiKey) {
        log.warn(`No API key for video provider "${providerId}", skipping ${req.elementId}`);
        continue;
      }
      const providerConfig = VIDEO_PROVIDERS[providerId];
      const model = providerConfig?.models?.[0]?.id;

      const normalized = normalizeVideoOptions(providerId, {
        prompt: req.prompt,
        aspectRatio: (req.aspectRatio as '16:9' | '4:3' | '1:1' | '9:16') || '16:9',
      });

      try {
        await withRetries(`video ${req.elementId}`, async () => {
          const result = await generateVideo(
            { providerId, apiKey, baseUrl: resolveVideoBaseUrl(providerId), model },
            normalized,
          );

          const buf = await downloadToBuffer(result.url);

          const previousVersion = manifest?.assets[req.elementId]?.currentVersion ?? 0;
          const nextVersion = previousVersion + 1;
          const versionTag = formatVersionTag(nextVersion);
          const relPath = `media/${req.elementId}/${versionTag}.mp4`;
          const absPath = path.join(mediaDir, req.elementId, `${versionTag}.mp4`);
          await ensureDir(path.dirname(absPath));
          await fs.writeFile(absPath, buf);
          if (manifest) {
            const entry = ensureAssetEntry(manifest, req.elementId, {
              kind: 'video',
              sceneId,
              prompt: req.prompt,
              provider: providerId,
              model: model ?? '',
              params: {
                aspectRatio: (req.aspectRatio as string) || '16:9',
              },
            });
            entry.currentVersion = nextVersion;
            entry.versions.push({
              versionNo: nextVersion,
              path: relPath,
              promptUsed: req.prompt,
              paramsUsed: {
                aspectRatio: (req.aspectRatio as string) || '16:9',
              },
              generatedAt: new Date().toISOString(),
            });
          }
          mediaMap[req.elementId] = mediaServingUrl(baseUrl, classroomId, relPath);
          log.info(`Generated video: ${relPath}`);
        });
      } catch (err) {
        log.warn(`Video generation failed for ${req.elementId} after ${MEDIA_GEN_ATTEMPTS} attempts:`, err);
      }
    }
  };

  await Promise.all([generateImages(), generateVideos()]);

  return mediaMap;
}

// ---------------------------------------------------------------------------
// Placeholder replacement in scene content
// ---------------------------------------------------------------------------

export function replaceMediaPlaceholders(scenes: Scene[], mediaMap: Record<string, string>): void {
  if (Object.keys(mediaMap).length === 0) return;

  for (const scene of scenes) {
    if (scene.type !== 'slide') continue;
    const canvas = (
      scene.content as {
        canvas?: { elements?: Array<{ id: string; src?: string; type?: string }> };
      }
    )?.canvas;
    if (!canvas?.elements) continue;

    for (const el of canvas.elements) {
      if (
        (el.type === 'image' || el.type === 'video') &&
        typeof el.src === 'string' &&
        isMediaPlaceholder(el.src) &&
        mediaMap[el.src]
      ) {
        el.src = mediaMap[el.src];
      }
    }
  }
}

/**
 * Generated image providers may return a different natural ratio than the box
 * proposed by the LLM. Never stretch the bitmap: contain it inside the current
 * slot and the available vertical room until the next lower overlapping
 * element/canvas bottom.
 */
export async function correctGeneratedImageAspectRatios(
  scenes: Scene[],
  classroomId: string,
  classroomsDir = CLASSROOMS_DIR,
): Promise<number> {
  let corrected = 0;
  const mediaDir = path.join(classroomsDir, classroomId, 'media');

  for (const scene of scenes) {
    if (scene.type !== 'slide') continue;
    const canvas = (
      scene.content as {
        canvas?: {
          elements?: Array<{
            id: string;
            src?: string;
            type?: string;
            left?: number;
            top?: number;
            width?: number;
            height?: number;
          }>;
          viewportRatio?: number;
          viewportSize?: number;
        };
      }
    )?.canvas;
    if (!canvas?.elements) continue;
    const canvasHeight =
      typeof canvas.viewportSize === 'number' && typeof canvas.viewportRatio === 'number'
        ? canvas.viewportSize * canvas.viewportRatio
        : CANVAS_HEIGHT;

    for (const el of canvas.elements) {
      if (el.type !== 'image' || typeof el.src !== 'string') continue;
      const filename = generatedImageFilename(el.src, classroomId);
      const bounds = elementBounds(el);
      if (!filename || !bounds) continue;

      let metadata: sharp.Metadata;
      try {
        metadata = await sharp(path.join(mediaDir, filename)).metadata();
      } catch (err) {
        log.warn(`Unable to read generated image metadata for ${filename}:`, err);
        continue;
      }
      if (!metadata.width || !metadata.height) continue;

      const naturalRatio = metadata.width / metadata.height;
      const sceneRatio = bounds.width / bounds.height;
      const drift = Math.abs(sceneRatio - naturalRatio) / naturalRatio;
      if (drift <= IMAGE_ASPECT_DRIFT_THRESHOLD) continue;

      let nextTop = canvasHeight - IMAGE_BOTTOM_MARGIN;
      for (const other of canvas.elements) {
        if (other.id === el.id) continue;
        const otherBounds = elementBounds(other);
        if (!otherBounds || otherBounds.top <= bounds.top) continue;
        if (xOverlapPx(bounds, otherBounds) <= 0) continue;
        nextTop = Math.min(nextTop, otherBounds.top - IMAGE_ELEMENT_GAP);
      }
      const availableHeight = Math.max(20, nextTop - bounds.top);
      const heightAtCurrentWidth = bounds.width / naturalRatio;
      if (heightAtCurrentWidth <= availableHeight) {
        el.height = heightAtCurrentWidth;
      } else {
        const newWidth = availableHeight * naturalRatio;
        el.left = bounds.left + (bounds.width - newWidth) / 2;
        el.width = newWidth;
        el.height = availableHeight;
      }
      corrected++;
      log.info(
        `Corrected generated image aspect ratio for ${el.id} in scene ${scene.id}: drift=${drift.toFixed(
          2,
        )}`,
      );
    }
  }

  return corrected;
}

/**
 * Remove image/video canvas elements whose `src` is still a `gen_img_*` / `gen_vid_*`
 * placeholder after replacement — i.e. generation failed and no file was produced.
 * Leaving the placeholder in the JSON causes the player to render a blank grey area
 * with a broken-image icon. Dropping the element keeps the rest of the slide clean.
 */
export function removeUnresolvedMediaPlaceholders(scenes: Scene[]): RemovedMedia[] {
  const removed: RemovedMedia[] = [];
  for (const scene of scenes) {
    if (scene.type !== 'slide') continue;
    const canvas = (
      scene.content as {
        canvas?: { elements?: Array<{ id: string; src?: string; type?: string }> };
      }
    )?.canvas;
    if (!canvas?.elements) continue;
    const sceneRemoved: RemovedMedia[] = [];
    canvas.elements = canvas.elements.filter((el) => {
      if (
        (el.type === 'image' || el.type === 'video') &&
        typeof el.src === 'string' &&
        isMediaPlaceholder(el.src)
      ) {
        sceneRemoved.push({
          sceneId: scene.id,
          elementId: el.id,
          type: el.type,
          src: el.src,
        });
        log.warn(
          `Removing unresolved ${el.type} element ${el.id} (src=${el.src}) from scene ${scene.id}`,
        );
        return false;
      }
      return true;
    });
    if (sceneRemoved.length === 0) continue;

    removed.push(...sceneRemoved);
    const removedIds = new Set(sceneRemoved.map((media) => media.elementId));
    if (scene.actions) {
      const beforeActions = scene.actions.length;
      scene.actions = scene.actions.filter((action) => {
        if (action.type === 'speech') return true;
        const elementId = 'elementId' in action ? action.elementId : undefined;
        return !elementId || !removedIds.has(elementId);
      });
      const removedActions = beforeActions - scene.actions.length;
      if (removedActions > 0) {
        log.warn(
          `Removed ${removedActions} dangling action(s) for unresolved media in scene ${scene.id}`,
        );
      }
    }
  }
  return removed;
}

function splitSentences(text: string): string[] {
  return text.match(/[^.!?…]+[.!?…]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
}

function isRemovedMediaVisualReference(sentence: string): boolean {
  return VISUAL_OBJECT_RE.test(sentence) && VISUAL_CUE_RE.test(sentence);
}

/**
 * If media failed and its slide actions were removed, speech may still say
 * "look at the diagram". Do a deterministic pre-TTS cleanup for only those
 * scenes. This deliberately does not rewrite concepts, numbers, or terms.
 */
export function removeSpeechVisualReferencesForRemovedMedia(
  scenes: Scene[],
  removedMedia: RemovedMedia[],
): number {
  if (removedMedia.length === 0) return 0;
  const affectedSceneIds = new Set(removedMedia.map((media) => media.sceneId));
  let changed = 0;

  for (const scene of scenes) {
    if (!affectedSceneIds.has(scene.id) || !scene.actions) continue;
    const nextActions: NonNullable<Scene['actions']> = [];
    for (const action of scene.actions) {
      if (action.type !== 'speech') {
        nextActions.push(action);
        continue;
      }

      const sentences = splitSentences(action.text);
      const kept = sentences.filter((sentence) => !isRemovedMediaVisualReference(sentence));
      if (kept.length === sentences.length) {
        nextActions.push(action);
        continue;
      }

      const nextText = kept.join(' ').trim();
      changed++;
      if (nextText.length > 0) {
        nextActions.push({ ...action, text: nextText });
      }
    }
    scene.actions = nextActions;
  }

  return changed;
}

// ---------------------------------------------------------------------------
// TTS generation
// ---------------------------------------------------------------------------

export interface TTSGenerationStats {
  count: number;
  providerId: TTSProviderId | null;
  /**
   * Per-action regeneration outcomes. Always present; for full-classroom runs
   * it lists every speech action that received a fresh mp3.
   */
  regenerated: Array<{
    actionId: string;
    versionNo: number;
    audioUrl: string;
    textHash: string;
  }>;
  /**
   * Speech actions whose TTS was deliberately not re-synthesized. Currently the
   * only documented reason is `textHashMatch` (idempotency skip on partial
   * regen). On full-classroom runs this is empty (force=true semantics).
   */
  skipped: Array<{ actionId: string; reason: 'textHashMatch' }>;
}

/** Options for partial / forced TTS regeneration. */
export interface TTSRegenOptions {
  /** Restrict regen to these speech action IDs. Empty/undefined → whole classroom. */
  actionIds?: string[];
  /**
   * When true, bypass the textHash idempotency check and always re-synthesize
   * (revoice case: same text, new voice/provider, or recovering from a corrupt
   * mp3). Defaults to false.
   */
  force?: boolean;
}

export async function generateTTSForClassroom(
  scenes: Scene[],
  classroomId: string,
  baseUrl: string,
  teacherName?: string,
  options?: TTSRegenOptions,
): Promise<TTSGenerationStats> {
  const audioDir = path.join(CLASSROOMS_DIR, classroomId, 'audio');
  await ensureDir(audioDir);

  // Resolve server-side TTS providers (excluding browser-native).
  // Порядок в server-providers.yml задаёт primary/secondary: первый — основной,
  // второй (если есть) — аварийный. Закрепляем один голос на весь classroom
  // (pinning), чтобы ученик не слышал смену voice mid-lesson.
  const ttsProviderIds = Object.keys(getServerTTSProviders()).filter(
    (id) => id !== 'browser-native-tts',
  ) as TTSProviderId[];
  if (ttsProviderIds.length === 0) {
    log.warn('No server TTS provider configured, skipping TTS generation');
    return { count: 0, providerId: null, regenerated: [], skipped: [] };
  }

  const primaryId = ttsProviderIds[0];
  const secondaryId = ttsProviderIds[1];
  let generatedCount = 0;
  let usedProviderId: TTSProviderId | null = null;
  const regenerated: TTSGenerationStats['regenerated'] = [];
  const skipped: TTSGenerationStats['skipped'] = [];
  const skippedActionIds = new Set<string>();
  const force = options?.force === true;
  const actionIdFilter = options?.actionIds && options.actionIds.length > 0
    ? new Set(options.actionIds)
    : null;

  // configVersion is a free-form tag describing the provider config used for
  // this generation; for now we use the ai-gateway commit hash if available,
  // otherwise a stable "default" placeholder. Wave 2 may inject a real value.
  const configVersion = process.env.AI_GATEWAY_COMMIT?.trim() || 'default';

  const runPass = async (providerId: TTSProviderId, isPrimary: boolean): Promise<void> => {
    const apiKey = resolveTTSApiKey(providerId);
    if (!apiKey && TTS_PROVIDERS[providerId]?.requiresApiKey) {
      throw new Error(`No API key for TTS provider "${providerId}"`);
    }
    const ttsBaseUrl = resolveTTSBaseUrl(providerId) || TTS_PROVIDERS[providerId]?.defaultBaseUrl;
    const voice = DEFAULT_TTS_VOICES[providerId] || 'default';
    const format = TTS_PROVIDERS[providerId]?.supportedFormats?.[0] || 'mp3';

    for (const scene of scenes) {
      if (!scene.actions) continue;
      scene.actions = splitLongSpeechActions(scene.actions, providerId);

      for (const action of scene.actions) {
        if (action.type !== 'speech' || !(action as SpeechAction).text) continue;
        const speechAction = action as SpeechAction;
        const audioId = `tts_${action.id}`;

        // Partial regen: skip actions outside the requested set.
        if (actionIdFilter && !actionIdFilter.has(action.id)) continue;

        // textHash idempotency: if the text didn't change, don't burn a TTS
        // call — leave the existing audio untouched. `force=true` opts out
        // (revoice / corrupt-mp3 recovery / provider switch).
        if (!force) {
          const newHash = computeTextHash(speechAction.text);
          if (speechAction.tts && speechAction.tts.textHash === newHash) {
            if (!skippedActionIds.has(action.id)) {
              skippedActionIds.add(action.id);
              skipped.push({ actionId: action.id, reason: 'textHashMatch' });
            }
            continue;
          }
        }

        let result;
        if (providerId === 'gemini-tts') {
          // Прямой вызов: пробрасываем classroom/action ids для наблюдаемости
          // и allow_fallback=false — хотим видеть ошибку здесь, чтобы каскадно
          // откатить весь classroom на secondary, а не получить edge-tts
          // внутри Gemini-классрума (микс голосов).
          result = await generateGeminiTTS(
            {
              providerId,
              apiKey,
              baseUrl: ttsBaseUrl,
              voice,
              speed: speechAction.speed,
              speakerName: teacherName,
            },
            speechAction.text,
            {
              allowFallback: !isPrimary, // на secondary-проходе разрешаем внутренний fallback
              classroomId,
              actionId: action.id,
            },
          );
        } else {
          result = await generateTTS(
            { providerId, apiKey, baseUrl: ttsBaseUrl, voice, speed: speechAction.speed, speakerName: teacherName },
            speechAction.text,
          );
        }

        // Versioned audio path: audio/{actionId}/v{NNN}.{format}.
        // If the action already has TTS metadata (e.g. partial regen of an
        // existing classroom), bump the version; otherwise start at v001.
        const previousVersion = speechAction.tts?.currentVersion ?? 0;
        const nextVersion = previousVersion + 1;
        const versionTag = formatVersionTag(nextVersion);
        const relPath = `audio/${action.id}/${versionTag}.${format}`;
        const absPath = path.join(audioDir, action.id, `${versionTag}.${format}`);
        await ensureDir(path.dirname(absPath));
        await fs.writeFile(absPath, result.audio);

        const audioUrl = mediaServingUrl(baseUrl, classroomId, relPath);
        const generatedAt = new Date().toISOString();
        const textHash = computeTextHash(speechAction.text);
        const versionRecord: TTSVersionRecord = {
          versionNo: nextVersion,
          audioUrl,
          textHash,
          generatedAt,
        };
        const previousVersions = speechAction.tts?.versions ?? [];

        speechAction.audioId = audioId;
        speechAction.audioUrl = audioUrl;
        const ttsMeta: TTSMetadata = {
          schemaVersion: 1,
          providerId,
          model: voice, // The provider model is implicit; voice identifies the model variant.
          voice,
          format,
          ...(typeof speechAction.speed === 'number' ? { speed: speechAction.speed } : {}),
          ...(teacherName ? { speakerName: teacherName } : {}),
          textHash,
          configVersion,
          generatedAt,
          currentVersion: nextVersion,
          versions: [...previousVersions, versionRecord],
        };
        speechAction.tts = ttsMeta;
        generatedCount += 1;
        usedProviderId = providerId;
        regenerated.push({
          actionId: action.id,
          versionNo: nextVersion,
          audioUrl,
          textHash,
        });
        log.info(`Generated TTS [${providerId}]: ${relPath} (${result.audio.length} bytes)`);
      }
    }
  };

  try {
    await runPass(primaryId, true);
  } catch (err) {
    if (!secondaryId) {
      log.warn(`Classroom ${classroomId}: primary TTS "${primaryId}" failed and no secondary configured:`, err);
      return { count: generatedCount, providerId: usedProviderId, regenerated, skipped };
    }
    log.warn(
      `Classroom ${classroomId}: primary TTS "${primaryId}" failed, cascading entire classroom to "${secondaryId}". Reason:`,
      err,
    );
    try {
      await runPass(secondaryId, false);
    } catch (err2) {
      log.warn(`Classroom ${classroomId}: secondary TTS "${secondaryId}" also failed:`, err2);
    }
  }
  return { count: generatedCount, providerId: usedProviderId, regenerated, skipped };
}

// ===========================================================================
// Per-element / per-scene regen helpers (Wave 2 partial-regen endpoints)
// ===========================================================================

/**
 * Defense-in-depth strip of embedding tags from LLM-authored interactive HTML
 * before it's persisted to disk. The renderer also strips on read (see
 * `components/scene-renderers/interactive-renderer.tsx → stripEmbeddingTags`)
 * and runs the iframe sandboxed without `allow-same-origin`, so this is a
 * third line of defense — not the primary safety boundary, but still
 * cheap-to-keep.
 *
 * Mirrors the renderer-side regex set: `<iframe>`, `<object>`, `<embed>`,
 * `<applet>` (open + close + self-closing variants).
 */
export function sanitizeInteractiveHtml(html: string): string {
  // Protect <script> blocks so we don't accidentally rewrite tag-name strings
  // that appear inside JS string literals.
  const scripts: string[] = [];
  let result = html.replace(/<script[\s>][\s\S]*?<\/script>/gi, (m) => {
    scripts.push(m);
    return `__SCRIPT_PLACEHOLDER_${scripts.length - 1}__`;
  });
  result = result.replace(/<(iframe|object|embed|applet)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  result = result.replace(/<(iframe|object|embed|applet)\b[^>]*\/?>(?!<\/\1>)/gi, '');
  result = result.replace(/__SCRIPT_PLACEHOLDER_(\d+)__/g, (_, idx) => scripts[Number(idx)] ?? '');
  return result;
}

/**
 * Locate an `image` / `video` element on any slide-type scene's canvas.
 * Returns `null` if no scene contains an element with the given id.
 *
 * Other element kinds (text, shape) are still returned (caller is expected
 * to validate `element.type`), so the route handler can produce a precise
 * 400 ("element exists but type X is not regen-eligible") rather than a 404.
 */
export function findCanvasElement(
  scenes: Scene[],
  elementId: string,
): { scene: Scene; element: { id: string; type: string; src?: string } } | null {
  for (const scene of scenes) {
    if (scene.type !== 'slide') continue;
    const canvas = (scene.content as { canvas?: { elements?: Array<{ id: string; type: string; src?: string }> } }).canvas;
    const elements = canvas?.elements;
    if (!Array.isArray(elements)) continue;
    const el = elements.find((e) => e.id === elementId);
    if (el) return { scene, element: el };
  }
  return null;
}

export interface AssetRegenResult {
  elementId: string;
  kind: 'image' | 'video';
  versionNo: number;
  src: string;
  prompt: string;
}

/**
 * Regenerate a single image or video element on a slide canvas.
 *
 * Prompt resolution:
 *   - If `args.prompt` is provided, it overrides the saved manifest prompt
 *     and gets persisted into `manifest.assets[id].prompt` for next time.
 *   - Else falls back to `manifest.assets[id].prompt` (must exist).
 *   - If neither is available, throws `Error('No prompt provided ...')`
 *     which the route translates to 400.
 *
 * On success: writes `media/{elementId}/v{NNN}.{ext}`, updates the scene
 * element's `src` to the relative serving URL, bumps `currentVersion` and
 * appends a `versions[]` record. Caller is responsible for `persistClassroom`.
 */
export async function regenerateAssetElement(
  scenes: Scene[],
  manifest: ClassroomManifest,
  classroomId: string,
  baseUrl: string,
  args: {
    elementId: string;
    prompt?: string;
    params?: Record<string, unknown>;
  },
): Promise<AssetRegenResult> {
  const found = findCanvasElement(scenes, args.elementId);
  if (!found) {
    throw new Error(`Element "${args.elementId}" not found on any slide scene`);
  }
  const { scene, element } = found;
  if (element.type !== 'image' && element.type !== 'video') {
    throw new Error(
      `Element "${args.elementId}" has type "${element.type}"; only image/video supported`,
    );
  }
  const kind = element.type as 'image' | 'video';

  const existingEntry = manifest.assets[args.elementId];
  const promptToUse = args.prompt ?? existingEntry?.prompt;
  if (!promptToUse) {
    throw new Error(
      `No prompt provided for element "${args.elementId}" and no saved prompt in manifest`,
    );
  }
  const paramsToUse: Record<string, unknown> = {
    ...(existingEntry?.params ?? {}),
    ...(args.params ?? {}),
  };
  if (!paramsToUse.aspectRatio) {
    paramsToUse.aspectRatio = '16:9';
  }

  const mediaDir = path.join(CLASSROOMS_DIR, classroomId, 'media');
  await ensureDir(mediaDir);

  if (kind === 'image') {
    const imageProviderIds = Object.keys(getServerImageProviders());
    if (imageProviderIds.length === 0) {
      throw new Error('No image provider configured');
    }
    const providerId = imageProviderIds[0] as ImageProviderId;
    const apiKey = resolveImageApiKey(providerId);
    if (!apiKey) {
      throw new Error(`No API key for image provider "${providerId}"`);
    }
    const providerConfig = IMAGE_PROVIDERS[providerId];
    const model = providerConfig?.models?.[0]?.id;

    const writeOutcome = await withRetries(`image-regen ${args.elementId}`, async () => {
      const result = await generateImage(
        { providerId, apiKey, baseUrl: resolveImageBaseUrl(providerId), model },
        {
          prompt: promptToUse,
          aspectRatio: ((paramsToUse.aspectRatio as string) || '16:9') as
            | '16:9'
            | '4:3'
            | '1:1'
            | '9:16',
        },
      );
      let buf: Buffer;
      let ext: string;
      if (result.base64) {
        buf = Buffer.from(result.base64, 'base64');
        ext = 'png';
      } else if (result.url) {
        buf = await downloadToBuffer(result.url);
        const urlExt = path.extname(new URL(result.url).pathname).replace('.', '');
        ext = ['png', 'jpg', 'jpeg', 'webp'].includes(urlExt) ? urlExt : 'png';
      } else {
        throw new Error('Image generation returned no data (neither base64 nor url)');
      }
      const previousVersion = manifest.assets[args.elementId]?.currentVersion ?? 0;
      const nextVersion = previousVersion + 1;
      const versionTag = formatVersionTag(nextVersion);
      const relPath = `media/${args.elementId}/${versionTag}.${ext}`;
      const absPath = path.join(mediaDir, args.elementId, `${versionTag}.${ext}`);
      await ensureDir(path.dirname(absPath));
      await fs.writeFile(absPath, buf);
      return { providerId, model: model ?? '', relPath, nextVersion };
    });

    const entry = ensureAssetEntry(manifest, args.elementId, {
      kind: 'image',
      sceneId: scene.id,
      prompt: promptToUse,
      provider: writeOutcome.providerId,
      model: writeOutcome.model,
      params: paramsToUse,
    });
    entry.currentVersion = writeOutcome.nextVersion;
    entry.versions.push({
      versionNo: writeOutcome.nextVersion,
      path: writeOutcome.relPath,
      promptUsed: promptToUse,
      paramsUsed: paramsToUse,
      generatedAt: new Date().toISOString(),
    });
    const src = mediaServingUrl(baseUrl, classroomId, writeOutcome.relPath);
    (element as { src?: string }).src = src;
    log.info(`Regenerated image: ${writeOutcome.relPath}`);
    return {
      elementId: args.elementId,
      kind,
      versionNo: writeOutcome.nextVersion,
      src,
      prompt: promptToUse,
    };
  }

  // Video branch
  const videoProviderIds = Object.keys(getServerVideoProviders());
  if (videoProviderIds.length === 0) {
    throw new Error('No video provider configured');
  }
  const providerId = videoProviderIds[0] as VideoProviderId;
  const apiKey = resolveVideoApiKey(providerId);
  if (!apiKey) {
    throw new Error(`No API key for video provider "${providerId}"`);
  }
  const providerConfig = VIDEO_PROVIDERS[providerId];
  const model = providerConfig?.models?.[0]?.id;
  const normalized = normalizeVideoOptions(providerId, {
    prompt: promptToUse,
    aspectRatio: ((paramsToUse.aspectRatio as string) || '16:9') as '16:9' | '4:3' | '1:1' | '9:16',
  });

  const writeOutcome = await withRetries(`video-regen ${args.elementId}`, async () => {
    const result = await generateVideo(
      { providerId, apiKey, baseUrl: resolveVideoBaseUrl(providerId), model },
      normalized,
    );
    const buf = await downloadToBuffer(result.url);
    const previousVersion = manifest.assets[args.elementId]?.currentVersion ?? 0;
    const nextVersion = previousVersion + 1;
    const versionTag = formatVersionTag(nextVersion);
    const relPath = `media/${args.elementId}/${versionTag}.mp4`;
    const absPath = path.join(mediaDir, args.elementId, `${versionTag}.mp4`);
    await ensureDir(path.dirname(absPath));
    await fs.writeFile(absPath, buf);
    return { providerId, model: model ?? '', relPath, nextVersion };
  });

  const entry = ensureAssetEntry(manifest, args.elementId, {
    kind: 'video',
    sceneId: scene.id,
    prompt: promptToUse,
    provider: writeOutcome.providerId,
    model: writeOutcome.model,
    params: paramsToUse,
  });
  entry.currentVersion = writeOutcome.nextVersion;
  entry.versions.push({
    versionNo: writeOutcome.nextVersion,
    path: writeOutcome.relPath,
    promptUsed: promptToUse,
    paramsUsed: paramsToUse,
    generatedAt: new Date().toISOString(),
  });
  const src = mediaServingUrl(baseUrl, classroomId, writeOutcome.relPath);
  (element as { src?: string }).src = src;
  log.info(`Regenerated video: ${writeOutcome.relPath}`);
  return {
    elementId: args.elementId,
    kind,
    versionNo: writeOutcome.nextVersion,
    src,
    prompt: promptToUse,
  };
}

export interface InteractiveRegenResult {
  sceneId: string;
  versionNo: number;
  htmlPath: string;
}

/**
 * Regenerate the HTML for a single interactive scene.
 *
 * Prompt resolution mirrors `regenerateAssetElement`:
 *   - `args.prompt` wins; persists into `manifest.interactiveSlides[id].prompt`.
 *   - Falls back to saved prompt in manifest.
 *   - Throws if neither (translated to 400 by route).
 *
 * The caller supplies `aiCall` (system, user) → text and a `modelLabel` for
 * manifest bookkeeping. We extract the HTML body, sanitize for embedding
 * tags, run the standard post-processor (LaTeX delim conversion + KaTeX
 * inject), write to `interactive/{sceneId}/v{NNN}.html`, and update
 * `scene.content.html` (renderer reads inline html from there).
 */
export async function regenerateInteractiveSlide(
  scenes: Scene[],
  manifest: ClassroomManifest,
  classroomId: string,
  args: {
    sceneId: string;
    prompt?: string;
    aiCall: (system: string, user: string) => Promise<string>;
    modelLabel: string;
  },
): Promise<InteractiveRegenResult> {
  const scene = scenes.find((s) => s.id === args.sceneId);
  if (!scene) {
    throw new Error(`Scene "${args.sceneId}" not found`);
  }
  if (scene.type !== 'interactive') {
    throw new Error(`Scene "${args.sceneId}" is not an interactive scene`);
  }

  const slidesMap: Record<string, InteractiveSlideEntry> =
    manifest.interactiveSlides ?? (manifest.interactiveSlides = {});
  const existingEntry = slidesMap[args.sceneId];
  const promptToUse = args.prompt ?? existingEntry?.prompt;
  if (!promptToUse) {
    throw new Error(
      `No prompt provided for scene "${args.sceneId}" and no saved prompt in manifest`,
    );
  }

  // Minimal regen prompt: we don't carry the full SceneOutline (conceptName,
  // keyPoints) across regen, so we use a focused single-shot HTML generation
  // prompt. This is intentional — partial regen is "the user knows what they
  // want, just the design idea changed".
  const system =
    'You are an expert frontend engineer. Generate a single self-contained ' +
    'HTML5 document (with <!DOCTYPE html>) that implements the requested ' +
    'interactive visualization. Use only inline <style> and <script> blocks. ' +
    'Do NOT include <iframe>, <object>, <embed>, or <applet> tags. Output the ' +
    'HTML document only — no surrounding prose, no markdown fences.';
  const user = `Title: ${scene.title}\n\nDesign idea / requirements:\n${promptToUse}`;

  log.info(`[interactive-regen ${classroomId}/${args.sceneId}] calling LLM (${args.modelLabel})`);
  const llmResponse = await args.aiCall(system, user);

  // Reuse existing extractor: tries <!DOCTYPE>/<html> markers, then code
  // fences, then raw-trim. Keeps behavior identical to first-pass generation.
  const rawHtml = extractInteractiveHtml(llmResponse);
  if (!rawHtml) {
    throw new Error(
      `LLM response for scene "${args.sceneId}" did not contain a recognizable HTML document`,
    );
  }

  const sanitized = sanitizeInteractiveHtml(rawHtml);
  const processed = postProcessInteractiveHtml(sanitized);

  const previousVersion = existingEntry?.currentVersion ?? 0;
  const nextVersion = previousVersion + 1;
  const versionTag = formatVersionTag(nextVersion);
  const relPath = `interactive/${args.sceneId}/${versionTag}.html`;
  const absPath = path.join(CLASSROOMS_DIR, classroomId, relPath);
  await ensureDir(path.dirname(absPath));
  await fs.writeFile(absPath, processed, 'utf-8');

  // Update manifest entry
  const entry: InteractiveSlideEntry = existingEntry ?? {
    sceneId: args.sceneId,
    prompt: promptToUse,
    model: args.modelLabel,
    currentVersion: 0,
    versions: [],
  };
  entry.prompt = promptToUse;
  entry.model = args.modelLabel;
  entry.currentVersion = nextVersion;
  entry.versions.push({
    versionNo: nextVersion,
    htmlPath: relPath,
    prompt: promptToUse,
    generatedAt: new Date().toISOString(),
  });
  slidesMap[args.sceneId] = entry;

  // Renderer reads inline `content.html`; keep that in sync so the new
  // version is shown without needing a separate fetch step.
  const interactiveContent = scene.content as { type: 'interactive'; html?: string; url?: string };
  interactiveContent.html = processed;

  log.info(`Regenerated interactive HTML: ${relPath} (${processed.length} chars)`);
  return {
    sceneId: args.sceneId,
    versionNo: nextVersion,
    htmlPath: relPath,
  };
}

/**
 * Local copy of the HTML extractor used by the first-pass generator
 * (`lib/generation/scene-generator.ts → extractHtml`). Duplicated rather
 * than imported to avoid pulling the whole scene-generator graph (and its
 * heavy SDK deps) into a partial-regen-only request.
 */
function extractInteractiveHtml(response: string): string | null {
  const doctypeStart = response.indexOf('<!DOCTYPE html>');
  const htmlTagStart = response.indexOf('<html');
  const start = doctypeStart !== -1 ? doctypeStart : htmlTagStart;
  if (start !== -1) {
    const htmlEnd = response.lastIndexOf('</html>');
    if (htmlEnd !== -1) {
      return response.substring(start, htmlEnd + 7);
    }
  }
  const codeBlockMatch = response.match(/```(?:html)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    const content = codeBlockMatch[1].trim();
    if (content.includes('<html') || content.includes('<!DOCTYPE')) {
      return content;
    }
  }
  const trimmed = response.trim();
  if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) {
    return trimmed;
  }
  return null;
}
