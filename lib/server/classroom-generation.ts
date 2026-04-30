import { nanoid } from 'nanoid';
import { callLLM } from '@/lib/ai/llm';
import { createStageAPI } from '@/lib/api/stage-api';
import type { StageStore } from '@/lib/api/stage-api-types';
import {
  applyOutlineFallbacks,
  generateSceneOutlinesFromRequirements,
} from '@/lib/generation/outline-generator';
import {
  createSceneWithActions,
  generateSceneActions,
  generateSceneContent,
} from '@/lib/generation/scene-generator';
import type { AICallFn } from '@/lib/generation/pipeline-types';
import type { AgentInfo } from '@/lib/generation/pipeline-types';
import { formatTeacherPersonaForPrompt } from '@/lib/generation/prompt-formatters';
import { getDefaultAgents } from '@/lib/orchestration/registry/store';
import { createLogger } from '@/lib/logger';
import { parseModelString } from '@/lib/ai/providers';
import { resolveApiKey, resolveWebSearchApiKey } from '@/lib/server/provider-config';
import { resolveModel } from '@/lib/server/resolve-model';
import { searchWithTavily, formatSearchResultsAsContext } from '@/lib/web-search/tavily';
import { persistClassroom } from '@/lib/server/classroom-storage';
import {
  correctGeneratedImageAspectRatios,
  createClassroomManifest,
  generateMediaForClassroom,
  removeSpeechVisualReferencesForRemovedMedia,
  replaceMediaPlaceholders,
  removeUnresolvedMediaPlaceholders,
  generateTTSForClassroom,
  type RemovedMedia,
} from '@/lib/server/classroom-media-generation';
import type { SceneOutline, UserRequirements } from '@/lib/types/generation';
import type { Scene, Stage } from '@/lib/types/stage';

const log = createLogger('Classroom');

export interface GenerateClassroomInput {
  requirement: string;
  pdfContent?: { text: string; images: string[] };
  language?: string;
  enableWebSearch?: boolean;
  enableImageGeneration?: boolean;
  enableVideoGeneration?: boolean;
  enableTTS?: boolean;
  agentMode?: 'default' | 'generate';
  modelString?: string;
  generationProfile?: Partial<GenerationProfile>;
  /**
   * Phase 3: opt-in bounded-parallel scene generation. Default behaviour
   * (sequential loop) is unchanged when this flag is absent or false.
   */
  parallelMode?: boolean;
  /**
   * Batch size for parallel mode (default 2, clamped 1..8 by route layer).
   */
  parallelConcurrency?: number;
}

export interface GenerationProfile {
  name: string;
  minDurationMin: number;
  maxDurationMin: number;
  scenesPerMinute: number;
  minScenes: number;
  maxScenes: number;
  maxInteractive: number;
  maxVideos: number;
}

export type ClassroomGenerationStep =
  | 'initializing'
  | 'researching'
  | 'generating_outlines'
  | 'generating_scenes'
  | 'generating_media'
  | 'generating_tts'
  | 'persisting'
  | 'completed';

export interface ClassroomGenerationProgress {
  step: ClassroomGenerationStep;
  progress: number;
  message: string;
  scenesGenerated: number;
  totalScenes?: number;
}

/**
 * Per-scene timing breakdown emitted in webhook payload for telemetry.
 */
export interface SceneTimingEntry {
  sceneIndex: number;
  title: string;
  ms: number;
}

/**
 * Stage-level timings собираются вокруг фаз пайплайна и улетают в webhook
 * (см. classroom-job-runner.ts). Все поля nullable: фаза могла быть пропущена
 * (например, TTS отключён) или оборваться до завершения.
 */
export interface GenerationTimings {
  outline_ms: number | null;
  scenes_ms: number | null;
  media_ms: number | null;
  tts_ms: number | null;
  total_ms: number | null;
  tts_actions_count: number | null;
  scenes_breakdown: SceneTimingEntry[] | null;
}

export interface GenerationConfigSnapshot {
  /** Профиль генерации урока (short/standard/deep). */
  profile: string;
  /** Включён ли параллельный режим. */
  parallel_enabled: boolean;
  /**
   * Размер батча параллельной генерации сцен. null когда parallel_enabled=false.
   */
  parallel_concurrency: number | null;
  /** Резолвнутый TTS-провайдер (gemini-tts / edge-tts / etc.) или null. */
  tts_provider: string | null;
}

export interface GenerateClassroomResult {
  id: string;
  url: string;
  stage: Stage;
  scenes: Scene[];
  scenesCount: number;
  createdAt: string;
  /**
   * Стадийные тайминги пайплайна. Опциональны для обратной совместимости с
   * существующими консьюмерами GenerateClassroomResult.
   */
  timings?: GenerationTimings;
  /** Снимок конфигурации генерации, попадает в webhook телеметрии. */
  config?: GenerationConfigSnapshot;
}

const DEFAULT_GENERATION_PROFILE: GenerationProfile = {
  name: 'standard',
  // Backwards-compatible defaults approximate the pre-profile prompt.
  minDurationMin: 20,
  maxDurationMin: 30,
  scenesPerMinute: 1.5,
  minScenes: 12,
  maxScenes: 35,
  maxInteractive: 2,
  maxVideos: 3,
};

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizeGenerationProfile(profile?: Partial<GenerationProfile>): GenerationProfile {
  const defaults = DEFAULT_GENERATION_PROFILE;
  return {
    name: typeof profile?.name === 'string' && profile.name.trim() ? profile.name.trim() : defaults.name,
    minDurationMin: numberOrDefault(profile?.minDurationMin, defaults.minDurationMin),
    maxDurationMin: numberOrDefault(profile?.maxDurationMin, defaults.maxDurationMin),
    scenesPerMinute: numberOrDefault(profile?.scenesPerMinute, defaults.scenesPerMinute),
    minScenes: numberOrDefault(profile?.minScenes, defaults.minScenes),
    maxScenes: numberOrDefault(profile?.maxScenes, defaults.maxScenes),
    maxInteractive: numberOrDefault(profile?.maxInteractive, defaults.maxInteractive),
    maxVideos: numberOrDefault(profile?.maxVideos, defaults.maxVideos),
  };
}

function applyGenerationProfilePlaceholders(prompt: string, profile: GenerationProfile): string {
  return prompt
    .replaceAll('{{minDurationMin}}', String(profile.minDurationMin))
    .replaceAll('{{maxDurationMin}}', String(profile.maxDurationMin))
    .replaceAll('{{scenesPerMinute}}', String(profile.scenesPerMinute))
    .replaceAll('{{minScenes}}', String(profile.minScenes))
    .replaceAll('{{maxScenes}}', String(profile.maxScenes))
    .replaceAll('{{maxInteractive}}', String(profile.maxInteractive))
    .replaceAll('{{maxVideos}}', String(profile.maxVideos));
}

function createInMemoryStore(stage: Stage): StageStore {
  let state = {
    stage: stage as Stage | null,
    scenes: [] as Scene[],
    currentSceneId: null as string | null,
    mode: 'playback' as const,
  };

  const listeners: Array<(s: typeof state, prev: typeof state) => void> = [];

  return {
    getState: () => state,
    setState: (partial: Partial<typeof state>) => {
      const prev = state;
      state = { ...state, ...partial };
      listeners.forEach((fn) => fn(state, prev));
    },
    subscribe: (listener: (s: typeof state, prev: typeof state) => void) => {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
  };
}

async function regenerateScenesWithoutRemovedMedia(
  scenes: Scene[],
  removedMedia: RemovedMedia[],
  outlineBySceneId: Map<string, SceneOutline>,
  aiCall: AICallFn,
  agents?: AgentInfo[],
): Promise<number> {
  if (removedMedia.length === 0) return 0;
  const affectedSceneIds = new Set(removedMedia.map((media) => media.sceneId));
  let rewritten = 0;

  for (const scene of scenes) {
    if (scene.type !== 'slide' || scene.content.type !== 'slide') continue;
    if (!affectedSceneIds.has(scene.id)) continue;

    const outline = outlineBySceneId.get(scene.id);
    if (!outline || outline.type !== 'slide') continue;

    const failedIds = removedMedia
      .filter((media) => media.sceneId === scene.id)
      .map((media) => media.elementId)
      .join(', ');
    const fallbackOutline: SceneOutline = {
      ...outline,
      mediaGenerations: [],
    };
    log.warn(`Regenerating scene "${scene.title}" without failed media (${failedIds})`);

    const content = await generateSceneContent(
      fallbackOutline,
      aiCall,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      agents,
    );
    if (!content || !('elements' in content)) {
      log.warn(`Media fallback failed for scene "${scene.title}" — keeping cleaned original`);
      continue;
    }

    const actions = await generateSceneActions(fallbackOutline, content, aiCall, undefined, agents);
    scene.content.canvas.elements = content.elements;
    scene.content.canvas.background = content.background;
    scene.actions = actions;
    rewritten++;
  }

  return rewritten;
}

function normalizeLanguage(language?: string): 'zh-CN' | 'en-US' | 'ru-RU' {
  if (language === 'en-US') return 'en-US';
  if (language === 'ru-RU') return 'ru-RU';
  return 'zh-CN';
}

function stripCodeFences(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return cleaned.trim();
}

async function generateAgentProfiles(
  requirement: string,
  language: string,
  aiCall: AICallFn,
): Promise<AgentInfo[]> {
  const systemPrompt =
    'You are an expert instructional designer. Generate agent profiles for a multi-agent classroom simulation. Return ONLY valid JSON, no markdown or explanation.';

  const userPrompt = `Generate agent profiles for a course with this requirement:
${requirement}

Requirements:
- Decide the appropriate number of agents based on the course content (typically 3-5)
- Exactly 1 agent must have role "teacher", the rest can be "assistant" or "student"
- Each agent needs: name, role, persona (2-3 sentences describing personality and teaching/learning style)
- Names and personas must be in language: ${language}

Return a JSON object with this exact structure:
{
  "agents": [
    {
      "name": "string",
      "role": "teacher" | "assistant" | "student",
      "persona": "string (2-3 sentences)"
    }
  ]
}`;

  const response = await aiCall(systemPrompt, userPrompt);
  const rawText = stripCodeFences(response);
  const parsed = JSON.parse(rawText) as {
    agents: Array<{ name: string; role: string; persona: string }>;
  };

  if (!parsed.agents || !Array.isArray(parsed.agents) || parsed.agents.length < 2) {
    throw new Error(`Expected at least 2 agents, got ${parsed.agents?.length ?? 0}`);
  }

  const teacherCount = parsed.agents.filter((a) => a.role === 'teacher').length;
  if (teacherCount !== 1) {
    throw new Error(`Expected exactly 1 teacher, got ${teacherCount}`);
  }

  return parsed.agents.map((a, i) => ({
    id: `gen-server-${i}`,
    name: a.name,
    role: a.role,
    persona: a.persona,
  }));
}

// TODO(phase-3-tests): добавить vitest-юнит на parallelMode (sequential vs
// batched расположение вызовов aiCall), когда удастся изолировать
// generateClassroom от тяжёлых зависимостей (model resolver, persistence,
// progress callback и т.д.). Сейчас интеграция проверяется e2e на тест-сервере.

/**
 * Phase 3: context-summary микро-фаза.
 * Один LLM-вызов получает outline всех сцен и возвращает короткий summary
 * (1–2 предложения) для каждой: что было раньше, ключевая идея, что будет
 * дальше. Эти summaries прокидываются в `outline.description` перед параллельной
 * генерацией сцены, чтобы соседние сцены не повторялись и сохраняли нарратив.
 *
 * При любой ошибке/частичном ответе возвращается массив пустых строк той же
 * длины, что outlines — фолбэк, чтобы не блокировать пайплайн.
 */
async function generateSceneContextSummaries(
  outlines: SceneOutline[],
  aiCall: AICallFn,
): Promise<string[]> {
  if (outlines.length === 0) return [];
  const fallback = outlines.map(() => '');

  const systemPrompt =
    'You are an instructional designer producing tiny context briefs for ' +
    'each scene of a lesson, so independent writers can keep narrative ' +
    'continuity. Respond with valid JSON only, no commentary, no markdown.';

  const outlineList = outlines
    .map(
      (o, i) =>
        `${i + 1}. [${o.type}] ${o.title} — ${o.description || ''}`.trim(),
    )
    .join('\n');

  const userPrompt = `Below is the outline of ${outlines.length} lesson scenes.
For EACH scene produce a 1–2 sentence summary capturing:
- What was covered in the earlier scenes (so this scene won't repeat it)
- The key idea of THIS scene
- What comes next (so this scene can foreshadow it)

Outline:
${outlineList}

Return JSON of the form:
{"summaries":[{"index":1,"summary":"..."},{"index":2,"summary":"..."}]}
Indexes are 1-based and must cover every scene.`;

  let raw: string;
  try {
    raw = await aiCall(systemPrompt, userPrompt);
  } catch (err) {
    log.warn('Context-summary phase: LLM call failed, using empty summaries:', err);
    return fallback;
  }

  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  try {
    const parsed = JSON.parse(cleaned) as {
      summaries?: Array<{ index?: number; summary?: string }>;
    };
    const list = Array.isArray(parsed.summaries) ? parsed.summaries : [];
    const out = [...fallback];
    for (const entry of list) {
      const idx = typeof entry.index === 'number' ? entry.index - 1 : -1;
      if (idx >= 0 && idx < out.length && typeof entry.summary === 'string') {
        out[idx] = entry.summary.trim();
      }
    }
    const filled = out.filter((s) => s.length > 0).length;
    if (filled < outlines.length) {
      log.warn(
        `Context-summary phase: got ${filled}/${outlines.length} summaries, missing ones default to empty`,
      );
    } else {
      log.info(`Context-summary phase: produced ${filled} summaries`);
    }
    return out;
  } catch (err) {
    log.warn('Context-summary phase: failed to parse JSON, using empty summaries:', err);
    return fallback;
  }
}

/**
 * Phase 3: пометка ошибки rate-limit / quota / 429.
 * Не делаем ничего экзотического — просто матчим строкой.
 */
function isRateLimitError(err: unknown): boolean {
  if (!err) return false;
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('429') ||
    msg.includes('resource_exhausted') ||
    msg.includes('rate limit') ||
    msg.includes('rate-limit') ||
    msg.includes('too many requests') ||
    msg.includes('quota')
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Phase 3: вмерживание context-summary в outline. Минимально-инвазивно —
 * расширяем поле `description`, которое уже прокидывается во все
 * scene-content промпты (см. scene-generator.ts).
 */
function withContextSummary(outline: SceneOutline, summary: string): SceneOutline {
  if (!summary) return outline;
  const prefix = `Context (neighbour scenes): ${summary}`;
  const merged = outline.description
    ? `${outline.description}\n\n${prefix}`
    : prefix;
  return { ...outline, description: merged };
}

export async function generateClassroom(
  input: GenerateClassroomInput,
  options: {
    baseUrl: string;
    onProgress?: (progress: ClassroomGenerationProgress) => Promise<void> | void;
  },
): Promise<GenerateClassroomResult> {
  const { requirement, pdfContent } = input;

  // Stage timings: каждая фаза замеряется через Date.now(); если фаза
  // пропущена/обвалилась — поле остаётся null.
  const pipelineStartedAt = Date.now();
  let outlineMs: number | null = null;
  let scenesMs: number | null = null;
  let mediaMs: number | null = null;
  let ttsMs: number | null = null;
  let ttsActionsCount: number | null = null;
  let ttsProviderUsed: string | null = null;
  const scenesBreakdown: SceneTimingEntry[] = [];

  await options.onProgress?.({
    step: 'initializing',
    progress: 5,
    message: 'Initializing classroom generation',
    scenesGenerated: 0,
  });

  const { model: languageModel, modelInfo, modelString } = resolveModel({ modelString: input.modelString });
  log.info(`Using server-configured model: ${modelString}`);

  // Fail fast if the resolved provider has no API key configured
  const { providerId } = parseModelString(modelString);
  const apiKey = resolveApiKey(providerId);
  if (!apiKey) {
    throw new Error(
      `No API key configured for provider "${providerId}". ` +
        `Set the appropriate key in .env.local or server-providers.yml (e.g. ${providerId.toUpperCase()}_API_KEY).`,
    );
  }

  const generationProfile = normalizeGenerationProfile(input.generationProfile);

  const aiCall: AICallFn = async (systemPrompt, userPrompt, _images) => {
    const result = await callLLM(
      {
        model: languageModel,
        messages: [
          {
            role: 'system',
            content: applyGenerationProfilePlaceholders(systemPrompt, generationProfile),
          },
          {
            role: 'user',
            content: applyGenerationProfilePlaceholders(userPrompt, generationProfile),
          },
        ],
        maxOutputTokens: modelInfo?.outputWindow,
      },
      'generate-classroom',
    );
    return result.text;
  };

  const lang = normalizeLanguage(input.language);
  const requirements: UserRequirements = {
    requirement,
    language: lang,
  };
  const pdfText = pdfContent?.text || undefined;

  // Resolve agents based on agentMode
  let agents: AgentInfo[];
  const agentMode = input.agentMode || 'default';
  if (agentMode === 'generate') {
    log.info('Generating custom agent profiles via LLM...');
    try {
      agents = await generateAgentProfiles(requirement, lang, aiCall);
      log.info(`Generated ${agents.length} agent profiles`);
    } catch (e) {
      log.warn('Agent profile generation failed, falling back to defaults:', e);
      agents = getDefaultAgents();
    }
  } else {
    agents = getDefaultAgents();
  }
  const teacherContext = formatTeacherPersonaForPrompt(agents);

  await options.onProgress?.({
    step: 'researching',
    progress: 10,
    message: 'Researching topic',
    scenesGenerated: 0,
  });

  // Web search (optional, graceful degradation)
  let researchContext: string | undefined;
  if (input.enableWebSearch) {
    const tavilyKey = resolveWebSearchApiKey();
    if (tavilyKey) {
      try {
        log.info('Running web search for requirement context...');
        const searchResult = await searchWithTavily({ query: requirement, apiKey: tavilyKey });
        researchContext = formatSearchResultsAsContext(searchResult);
        if (researchContext) {
          log.info(`Web search returned ${searchResult.sources.length} sources`);
        }
      } catch (e) {
        log.warn('Web search failed, continuing without search context:', e);
      }
    } else {
      log.warn('enableWebSearch is true but no Tavily API key configured, skipping web search');
    }
  }

  await options.onProgress?.({
    step: 'generating_outlines',
    progress: 15,
    message: 'Generating scene outlines',
    scenesGenerated: 0,
  });

  const outlinePhaseStart = Date.now();
  const outlinesResult = await generateSceneOutlinesFromRequirements(
    requirements,
    pdfText,
    undefined,
    aiCall,
    undefined,
    {
      imageGenerationEnabled: input.enableImageGeneration,
      videoGenerationEnabled: input.enableVideoGeneration,
      researchContext,
      teacherContext,
    },
  );
  outlineMs = Date.now() - outlinePhaseStart;

  if (!outlinesResult.success || !outlinesResult.data) {
    log.error('Failed to generate outlines:', outlinesResult.error);
    throw new Error(outlinesResult.error || 'Failed to generate scene outlines');
  }

  const outlines = outlinesResult.data;
  log.info(`Generated ${outlines.length} scene outlines`);

  await options.onProgress?.({
    step: 'generating_outlines',
    progress: 30,
    message: `Generated ${outlines.length} scene outlines`,
    scenesGenerated: 0,
    totalScenes: outlines.length,
  });

  const stageId = nanoid(10);
  const stage: Stage = {
    id: stageId,
    name: outlines[0]?.title || requirement.slice(0, 50),
    description: undefined,
    language: lang,
    style: 'interactive',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const store = createInMemoryStore(stage);
  const api = createStageAPI(store);

  log.info('Stage 2: Generating scene content and actions...');
  let generatedScenes = 0;
  const outlineBySceneId = new Map<string, SceneOutline>();
  const scenesPhaseStart = Date.now();

  /**
   * Per-scene work: prep outline → content → actions. Returns the timings
   * tuple OR null on failure so the caller can decide whether to skip / log.
   * Does NOT touch the shared store — каллер сериализует это под одним
   * await'ом, чтобы избежать гонки в createSceneWithActions.
   */
  type SceneWorkResult = {
    safeOutline: SceneOutline;
    content: NonNullable<Awaited<ReturnType<typeof generateSceneContent>>>;
    actions: Awaited<ReturnType<typeof generateSceneActions>>;
    ms: number;
  };
  const runSceneWork = async (
    outline: SceneOutline,
    summary: string,
  ): Promise<SceneWorkResult | null> => {
    const sceneStart = Date.now();
    const safeOutline = applyOutlineFallbacks(
      withContextSummary(outline, summary),
      true,
    );
    const content = await generateSceneContent(
      safeOutline,
      aiCall,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      agents,
    );
    if (!content) {
      log.warn(`Skipping scene "${safeOutline.title}" — content generation failed`);
      return null;
    }
    const actions = await generateSceneActions(safeOutline, content, aiCall, undefined, agents);
    return { safeOutline, content, actions, ms: Date.now() - sceneStart };
  };

  const commitScene = (
    index: number,
    result: SceneWorkResult,
  ): void => {
    log.info(`Scene "${result.safeOutline.title}": ${result.actions.length} actions`);
    const sceneId = createSceneWithActions(
      result.safeOutline,
      result.content,
      result.actions,
      api,
    );
    if (!sceneId) {
      log.warn(`Skipping scene "${result.safeOutline.title}" — scene creation failed`);
      return;
    }
    outlineBySceneId.set(sceneId, result.safeOutline);
    generatedScenes += 1;
    scenesBreakdown.push({
      sceneIndex: index,
      title: result.safeOutline.title,
      ms: result.ms,
    });
  };

  if (input.parallelMode) {
    const concurrency = Math.max(1, Math.min(8, input.parallelConcurrency ?? 2));
    log.info(`Stage 2 (parallel): batches of ${concurrency}`);

    // Context-summary микро-фаза перед параллелью.
    const summaries = await generateSceneContextSummaries(outlines, aiCall);

    for (let i = 0; i < outlines.length; i += concurrency) {
      const batch = outlines.slice(i, i + concurrency);
      const batchSummaries = summaries.slice(i, i + concurrency);

      await options.onProgress?.({
        step: 'generating_scenes',
        progress: Math.max(
          30 + Math.floor((i / Math.max(outlines.length, 1)) * 60),
          31,
        ),
        message: `Generating scenes ${i + 1}-${Math.min(i + concurrency, outlines.length)}/${outlines.length} (parallel)`,
        scenesGenerated: generatedScenes,
        totalScenes: outlines.length,
      });

      // Exp-backoff retry на 429: до 2 повторов всего батча целиком.
      let attempt = 0;
      let results: PromiseSettledResult<SceneWorkResult | null>[] = [];
      while (attempt <= 2) {
        results = await Promise.allSettled(
          batch.map((outline, idx) => runSceneWork(outline, batchSummaries[idx] ?? '')),
        );
        const has429 = results.some(
          (r) => r.status === 'rejected' && isRateLimitError(r.reason),
        );
        if (!has429 || attempt === 2) break;
        const delay = 2 ** (attempt + 1) * 1000;
        log.warn(
          `Parallel batch hit rate limit, retry ${attempt + 1}/2 after ${delay}ms`,
        );
        await sleep(delay);
        attempt += 1;
      }

      for (let idx = 0; idx < results.length; idx++) {
        const r = results[idx];
        const globalIndex = i + idx;
        if (r.status === 'fulfilled' && r.value) {
          commitScene(globalIndex, r.value);
        } else if (r.status === 'rejected') {
          log.warn(
            `Scene ${globalIndex + 1} failed in parallel batch: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
          );
        }
      }

      const progressEnd = 30 + Math.floor(
        (Math.min(i + concurrency, outlines.length) / Math.max(outlines.length, 1)) * 60,
      );
      await options.onProgress?.({
        step: 'generating_scenes',
        progress: Math.min(progressEnd, 90),
        message: `Generated ${generatedScenes}/${outlines.length} scenes`,
        scenesGenerated: generatedScenes,
        totalScenes: outlines.length,
      });
    }
  } else {
    for (const [index, outline] of outlines.entries()) {
      const progressStart = 30 + Math.floor((index / Math.max(outlines.length, 1)) * 60);
      await options.onProgress?.({
        step: 'generating_scenes',
        progress: Math.max(progressStart, 31),
        message: `Generating scene ${index + 1}/${outlines.length}: ${outline.title}`,
        scenesGenerated: generatedScenes,
        totalScenes: outlines.length,
      });

      const result = await runSceneWork(outline, '');
      if (result) commitScene(index, result);

      const progressEnd = 30 + Math.floor(((index + 1) / Math.max(outlines.length, 1)) * 60);
      await options.onProgress?.({
        step: 'generating_scenes',
        progress: Math.min(progressEnd, 90),
        message: `Generated ${generatedScenes}/${outlines.length} scenes`,
        scenesGenerated: generatedScenes,
        totalScenes: outlines.length,
      });
    }
  }
  scenesMs = Date.now() - scenesPhaseStart;

  const scenes = store.getState().scenes;
  log.info(`Pipeline complete: ${scenes.length} scenes generated`);

  if (scenes.length === 0) {
    throw new Error('No scenes were generated');
  }

  // Manifest accumulates per-asset metadata across media + (future) TTS phases.
  // Built up in-place by generateMediaForClassroom and persisted at the end.
  const manifest = createClassroomManifest();

  // Phase: Media generation (after all scenes generated)
  if (input.enableImageGeneration || input.enableVideoGeneration) {
    await options.onProgress?.({
      step: 'generating_media',
      progress: 90,
      message: 'Generating media files',
      scenesGenerated: scenes.length,
      totalScenes: outlines.length,
    });

    const mediaPhaseStart = Date.now();
    try {
      const mediaMap = await generateMediaForClassroom(outlines, stageId, options.baseUrl, manifest);
      replaceMediaPlaceholders(scenes, mediaMap);
      const aspectCorrections = await correctGeneratedImageAspectRatios(scenes, stageId);
      const removedMedia = removeUnresolvedMediaPlaceholders(scenes);
      const mediaFallbackRewrites = await regenerateScenesWithoutRemovedMedia(
        scenes,
        removedMedia,
        outlineBySceneId,
        aiCall,
        agents,
      );
      const speechCleanups = removeSpeechVisualReferencesForRemovedMedia(scenes, removedMedia);
      const removed = removedMedia.length;
      log.info(
        `Media generation complete: ${Object.keys(mediaMap).length} files${removed > 0 ? `, ${removed} unresolved placeholder(s) removed` : ''}${aspectCorrections > 0 ? `, ${aspectCorrections} image aspect correction(s)` : ''}${mediaFallbackRewrites > 0 ? `, ${mediaFallbackRewrites} media fallback rewrite(s)` : ''}${speechCleanups > 0 ? `, ${speechCleanups} speech visual reference cleanup(s)` : ''}`,
      );
    } catch (err) {
      log.warn('Media generation phase failed, continuing:', err);
    }
    mediaMs = Date.now() - mediaPhaseStart;
  }

  // Phase: TTS generation
  if (input.enableTTS) {
    await options.onProgress?.({
      step: 'generating_tts',
      progress: 94,
      message: 'Generating TTS audio',
      scenesGenerated: scenes.length,
      totalScenes: outlines.length,
    });

    const ttsPhaseStart = Date.now();
    try {
      const teacher = agents.find(a => a.role === 'teacher');
      const ttsStats = await generateTTSForClassroom(scenes, stageId, options.baseUrl, teacher?.name);
      ttsActionsCount = ttsStats.count;
      ttsProviderUsed = ttsStats.providerId;
      log.info('TTS generation complete');
    } catch (err) {
      log.warn('TTS generation phase failed, continuing:', err);
    }
    ttsMs = Date.now() - ttsPhaseStart;
  }

  await options.onProgress?.({
    step: 'persisting',
    progress: 98,
    message: 'Persisting classroom data',
    scenesGenerated: scenes.length,
    totalScenes: outlines.length,
  });

  const persisted = await persistClassroom(
    {
      id: stageId,
      stage,
      scenes,
      manifest,
    },
    options.baseUrl,
  );

  log.info(`Classroom persisted: ${persisted.id}, URL: ${persisted.url}`);

  await options.onProgress?.({
    step: 'completed',
    progress: 100,
    message: 'Classroom generation completed',
    scenesGenerated: scenes.length,
    totalScenes: outlines.length,
  });

  const totalMs = Date.now() - pipelineStartedAt;

  // TODO(phase-1): резолвить tts_provider/profile из конфига профиля генерации.
  // Сейчас tts_provider — что фактически отстрелял TTS-проход (gemini-tts/edge-tts),
  // либо null, если TTS был выключен/упал.
  const timings: GenerationTimings = {
    outline_ms: outlineMs,
    scenes_ms: scenesMs,
    media_ms: mediaMs,
    tts_ms: ttsMs,
    total_ms: totalMs,
    tts_actions_count: ttsActionsCount,
    scenes_breakdown: scenesBreakdown.length > 0 ? scenesBreakdown : null,
  };

  const config: GenerationConfigSnapshot = {
    profile: generationProfile.name,
    parallel_enabled: Boolean(input.parallelMode),
    parallel_concurrency: input.parallelMode
      ? Math.max(1, Math.min(8, input.parallelConcurrency ?? 2))
      : null,
    tts_provider: ttsProviderUsed ?? (input.enableTTS ? 'gemini-tts' : null),
  };

  return {
    id: persisted.id,
    url: persisted.url,
    stage,
    scenes,
    scenesCount: scenes.length,
    createdAt: persisted.createdAt,
    timings,
    config,
  };
}
