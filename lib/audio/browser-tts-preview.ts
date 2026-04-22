'use client';

const VOICES_LOAD_TIMEOUT_MS = 2000;
const PREVIEW_TIMEOUT_MS = 30000;
const CJK_LANG_THRESHOLD = 0.3;

type PlayBrowserTTSPreviewOptions = {
  text: string;
  voice?: string;
  rate?: number;
  voices?: SpeechSynthesisVoice[];
};

function createAbortError(): Error {
  const error = new Error('Browser TTS preview canceled');
  error.name = 'AbortError';
  return error;
}

function inferPreviewLang(text: string): string {
  if (text.length === 0) return 'ru-RU';
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  const cyrillicCount = (text.match(/[\u0400-\u04ff]/g) || []).length;
  const cjkRatio = cjkCount / text.length;
  const cyrillicRatio = cyrillicCount / text.length;
  if (cjkRatio > CJK_LANG_THRESHOLD) return 'zh-CN';
  if (cyrillicRatio > 0.2) return 'ru-RU';
  return 'en-US';
}

export function isBrowserTTSAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** Wait for browser voices to load, with a 2s timeout fallback. */
export async function ensureVoicesLoaded(): Promise<SpeechSynthesisVoice[]> {
  if (typeof window === 'undefined' || !window.speechSynthesis) {
    return [];
  }

  const initialVoices = window.speechSynthesis.getVoices();
  if (initialVoices.length > 0) {
    return initialVoices;
  }

  return new Promise<SpeechSynthesisVoice[]>((resolve) => {
    let settled = false;
    let timeoutId: number | null = null;

    const cleanup = () => {
      window.speechSynthesis.removeEventListener('voiceschanged', handleVoicesChanged);
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(window.speechSynthesis.getVoices());
    };

    const handleVoicesChanged = () => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length > 0) {
        finish();
      }
    };

    window.speechSynthesis.addEventListener('voiceschanged', handleVoicesChanged);
    timeoutId = window.setTimeout(finish, VOICES_LOAD_TIMEOUT_MS);
  });
}

/** Resolve a browser voice by voiceURI, name, or lang, with language fallback by text. */
export function resolveBrowserVoice(
  voices: SpeechSynthesisVoice[],
  voiceNameOrLang: string,
  text: string,
): { voice: SpeechSynthesisVoice | null; lang: string } {
  const target = voiceNameOrLang.trim();
  const matchedVoice =
    target && target !== 'default'
      ? voices.find(
          (voice) => voice.voiceURI === target || voice.name === target || voice.lang === target,
        ) || null
      : null;

  return {
    voice: matchedVoice,
    lang: matchedVoice?.lang || inferPreviewLang(text),
  };
}

/**
 * Play a short browser-native TTS preview.
 *
 * Notes:
 * - Uses the global speechSynthesis queue, so it must cancel queued utterances
 *   before starting a new preview.
 * - Resolves only after the utterance has started and then ended successfully.
 */
export function playBrowserTTSPreview(options: PlayBrowserTTSPreviewOptions): {
  promise: Promise<void>;
  cancel: () => void;
} {
  // [osvaivai:no-browser-tts] DO NOT RE-ENABLE — 2026-04-21
  // Браузерный Web Speech API в этом форке запрещён: для русского языка
  // звучит как неразборчивая мужская каша и исторически перебивал нормальную
  // Gemini Aoede-озвучку (см. lib/playback/engine.ts и memory/feedback_tts_voice.md).
  // Превью в настройках ttsProviderId='browser-native-tts' должно сразу
  // отказать с осмысленным сообщением, а не выходить на synth.speak().
  // Тело функции удалено; реализацию можно восстановить из git history
  // (коммит 48be5f9 или ранее — искать SpeechSynthesisUtterance).
  void options;
  return {
    promise: Promise.reject(
      new Error(
        'Browser-native TTS disabled in this build — use Gemini TTS (provider "gemini-tts") instead',
      ),
    ),
    cancel: () => {},
  };
}
