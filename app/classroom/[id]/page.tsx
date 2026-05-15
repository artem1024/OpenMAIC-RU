'use client';

import { Stage } from '@/components/stage';
import { ThemeProvider } from '@/lib/hooks/use-theme';
import { useStageStore } from '@/lib/store';
import { loadImageMapping } from '@/lib/utils/image-storage';
import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { useSceneGenerator } from '@/lib/hooks/use-scene-generator';
import { useSettingsStore } from '@/lib/store/settings';
import { useMediaGenerationStore } from '@/lib/store/media-generation';
import { useWhiteboardHistoryStore } from '@/lib/store/whiteboard-history';
import { createLogger } from '@/lib/logger';
import { MediaStageProvider } from '@/lib/contexts/media-stage-context';
import { generateMediaForOutlines } from '@/lib/media/media-orchestrator';

const log = createLogger('Classroom');

export default function ClassroomDetailPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const isEmbedded = searchParams?.get('embedded') === '1';
  const isMobileParam = searchParams?.get('mobile') === '1';
  const classroomId = params?.id as string;

  // Tap-to-start overlay: iOS Safari requires a user gesture before any
  // audio.play() succeeds. In embedded+mobile mode we force TTS on (below),
  // so without an explicit tap the first TTS fragment would silently fail.
  // Show the overlay once per page-load; the tap unlocks Web Audio for the
  // rest of the session.
  const [needsTapToStart, setNeedsTapToStart] = useState(isEmbedded && isMobileParam);

  const { loadFromStorage } = useStageStore();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const generationStartedRef = useRef(false);

  const { generateRemaining, retrySingleOutline, stop } = useSceneGenerator({
    onComplete: () => {
      log.info('[Classroom] All scenes generated');
    },
  });

  const loadClassroom = useCallback(async () => {
    try {
      await loadFromStorage(classroomId);

      // If IndexedDB had no data, try server-side storage (API-generated classrooms)
      if (!useStageStore.getState().stage) {
        log.info('No IndexedDB data, trying server-side storage for:', classroomId);
        try {
          const res = await fetch(`/api/classroom?id=${encodeURIComponent(classroomId)}`);
          if (res.ok) {
            const json = await res.json();
            if (json.success && json.classroom) {
              const { stage, scenes } = json.classroom;
              useStageStore.getState().setStage(stage);
              useStageStore.setState({
                scenes,
                currentSceneId: scenes[0]?.id ?? null,
              });
              log.info('Loaded from server-side storage:', classroomId);
            }
          }
        } catch (fetchErr) {
          log.warn('Server-side storage fetch failed:', fetchErr);
        }
      }

      // Restore completed media generation tasks from IndexedDB
      await useMediaGenerationStore.getState().restoreFromDB(classroomId);
      // Restore generated agents for this stage
      const { loadGeneratedAgentsForStage } = await import('@/lib/orchestration/registry/store');
      const agentIds = await loadGeneratedAgentsForStage(classroomId);
      if (agentIds.length > 0) {
        const { useSettingsStore } = await import('@/lib/store/settings');
        useSettingsStore.getState().setSelectedAgentIds(agentIds);
      }
    } catch (error) {
      log.error('Failed to load classroom:', error);
      setError(error instanceof Error ? error.message : 'Failed to load classroom');
    } finally {
      setLoading(false);
    }
  }, [classroomId, loadFromStorage]);

  // In embedded mode (vitrine iframe), force TTS enabled and unmuted
  // so students always hear audio regardless of previously saved settings
  useEffect(() => {
    if (isEmbedded) {
      const settings = useSettingsStore.getState();
      if (!settings.ttsEnabled) settings.setTTSEnabled(true);
      if (settings.ttsMuted) settings.setTTSMuted(false);
      if (settings.ttsVolume < 0.3) settings.setTTSVolume(1);
    }
  }, [isEmbedded]);

  useEffect(() => {
    // Reset loading state on course switch to unmount Stage during transition,
    // preventing stale data from syncing back to the new course
    setLoading(true);
    setError(null);
    generationStartedRef.current = false;

    // Clear previous classroom's media tasks to prevent cross-classroom contamination.
    // Placeholder IDs (gen_img_1, gen_vid_1) are NOT globally unique across stages,
    // so stale tasks from a previous classroom would shadow the new one's.
    const mediaStore = useMediaGenerationStore.getState();
    mediaStore.revokeObjectUrls();
    useMediaGenerationStore.setState({ tasks: {} });

    // Clear whiteboard history to prevent snapshots from a previous course leaking in.
    useWhiteboardHistoryStore.getState().clearHistory();

    loadClassroom();

    // Cancel ongoing generation when classroomId changes or component unmounts
    return () => {
      stop();
    };
  }, [classroomId, loadClassroom, stop]);

  // Auto-resume generation for pending outlines
  useEffect(() => {
    if (loading || error || generationStartedRef.current) return;

    const state = useStageStore.getState();
    const { outlines, scenes, stage } = state;

    // Check if there are pending outlines
    const completedOrders = new Set(scenes.map((s) => s.order));
    const hasPending = outlines.some((o) => !completedOrders.has(o.order));

    if (hasPending && stage) {
      generationStartedRef.current = true;

      // Load generation params from sessionStorage (stored by generation-preview before navigating)
      const genParamsStr = sessionStorage.getItem('generationParams');
      const params = genParamsStr ? JSON.parse(genParamsStr) : {};

      // Reconstruct imageMapping from IndexedDB using pdfImages storageIds
      const storageIds = (params.pdfImages || [])
        .map((img: { storageId?: string }) => img.storageId)
        .filter(Boolean);

      loadImageMapping(storageIds).then((imageMapping) => {
        generateRemaining({
          pdfImages: params.pdfImages,
          imageMapping,
          stageInfo: {
            name: stage.name || '',
            description: stage.description,
            language: stage.language,
            style: stage.style,
          },
          agents: params.agents,
          userProfile: params.userProfile,
        });
      });
    } else if (outlines.length > 0 && stage) {
      // All scenes are generated, but some media may not have finished.
      // Resume media generation for any tasks not yet in IndexedDB.
      // generateMediaForOutlines skips already-completed tasks automatically.
      generationStartedRef.current = true;
      generateMediaForOutlines(outlines, stage.id).catch((err) => {
        log.warn('[Classroom] Media generation resume error:', err);
      });
    }
  }, [loading, error, generateRemaining]);

  return (
    <ThemeProvider>
      <MediaStageProvider value={classroomId}>
        <div
          className="relative h-[100dvh] flex flex-col overflow-hidden touch-manipulation"
          style={{ touchAction: 'manipulation' }}
        >
          {loading ? (
            <div className="flex-1 flex items-center justify-center bg-gray-50 dark:bg-gray-900">
              <div className="text-center text-muted-foreground">
                <p>Loading classroom...</p>
              </div>
            </div>
          ) : error ? (
            <div className="flex-1 flex items-center justify-center bg-gray-50 dark:bg-gray-900">
              <div className="text-center">
                <p className="text-destructive mb-4">Error: {error}</p>
                <button
                  onClick={() => {
                    setError(null);
                    setLoading(true);
                    loadClassroom();
                  }}
                  className="px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
                >
                  Retry
                </button>
              </div>
            </div>
          ) : (
            <Stage onRetryOutline={retrySingleOutline} />
          )}

          {needsTapToStart && !loading && !error && (
            <TapToStartOverlay onTap={() => setNeedsTapToStart(false)} />
          )}
        </div>
      </MediaStageProvider>
    </ThemeProvider>
  );
}

/**
 * Polupröżnyj overlay for mobile-embedded sessions: a single tap unlocks
 * iOS Safari's audio autoplay restriction by playing a near-silent audio
 * blob inside the user-gesture callback and resuming an AudioContext.
 */
function TapToStartOverlay({ onTap }: { onTap: () => void }) {
  const handleTap = useCallback(() => {
    // 1. Resume AudioContext so Web Audio API works for the rest of the session.
    try {
      const Ctx =
        (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (Ctx) {
        const ctx = new Ctx();
        if (ctx.state === 'suspended') {
          void ctx.resume();
        }
      }
    } catch {
      // ignore — AudioContext not critical for HTMLAudioElement playback
    }

    // 2. Prime an HTMLAudioElement with a tiny silent mp3 — this is the
    // gesture iOS Safari remembers for subsequent audio.play() calls.
    try {
      const silentMp3 =
        'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQxAADB8AhSmxhIIEVCSiJrDCQBTcu3UrAIwUdkRgQbFAZC1CQEwTJ9mjRvBA4UOLD8nKVOWfh+UlK3z/177OXrfOdKl7097v///////zU/+5cQuOVihgKKAAAAA//sUZAAP8AAAaQAAAAgAAA0gAAABAAABpAAAACAAADSAAAAETEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV';
      const audio = new Audio(silentMp3);
      audio.volume = 0;
      audio.play().catch(() => {
        // Even if it fails, the gesture itself counts — proceed.
      });
    } catch {
      // ignore
    }

    onTap();
  }, [onTap]);

  return (
    <div
      onClick={handleTap}
      onTouchEnd={(e) => {
        // Prevent ghost click and ensure the gesture fires inside the touch handler.
        e.preventDefault();
        handleTap();
      }}
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm cursor-pointer select-none"
      role="button"
      tabIndex={0}
      aria-label="Нажмите, чтобы начать урок"
    >
      <div className="flex flex-col items-center gap-3 px-6 py-5 rounded-2xl bg-white/95 text-gray-900 shadow-xl">
        <div className="w-14 h-14 rounded-full bg-gradient-to-br from-cyan-500 to-emerald-500 flex items-center justify-center">
          <svg className="w-7 h-7 text-white ml-0.5" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
        </div>
        <div className="text-base font-semibold">Нажмите, чтобы начать урок</div>
      </div>
    </div>
  );
}
