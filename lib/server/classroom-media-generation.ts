/**
 * Server-side media and TTS generation for classrooms.
 *
 * Generates image/video files and TTS audio for a classroom,
 * writes them to disk, and returns serving URL mappings.
 */

import { promises as fs } from 'fs';
import path from 'path';
import sharp from 'sharp';
import { createLogger } from '@/lib/logger';
import { CLASSROOMS_DIR } from '@/lib/server/classroom-storage';
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

function generatedImageFilename(src: string, classroomId: string): string | null {
  const prefix = `/api/classroom-media/${classroomId}/media/`;
  if (!src.startsWith(prefix)) return null;
  const filename = src.slice(prefix.length);
  return filename.startsWith(GENERATED_IMAGE_PREFIX) ? filename : null;
}

// ---------------------------------------------------------------------------
// Image / Video generation
// ---------------------------------------------------------------------------

export async function generateMediaForClassroom(
  outlines: SceneOutline[],
  classroomId: string,
  baseUrl: string,
): Promise<Record<string, string>> {
  const mediaDir = path.join(CLASSROOMS_DIR, classroomId, 'media');
  await ensureDir(mediaDir);

  // Collect all media generation requests from outlines
  const requests = outlines.flatMap((o) => o.mediaGenerations ?? []);
  if (requests.length === 0) return {};

  // Resolve providers
  const imageProviderIds = Object.keys(getServerImageProviders());
  const videoProviderIds = Object.keys(getServerVideoProviders());

  const mediaMap: Record<string, string> = {};

  // Separate image and video requests, generate each type sequentially
  // but run the two types in parallel (providers often have limited concurrency).
  const imageRequests = requests.filter((r) => r.type === 'image' && imageProviderIds.length > 0);
  const videoRequests = requests.filter((r) => r.type === 'video' && videoProviderIds.length > 0);

  const generateImages = async () => {
    for (const req of imageRequests) {
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

          const filename = `${req.elementId}.${ext}`;
          await fs.writeFile(path.join(mediaDir, filename), buf);
          mediaMap[req.elementId] = mediaServingUrl(baseUrl, classroomId, `media/${filename}`);
          log.info(`Generated image: ${filename}`);
        });
      } catch (err) {
        log.warn(`Image generation failed for ${req.elementId} after ${MEDIA_GEN_ATTEMPTS} attempts:`, err);
      }
    }
  };

  const generateVideos = async () => {
    for (const req of videoRequests) {
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
          const filename = `${req.elementId}.mp4`;
          await fs.writeFile(path.join(mediaDir, filename), buf);
          mediaMap[req.elementId] = mediaServingUrl(baseUrl, classroomId, `media/${filename}`);
          log.info(`Generated video: ${filename}`);
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

export async function generateTTSForClassroom(
  scenes: Scene[],
  classroomId: string,
  baseUrl: string,
  teacherName?: string,
): Promise<void> {
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
    return;
  }

  const primaryId = ttsProviderIds[0];
  const secondaryId = ttsProviderIds[1];

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

        const filename = `${audioId}.${format}`;
        await fs.writeFile(path.join(audioDir, filename), result.audio);
        speechAction.audioId = audioId;
        speechAction.audioUrl = mediaServingUrl(baseUrl, classroomId, `audio/${filename}`);
        log.info(`Generated TTS [${providerId}]: ${filename} (${result.audio.length} bytes)`);
      }
    }
  };

  try {
    await runPass(primaryId, true);
  } catch (err) {
    if (!secondaryId) {
      log.warn(`Classroom ${classroomId}: primary TTS "${primaryId}" failed and no secondary configured:`, err);
      return;
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
}
