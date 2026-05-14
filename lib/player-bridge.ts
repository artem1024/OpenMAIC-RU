/**
 * Мост прогресс-событий к родительскому окну при работе в iframe.
 *
 * Используется osvaivai PlayerPage для отслеживания прохождения уроков.
 * Если OpenMAIC-RU открыт не в iframe или NEXT_PUBLIC_PARENT_ORIGINS пуст —
 * no-op, standalone-режим не затрагивается.
 *
 * Формат всех сообщений:
 *   { source: "openmaic", type: "...", ...payload }
 * Родитель фильтрует по `event.source === iframeWindow && data.source === "openmaic"`.
 */

const CONFIGURED_ORIGINS = (process.env.NEXT_PUBLIC_PARENT_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

// Время начала урока: фиксируем на первом scene:change (когда открыт первый
// слайд). Используется для вычисления completion_time в lesson:end / lesson:complete.
let lessonStartedAtMs: number | null = null;

function ensureLessonStart(): void {
  if (lessonStartedAtMs == null) lessonStartedAtMs = Date.now();
}

function post(type: string, payload: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  if (window.parent === window) return; // не в iframe
  // Если whitelist задан — используем его; иначе same-origin fallback.
  // На osvaivai iframe проксируется через reverse-proxy по тому же origin,
  // что и родитель, поэтому window.location.origin = целевой origin.
  const origins = CONFIGURED_ORIGINS.length > 0 ? CONFIGURED_ORIGINS : [window.location.origin];
  const message = { source: 'openmaic', type, ...payload };
  for (const origin of origins) {
    try {
      window.parent.postMessage(message, origin);
    } catch {
      // нестрого: один неудачный origin не должен ломать цикл
    }
  }
}

export const playerBridge = {
  sceneChanged(sceneIndex: number, sceneId: string, totalScenes: number): void {
    ensureLessonStart();
    post('scene:change', { sceneIndex, sceneId, totalScenes });
  },

  quizAnswered(sceneId: string, correct: number, total: number): void {
    post('quiz:answer', { sceneId, correct, total });
  },

  /**
   * Эмитит `lesson:end` (исторический канал, родительский osvaivai PlayerPage уже его
   * слушает) и дублирует `lesson:complete` (upstream-стиль, для будущих интеграций).
   *
   * Обратно-совместимые поля: totalScenes, lastSceneType, correct, total.
   * Новые опциональные поля (Phase 7.2 / upstream #11):
   *   - completion_time: миллисекунды с первого scene:change (≈ время от открытия
   *     первого слайда до завершения). Если first scene:change не зафиксирован —
   *     поле отсутствует.
   *   - quiz_score: 0..1, доля верных ответов (correct/total) в финальном quiz-блоке.
   *     Если total === 0 — отсутствует.
   *
   * Все новые поля опциональны: старые consumers (osvaivai PlayerPage::lesson:end)
   * продолжают работать без изменений.
   */
  lessonEnded(payload: {
    totalScenes: number;
    lastSceneType?: string;
    correct?: number;
    total?: number;
  }): void {
    const enriched: Record<string, unknown> = { ...payload };
    if (lessonStartedAtMs != null) {
      enriched.completion_time = Date.now() - lessonStartedAtMs;
    }
    if (typeof payload.total === 'number' && payload.total > 0) {
      enriched.quiz_score = (payload.correct ?? 0) / payload.total;
    }
    post('lesson:end', enriched);
    // Дубль upstream-имени события — родителю достаточно слушать любое одно.
    post('lesson:complete', enriched);
  },
};
