/**
 * Widget iframe messaging store (Phase 7.3a baseline).
 *
 * Adapted from upstream commit c02a607. Tracks per-scene `sendMessage`
 * callbacks that the InteractiveRenderer registers when its iframe
 * mounts. The ActionEngine (or any orchestration layer) reads back the
 * callback for the *currently active* scene to deliver TeacherActions.
 *
 * Why per-scene (not a global singleton): scene transitions can race —
 * a stale unmount handler from scene N might null-out the callback for
 * scene N+1 if everything were keyed under one slot. Per-scene keying
 * guarantees the unmount of scene N only clears scene N's entry.
 *
 * NOTE on embedded osvaivai compatibility: this store handles ONLY the
 * player-to-widget direction. Widget-to-player messages are handled by
 * the InteractiveRenderer's `message` event listener, which forwards
 * relevant events to `playerBridge` for cross-frame propagation to the
 * osvaivai parent (lessonEnded, etc.).
 */

import { create } from 'zustand';

export type WidgetSendMessage = (type: string, payload: Record<string, unknown>) => void;

interface WidgetIframeState {
  /** Callbacks keyed by sceneId for targeted postMessage communication */
  sendMessageByScene: Record<string, WidgetSendMessage>;
  /** Currently active scene ID (used as fallback when sceneId is omitted) */
  activeSceneId: string | null;
  /** Register an iframe callback for a specific scene; pass null to unregister */
  registerIframe: (sceneId: string, callback: WidgetSendMessage | null) => void;
  /** Set the active scene ID (called when player switches scenes) */
  setActiveScene: (sceneId: string | null) => void;
  /** Get sendMessage callback for a specific scene (or current active scene) */
  getSendMessage: (sceneId?: string) => WidgetSendMessage | null;
}

export const useWidgetIframeStore = create<WidgetIframeState>((set, get) => ({
  sendMessageByScene: {},
  activeSceneId: null,
  registerIframe: (sceneId, callback) =>
    set((state) => {
      if (callback === null) {
        const updated = { ...state.sendMessageByScene };
        delete updated[sceneId];
        return { sendMessageByScene: updated };
      }
      return {
        sendMessageByScene: { ...state.sendMessageByScene, [sceneId]: callback },
      };
    }),
  setActiveScene: (sceneId) => set({ activeSceneId: sceneId }),
  getSendMessage: (sceneId) => {
    const state = get();
    const targetId = sceneId ?? state.activeSceneId;
    if (!targetId) return null;
    return state.sendMessageByScene[targetId] ?? null;
  },
}));
