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
    post('scene:change', { sceneIndex, sceneId, totalScenes });
  },

  quizAnswered(sceneId: string, correct: number, total: number): void {
    post('quiz:answer', { sceneId, correct, total });
  },

  lessonEnded(payload: {
    totalScenes: number;
    lastSceneType?: string;
    correct?: number;
    total?: number;
  }): void {
    post('lesson:end', payload);
  },
};
