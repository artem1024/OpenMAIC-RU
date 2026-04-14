/**
 * TTS (Text-to-Speech) Provider Implementation
 *
 * Factory pattern for routing TTS requests to appropriate provider implementations.
 * Follows the same architecture as lib/ai/providers.ts for consistency.
 *
 * Currently Supported Providers:
 * - OpenAI TTS: https://platform.openai.com/docs/guides/text-to-speech
 * - Azure TTS: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/text-to-speech
 * - GLM TTS: https://docs.bigmodel.cn/cn/guide/models/sound-and-video/glm-tts
 * - Qwen TTS: https://bailian.console.aliyun.com/
 * - ElevenLabs TTS: https://elevenlabs.io/docs/api-reference/text-to-speech/convert
 * - Browser Native: Web Speech API (client-side only)
 *
 * HOW TO ADD A NEW PROVIDER:
 *
 * 1. Add provider ID to TTSProviderId in lib/audio/types.ts
 *    Example: | 'elevenlabs-tts'
 *
 * 2. Add provider configuration to lib/audio/constants.ts
 *    Example:
 *    'elevenlabs-tts': {
 *      id: 'elevenlabs-tts',
 *      name: 'ElevenLabs',
 *      requiresApiKey: true,
 *      defaultBaseUrl: 'https://api.elevenlabs.io/v1',
 *      icon: '/logos/elevenlabs.svg',
 *      voices: [...],
 *      supportedFormats: ['mp3', 'pcm'],
 *      speedRange: { min: 0.5, max: 2.0, default: 1.0 }
 *    }
 *
 * 3. Implement provider function in this file
 *    Pattern: async function generateXxxTTS(config, text): Promise<TTSGenerationResult>
 *    - Validate config and build API request
 *    - Handle API authentication (apiKey, headers)
 *    - Convert provider-specific parameters (voice, speed, format)
 *    - Return { audio: Uint8Array, format: string }
 *
 *    Example:
 *    async function generateElevenLabsTTS(
 *      config: TTSModelConfig,
 *      text: string
 *    ): Promise<TTSGenerationResult> {
 *      const baseUrl = config.baseUrl || TTS_PROVIDERS['elevenlabs-tts'].defaultBaseUrl;
 *
 *      const response = await fetch(`${baseUrl}/text-to-speech/${config.voice}`, {
 *        method: 'POST',
 *        headers: {
 *          'xi-api-key': config.apiKey!,
 *          'Content-Type': 'application/json',
 *        },
 *        body: JSON.stringify({
 *          text,
 *          model_id: 'eleven_multilingual_v2',
 *          voice_settings: {
 *            stability: 0.5,
 *            similarity_boost: 0.75,
 *          }
 *        }),
 *      });
 *
 *      if (!response.ok) {
 *        throw new Error(`ElevenLabs TTS API error: ${response.statusText}`);
 *      }
 *
 *      const arrayBuffer = await response.arrayBuffer();
 *      return {
 *        audio: new Uint8Array(arrayBuffer),
 *        format: 'mp3',
 *      };
 *    }
 *
 * 4. Add case to generateTTS() switch statement
 *    case 'elevenlabs-tts':
 *      return await generateElevenLabsTTS(config, text);
 *
 * 5. Add i18n translations in lib/i18n.ts
 *    providerElevenLabsTTS: { zh: 'ElevenLabs TTS', en: 'ElevenLabs TTS' }
 *
 * Error Handling Patterns:
 * - Always validate API key if requiresApiKey is true
 * - Throw descriptive errors for API failures
 * - Include response.statusText or error messages from API
 * - For client-only providers (browser-native), throw error directing to client-side usage
 *
 * API Call Patterns:
 * - Direct API: Use fetch with appropriate headers and body format (recommended for better encoding support)
 * - SSML: For Azure-like providers requiring SSML markup
 * - URL-based: For providers returning audio URL (download in second step)
 */

import type { TTSModelConfig } from './types';
import { TTS_PROVIDERS, EDGE_TTS_VOICE_BY_GENDER } from './constants';
import { YO_DICTIONARY } from './yo-dictionary';
import { execFile } from 'child_process';
import { readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

/**
 * Result of TTS generation
 */
export interface TTSGenerationResult {
  audio: Uint8Array;
  format: string;
}

/**
 * Generate speech using specified TTS provider
 */
export async function generateTTS(
  config: TTSModelConfig,
  text: string,
): Promise<TTSGenerationResult> {
  const provider = TTS_PROVIDERS[config.providerId];
  if (!provider) {
    throw new Error(`Unknown TTS provider: ${config.providerId}`);
  }

  // Validate API key if required
  if (provider.requiresApiKey && !config.apiKey) {
    throw new Error(`API key required for TTS provider: ${config.providerId}`);
  }

  switch (config.providerId) {
    case 'openai-tts':
      return await generateOpenAITTS(config, text);

    case 'azure-tts':
      return await generateAzureTTS(config, text);

    case 'glm-tts':
      return await generateGLMTTS(config, text);

    case 'qwen-tts':
      return await generateQwenTTS(config, text);

    case 'edge-tts':
      return await generateEdgeTTS(config, text);

    case 'elevenlabs-tts':
      return await generateElevenLabsTTS(config, text);

    case 'browser-native-tts':
      throw new Error(
        'Browser Native TTS must be handled client-side using Web Speech API. This provider cannot be used on the server.',
      );

    default:
      throw new Error(`Unsupported TTS provider: ${config.providerId}`);
  }
}

/**
 * OpenAI TTS implementation (direct API call with explicit UTF-8 encoding)
 */
async function generateOpenAITTS(
  config: TTSModelConfig,
  text: string,
): Promise<TTSGenerationResult> {
  const baseUrl = config.baseUrl || TTS_PROVIDERS['openai-tts'].defaultBaseUrl;

  // Use gpt-4o-mini-tts for best quality and intelligent realtime applications
  const response = await fetch(`${baseUrl}/audio/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      input: text,
      voice: config.voice,
      speed: config.speed || 1.0,
    }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(`OpenAI TTS API error: ${error.error?.message || response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    audio: new Uint8Array(arrayBuffer),
    format: 'mp3',
  };
}

/**
 * Azure TTS implementation (direct API call with SSML)
 */
async function generateAzureTTS(
  config: TTSModelConfig,
  text: string,
): Promise<TTSGenerationResult> {
  const baseUrl = config.baseUrl || TTS_PROVIDERS['azure-tts'].defaultBaseUrl;

  // Build SSML
  const rate = config.speed ? `${((config.speed - 1) * 100).toFixed(0)}%` : '0%';
  const ssml = `
    <speak version='1.0' xml:lang='zh-CN'>
      <voice xml:lang='zh-CN' name='${config.voice}'>
        <prosody rate='${rate}'>${escapeXml(text)}</prosody>
      </voice>
    </speak>
  `.trim();

  const response = await fetch(`${baseUrl}/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': config.apiKey!,
      'Content-Type': 'application/ssml+xml; charset=utf-8',
      'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3',
    },
    body: ssml,
  });

  if (!response.ok) {
    throw new Error(`Azure TTS API error: ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    audio: new Uint8Array(arrayBuffer),
    format: 'mp3',
  };
}

/**
 * GLM TTS implementation (GLM API)
 */
async function generateGLMTTS(config: TTSModelConfig, text: string): Promise<TTSGenerationResult> {
  const baseUrl = config.baseUrl || TTS_PROVIDERS['glm-tts'].defaultBaseUrl;

  const response = await fetch(`${baseUrl}/audio/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      model: 'glm-tts',
      input: text,
      voice: config.voice,
      speed: config.speed || 1.0,
      volume: 1.0,
      response_format: 'wav',
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    let errorMessage = `GLM TTS API error: ${errorText}`;
    try {
      const errorJson = JSON.parse(errorText);
      if (errorJson.error?.message) {
        errorMessage = `GLM TTS API error: ${errorJson.error.message} (code: ${errorJson.error.code})`;
      }
    } catch {
      // If not JSON, use the text as is
    }
    throw new Error(errorMessage);
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    audio: new Uint8Array(arrayBuffer),
    format: 'wav',
  };
}

/**
 * Qwen TTS implementation (DashScope API - Qwen3 TTS Flash)
 */
async function generateQwenTTS(config: TTSModelConfig, text: string): Promise<TTSGenerationResult> {
  const baseUrl = config.baseUrl || TTS_PROVIDERS['qwen-tts'].defaultBaseUrl;

  // Calculate speed: Qwen3 uses rate parameter from -500 to 500
  // speed 1.0 = rate 0, speed 2.0 = rate 500, speed 0.5 = rate -250
  const rate = Math.round(((config.speed || 1.0) - 1.0) * 500);

  const response = await fetch(`${baseUrl}/services/aigc/multimodal-generation/generation`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      model: 'qwen3-tts-flash',
      input: {
        text,
        voice: config.voice,
        language_type: 'Chinese', // Default to Chinese, can be made configurable
      },
      parameters: {
        rate, // Speech rate from -500 to 500
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`Qwen TTS API error: ${errorText}`);
  }

  const data = await response.json();

  // Check for audio URL in response
  if (!data.output?.audio?.url) {
    throw new Error(`Qwen TTS error: No audio URL in response. Response: ${JSON.stringify(data)}`);
  }

  // Download audio from URL
  const audioUrl = data.output.audio.url;
  const audioResponse = await fetch(audioUrl);

  if (!audioResponse.ok) {
    throw new Error(`Failed to download audio from URL: ${audioResponse.statusText}`);
  }

  const arrayBuffer = await audioResponse.arrayBuffer();

  return {
    audio: new Uint8Array(arrayBuffer),
    format: 'wav', // Qwen3 TTS returns WAV format
  };
}

/**
 * Convert number (1–39) to masculine ordinal in the given grammatical case.
 * Returns null for unsupported numbers.
 */
type GramCase = 'nom' | 'gen' | 'dat' | 'inst' | 'prep';

// [stem, true = nominative ends in -ой instead of -ый]
const ORDINAL_STEMS: Record<number, [string, boolean]> = {
  1: ['перв', false], 2: ['втор', true], 4: ['четвёрт', false],
  5: ['пят', false], 6: ['шест', true], 7: ['седьм', true],
  8: ['восьм', true], 9: ['девят', false], 10: ['десят', false],
  11: ['одиннадцат', false], 12: ['двенадцат', false], 13: ['тринадцат', false],
  14: ['четырнадцат', false], 15: ['пятнадцат', false], 16: ['шестнадцат', false],
  17: ['семнадцат', false], 18: ['восемнадцат', false], 19: ['девятнадцат', false],
  20: ['двадцат', false], 30: ['тридцат', false],
};

function toOrdinalMasc(n: number, gc: GramCase): string | null {
  if (n >= 21 && n <= 29) {
    const o = toOrdinalMasc(n % 10, gc);
    return o ? `двадцать ${o}` : null;
  }
  if (n >= 31 && n <= 39) {
    const o = toOrdinalMasc(n % 10, gc);
    return o ? `тридцать ${o}` : null;
  }
  if (n === 3) {
    return ({ nom: 'третий', gen: 'третьего', dat: 'третьему', inst: 'третьим', prep: 'третьем' } as Record<GramCase, string>)[gc];
  }
  const e = ORDINAL_STEMS[n];
  if (!e) return null;
  const [stem, soft] = e;
  const endings: Record<GramCase, string> = {
    nom: soft ? 'ой' : 'ый', gen: 'ого', dat: 'ому', inst: 'ым', prep: 'ом',
  };
  return stem + endings[gc];
}

/**
 * Expand ordinal numbers in common Russian contexts.
 * E.g. "в 18 веке" → "в восемнадцатом веке", "18-й" → "восемнадцатый"
 */
function expandOrdinalNumbers(text: string): string {
  let r = text;

  // JS \b doesn't work for Cyrillic — use lookarounds:
  // (?<![а-яА-ЯёЁ]) = not preceded by Cyrillic
  // (?![а-яА-ЯёЁ])  = not followed by Cyrillic

  // Prepositional with "в/во": "в 18 веке" → "в восемнадцатом веке"
  r = r.replace(
    /(?<![а-яА-ЯёЁ])(во?)\s+(\d{1,2})\s+(веке|классе|уроке|разделе|столетии|параграфе|томе|этаже|курсе|этапе)(?![а-яА-ЯёЁ])/gi,
    (m, prep, num, noun) => {
      const o = toOrdinalMasc(parseInt(num), 'prep');
      return o ? `${prep.toLowerCase()} ${o} ${noun.toLowerCase()}` : m;
    },
  );

  // Prepositional with "на": "на 2 уроке"
  r = r.replace(
    /(?<![а-яА-ЯёЁ])(на)\s+(\d{1,2})\s+(уроке|этаже|курсе|этапе)(?![а-яА-ЯёЁ])/gi,
    (m, prep, num, noun) => {
      const o = toOrdinalMasc(parseInt(num), 'prep');
      return o ? `${prep.toLowerCase()} ${o} ${noun.toLowerCase()}` : m;
    },
  );

  // Dative with "к": "к 21 веку"
  r = r.replace(
    /(?<![а-яА-ЯёЁ])(к)\s+(\d{1,2})\s+(веку|классу|уроку)(?![а-яА-ЯёЁ])/gi,
    (m, prep, num, noun) => {
      const o = toOrdinalMasc(parseInt(num), 'dat');
      return o ? `${prep.toLowerCase()} ${o} ${noun.toLowerCase()}` : m;
    },
  );

  // Genitive: "18 века" (before nominative to avoid partial match)
  r = r.replace(
    /(?<!\d)(\d{1,2})\s+(века|класса|урока|раздела|столетия|тома|параграфа|этажа|курса)(?![а-яА-ЯёЁ])/gi,
    (m, num, noun) => {
      const o = toOrdinalMasc(parseInt(num), 'gen');
      return o ? `${o} ${noun.toLowerCase()}` : m;
    },
  );

  // Instrumental: "18 веком"
  r = r.replace(
    /(?<!\d)(\d{1,2})\s+(веком|классом|уроком|разделом|томом)(?![а-яА-ЯёЁ])/gi,
    (m, num, noun) => {
      const o = toOrdinalMasc(parseInt(num), 'inst');
      return o ? `${o} ${noun.toLowerCase()}` : m;
    },
  );

  // Nominative: "18 век" (last — noun forms above are longer, no ambiguity)
  r = r.replace(
    /(?<!\d)(\d{1,2})\s+(век|класс|урок|раздел|том|параграф|этаж|курс)(?![а-яА-ЯёЁ])/gi,
    (m, num, noun) => {
      const o = toOrdinalMasc(parseInt(num), 'nom');
      return o ? `${o} ${noun.toLowerCase()}` : m;
    },
  );

  // Hyphenated ordinal suffixes: "18-й" → "восемнадцатый"
  const sfx: Array<[string, GramCase]> = [
    ['го', 'gen'], ['му', 'dat'], ['ым', 'inst'], ['й', 'nom'], ['м', 'prep'],
  ];
  for (const [s, gc] of sfx) {
    r = r.replace(
      new RegExp(`(?<!\\d)(\\d{1,2})-${s}(?![а-яА-ЯёЁ])`, 'g'),
      (m, num) => toOrdinalMasc(parseInt(num), gc) || m,
    );
  }

  return r;
}

/**
 * Restore ё in Russian words where it was written as е.
 * Only uses safe, unambiguous replacements (no homograph risk).
 */
function restoreYo(text: string): string {
  return text.replace(/[а-яА-ЯёЁ]+/g, (word) => {
    const lower = word.toLowerCase();
    const replacement = YO_DICTIONARY.get(lower);
    if (!replacement) return word;
    // Preserve ALL CAPS
    if (word === word.toUpperCase()) {
      return replacement.toUpperCase();
    }
    // Preserve capitalized first letter
    if (word[0] === word[0].toUpperCase()) {
      return replacement[0].toUpperCase() + replacement.slice(1);
    }
    return replacement;
  });
}

/**
 * Agree a unit noun with a number: 1 миллиард, 3 миллиарда, 5 миллиардов.
 */
function agreeUnit(n: number, one: string, few: string, many: string): string {
  const absN = Math.abs(n) % 100;
  if (absN >= 11 && absN <= 19) return many;
  const last = absN % 10;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

/**
 * Expand Russian abbreviations and acronyms for TTS.
 */
function expandAbbreviations(text: string): string {
  let r = text;

  // --- Dot-abbreviated words ---
  // JS \b doesn't work for Cyrillic, use (?<![а-яА-ЯёЁ]) as word boundary
  r = r.replace(/(?<![а-яА-ЯёЁ])до\s+н\.\s*э\./gi, 'до нашей эры');
  r = r.replace(/(?<![а-яА-ЯёЁ])н\.\s*э\./gi, 'нашей эры');
  r = r.replace(/(?<![а-яА-ЯёЁ])т\.д\./g, 'так далее');
  r = r.replace(/(?<![а-яА-ЯёЁ])т\.п\./g, 'тому подобное');
  r = r.replace(/(?<![а-яА-ЯёЁ])т\.е\./g, 'то есть');
  r = r.replace(/(?<![а-яА-ЯёЁ])т\.к\./g, 'так как');
  r = r.replace(/(?<![а-яА-ЯёЁ])напр\./g, 'например');
  r = r.replace(/(?<![а-яА-ЯёЁ])др\./g, 'другие');
  r = r.replace(/(?<![а-яА-ЯёЁ])см\./g, 'смотри');
  r = r.replace(/(?<![а-яА-ЯёЁ])проф\./gi, 'профессор');
  r = r.replace(/(?<![а-яА-ЯёЁ])акад\./gi, 'академик');
  r = r.replace(/(?<![а-яА-ЯёЁ])д-р(?![а-яА-ЯёЁ])/g, 'доктор');
  r = r.replace(/(?<![а-яА-ЯёЁ])гг\./g, 'годов');
  r = r.replace(/(?<![а-яА-ЯёЁ])вв\./g, 'веков');

  // --- Numeric abbreviations (no dot) — with number agreement ---
  r = r.replace(/(\d+)\s*млрд(?![а-яА-ЯёЁ])/g, (_m, num) => {
    return `${num} ${agreeUnit(parseInt(num), 'миллиард', 'миллиарда', 'миллиардов')}`;
  });
  r = r.replace(/(\d+)\s*млн(?![а-яА-ЯёЁ])/g, (_m, num) => {
    return `${num} ${agreeUnit(parseInt(num), 'миллион', 'миллиона', 'миллионов')}`;
  });
  r = r.replace(/(\d+)\s*тыс\./g, (_m, num) => {
    return `${num} ${agreeUnit(parseInt(num), 'тысяча', 'тысячи', 'тысяч')}`;
  });
  // Fallback without preceding number
  r = r.replace(/(?<![а-яА-ЯёЁ])млрд(?![а-яА-ЯёЁ])/g, 'миллиардов');
  r = r.replace(/(?<![а-яА-ЯёЁ])млн(?![а-яА-ЯёЁ])/g, 'миллионов');
  r = r.replace(/(?<![а-яА-ЯёЁ])тыс\./g, 'тысяч');
  r = r.replace(/(?<![а-яА-ЯёЁ])руб\./g, 'рублей');
  r = r.replace(/(?<![а-яА-ЯёЁ])коп\./g, 'копеек');

  // --- Units (only after digits to avoid false matches) ---
  r = r.replace(/(\d)\s*км\/ч(?![а-яА-ЯёЁ])/g, '$1 километров в час');
  r = r.replace(/(\d)\s*км(?![а-яА-ЯёЁ\/])/g, '$1 километров');
  r = r.replace(/(\d)\s*кг(?![а-яА-ЯёЁ])/g, '$1 килограммов');
  r = r.replace(/(\d)\s*см(?![а-яА-ЯёЁ])/g, '$1 сантиметров');
  r = r.replace(/(\d)\s*мм(?![а-яА-ЯёЁ])/g, '$1 миллиметров');
  r = r.replace(/(\d)\s*м(?![а-яА-ЯёЁ\/])/g, '$1 метров');
  r = r.replace(/(\d)\s*°C/g, '$1 градусов Цельсия');
  r = r.replace(/(\d)\s*%/g, '$1 процентов');

  // --- Cyrillic letter acronyms → spelled-out pronunciation ---
  // Use (?<![а-яА-ЯёЁ]) and (?![а-яА-ЯёЁ]) as Cyrillic word boundaries
  const cyrAcronyms: Record<string, string> = {
    'ИИ': 'и-и,',
    'СССР': 'эс-эс-эс-эр',
    'США': 'сэ-шэ-а',
    'ООН': 'оон',
    'ВВП': 'вэ-вэ-пэ',
    'МВД': 'эм-вэ-дэ',
    'ФСБ': 'эф-эс-бэ',
    'ВОЗ': 'воз',
    'ДНК': 'дэ-эн-ка',
    'РФ': 'эр-эф',
    'ЕС': 'е-эс',
    'ВУЗ': 'вуз',
    'ВУЗЫ': 'вузы',
    'НИИ': 'ни-и,',
    'КПД': 'капэдэ',
    'ЭВМ': 'э-вэ-эм',
    'АЭС': 'аэс',
    'ГЭС': 'гэс',
    'ТЭЦ': 'тэц',
  };
  for (const [acronym, pronunciation] of Object.entries(cyrAcronyms)) {
    r = r.replace(
      new RegExp(`(?<![а-яА-ЯёЁ])${acronym}(?![а-яА-ЯёЁ])`, 'g'),
      pronunciation,
    );
  }

  return r;
}

/**
 * Expand dates: "12 января" → "двенадцатого января"
 */
function expandDates(text: string): string {
  const months = 'января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря';
  return text.replace(
    new RegExp(`(?<!\\d)(\\d{1,2})\\s+(${months})(?![а-яА-ЯёЁ])`, 'gi'),
    (m, numStr, month) => {
      const ord = toOrdinalMasc(parseInt(numStr), 'gen');
      return ord ? `${ord} ${month.toLowerCase()}` : m;
    },
  );
}

/**
 * Transliterate common English words/acronyms to Russian phonetic equivalents.
 */
function transliterateEnglish(text: string): string {
  // Sorted longest-first to avoid partial matches (e.g. "JavaScript" before "Java")
  const dict: Array<[RegExp, string]> = [
    // Multi-word terms (must be first)
    [/\bmachine\s+learning\b/gi, 'машин лёрнинг'],
    [/\bdeep\s+learning\b/gi, 'дип лёрнинг'],
    [/\bdata\s+science\b/gi, 'дата сайенс'],
    [/\bopen\s+source\b/gi, 'опен сорс'],
    [/\bbig\s+data\b/gi, 'биг дата'],
    // AI products (before acronyms to avoid partial matches)
    [/\bChatGPT\b/gi, 'ЧатДжиПиТи'],
    [/\bGPT[-‑]?4[oо]\b/gi, 'джи-пи-ти-четыре-о'],
    [/\bGPT[-‑]?4\b/gi, 'джи-пи-ти четыре'],
    [/\bGPT[-‑]?3\.5\b/gi, 'джи-пи-ти три пять'],
    [/\bGPT[-‑]?3\b/gi, 'джи-пи-ти три'],
    [/\bGPT\b/g, 'джи-пи-ти'],
    // Programming languages & frameworks
    [/\bJavaScript\b/gi, 'ДжаваСкрипт'],
    [/\bTypeScript\b/gi, 'ТайпСкрипт'],
    [/\bPython\b/gi, 'Пайтон'],
    [/\bDocker\b/gi, 'Докер'],
    [/\bLinux\b/gi, 'Линукс'],
    [/\bWindows\b/gi, 'Виндоус'],
    [/\bAndroid\b/gi, 'Андроид'],
    [/\bGoogle\b/gi, 'Гугл'],
    [/\bGitHub\b/gi, 'ГитХаб'],
    [/\bReact\b/g, 'Реакт'],
    [/\bNext\.?js\b/gi, 'НекстДжейЭс'],
    [/\bNode\.?js\b/gi, 'НодДжейЭс'],
    // Acronyms (Latin letter → Russian phonetic)
    [/\bHTTPS\b/g, 'эйч-ти-ти-пи-эс'],
    [/\bHTTP\b/g, 'эйч-ти-ти-пи'],
    [/\bHTML\b/g, 'эйч-ти-эм-эль'],
    [/\bCSS\b/g, 'си-эс-эс'],
    [/\bAPI\b/g, 'эй-пи-ай'],
    [/\bURL\b/g, 'ю-ар-эль'],
    [/\bSQL\b/g, 'эс-кью-эль'],
    [/\bPDF\b/g, 'пи-ди-эф'],
    [/\bGPU\b/g, 'джи-пи-ю'],
    [/\bCPU\b/g, 'си-пи-ю'],
    [/\bSSD\b/g, 'эс-эс-ди'],
    [/\bRAM\b/g, 'рам'],
    [/\bLAN\b/g, 'лан'],
    [/\bVPN\b/g, 'ви-пи-эн'],
    [/\bUSB\b/g, 'ю-эс-би'],
    [/\bIoT\b/g, 'ай-о-ти'],
    [/\bAI\b/g, 'эй-ай'],
    [/\bLLM\b/g, 'эл-эл-эм'],
    [/\bML\b/g, 'эм-эль'],
    [/\bIT\b/g, 'ай-ти'],
    [/\bPR\b/g, 'пи-ар'],
    [/\bQR\b/g, 'кью-ар'],
    // Common tech words
    [/\bWi-?Fi\b/gi, 'вай-фай'],
    [/\bBluetooth\b/gi, 'блютус'],
    [/\bemail\b/gi, 'имейл'],
    [/\be-mail\b/gi, 'имейл'],
    [/\bonline\b/gi, 'онлайн'],
    [/\boffline\b/gi, 'офлайн'],
    [/\bsoftware\b/gi, 'софтвер'],
    [/\bhardware\b/gi, 'хардвер'],
    [/\bframework\b/gi, 'фреймворк'],
    [/\bstartup\b/gi, 'стартап'],
    [/\bchatbot\b/gi, 'чатбот'],
    [/\bdataset\b/gi, 'датасет'],
    [/\bfeedback\b/gi, 'фидбэк'],
    [/\bserver\b/gi, 'сервер'],
    [/\bbrowser\b/gi, 'браузер'],
    [/\brouter\b/gi, 'роутер'],
    [/\bcluster\b/gi, 'кластер'],
    [/\btoken\b/gi, 'токен'],
    [/\bprompt\b/gi, 'промт'],
  ];

  let r = text;
  for (const [pattern, replacement] of dict) {
    r = r.replace(pattern, replacement);
  }
  return r;
}

/**
 * Normalize Russian text for TTS using Python normalizer (num2words + RUAccent + proper nouns).
 * Falls back to inline TS rules if Python normalizer is unavailable.
 */
const NORMALIZER_SCRIPT = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'scripts', 'normalizer.py');

function normalizeForTTSSync(text: string): string {
  // Inline fallback: basic rules if Python normalizer fails
  let result = text;
  result = restoreYo(result);
  result = expandAbbreviations(result);
  result = expandDates(result);
  result = expandOrdinalNumbers(result);
  result = transliterateEnglish(result);
  result = result.replace(/&/g, ' энд ');
  // Handle literal pluses before they get confused with stress marks
  result = result.replace(/(\d)\s*\+\s*(\d)/g, '$1 плюс $2');
  result = result.replace(/([a-zA-Z])\+/g, '$1 плюс');
  // Final cleanup: remove all stress marks (+) to avoid audible "plus" sounds
  result = result.replace(/\+/g, '');
  return result;
}

async function normalizeForTTS(text: string): Promise<string> {
  try {
    return await new Promise<string>((resolve, reject) => {
      execFile(
        'python3',
        [NORMALIZER_SCRIPT, text],
        { timeout: 30000 },
        (error, stdout, _stderr) => {
          if (error) {
            reject(error);
          } else {
            resolve(stdout.trim());
          }
        },
      );
    });
  } catch {
    // Fallback to inline TS rules
    return normalizeForTTSSync(text);
  }
}

/**
 * Infer speaker gender from name for Edge TTS voice auto-selection.
 * Returns 'male' or 'female' based on known name patterns.
 */
function inferGenderFromName(name: string): 'male' | 'female' {
  const normalized = name.trim().toLowerCase();
  // Extract first word (first name)
  const firstName = normalized.split(/[\s,]+/)[0];

  const maleNames = new Set([
    // Russian male names
    'алексей', 'александр', 'андрей', 'антон', 'артём', 'артем', 'борис',
    'вадим', 'валерий', 'василий', 'виктор', 'виталий', 'владимир', 'владислав',
    'геннадий', 'георгий', 'глеб', 'григорий', 'даниил', 'денис', 'дмитрий',
    'евгений', 'егор', 'иван', 'игорь', 'илья', 'кирилл', 'константин',
    'лев', 'леонид', 'максим', 'михаил', 'никита', 'николай', 'олег',
    'павел', 'пётр', 'петр', 'роман', 'руслан', 'сергей', 'степан',
    'тимофей', 'фёдор', 'федор', 'филипп', 'юрий', 'ярослав',
    // English male names
    'alex', 'andrew', 'bob', 'charles', 'daniel', 'david', 'edward',
    'george', 'henry', 'jack', 'james', 'john', 'mark', 'michael', 'mike',
    'nick', 'paul', 'peter', 'richard', 'robert', 'steve', 'thomas', 'tom',
    'william',
    // Chinese male indicators
    '云希', '云健',
  ]);

  if (maleNames.has(firstName)) return 'male';

  // Heuristic: Russian names ending in consonant or -й/-ий are typically male
  if (/[бвгджзклмнпрстфхцчшщй]$/i.test(firstName) && firstName.length > 2) {
    // But exclude common female endings like -ь (любовь, etc.)
    if (!/ь$/.test(firstName)) return 'male';
  }

  return 'female';
}

/**
 * Resolve Edge TTS voice based on speaker name.
 * If user explicitly set a non-default voice, respect it.
 * Otherwise, auto-select by inferred gender.
 */
function resolveEdgeTTSVoice(configVoice: string, speakerName?: string): string {
  // If no speaker name provided, use configured voice as-is
  if (!speakerName) return configVoice || EDGE_TTS_VOICE_BY_GENDER.female;

  // If user explicitly chose a specific voice (not the default), respect it
  const defaultVoice = EDGE_TTS_VOICE_BY_GENDER.female; // ru-RU-SvetlanaNeural
  if (configVoice && configVoice !== defaultVoice) return configVoice;

  // Auto-select voice by speaker gender
  const gender = inferGenderFromName(speakerName);
  return EDGE_TTS_VOICE_BY_GENDER[gender];
}

const EDGE_TTS_MAX_RETRIES = 5;
const EDGE_TTS_BASE_DELAY_MS = 10_000; // 10s, doubles each retry: 10, 20, 40, 80, 160

/**
 * Edge TTS implementation (CLI-based, free, no API key required)
 * Includes retry with exponential backoff for 503/429 transient errors.
 */
async function generateEdgeTTS(
  config: TTSModelConfig,
  text: string,
): Promise<TTSGenerationResult> {
  const normalizedText = await normalizeForTTS(text);
  const voice = resolveEdgeTTSVoice(config.voice, config.speakerName);
  const speed = config.speed || 1.0;

  // Calculate rate string: 1.0 → '+0%', 1.5 → '+50%', 0.5 → '-50%'
  const ratePercent = Math.round((speed - 1.0) * 100);
  const rateStr = ratePercent >= 0 ? `+${ratePercent}%` : `${ratePercent}%`;

  for (let attempt = 0; attempt < EDGE_TTS_MAX_RETRIES; attempt++) {
    const tmpFile = join(tmpdir(), `edge-tts-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`);

    try {
      await new Promise<void>((resolve, reject) => {
        execFile(
          'edge-tts',
          ['--text', normalizedText, '--voice', voice, '--rate', rateStr, '--write-media', tmpFile],
          { timeout: 60000 },
          (error, _stdout, stderr) => {
            if (error) {
              reject(new Error(`Edge TTS error: ${stderr || error.message}`));
            } else {
              resolve();
            }
          },
        );
      });

      const audioBuffer = await readFile(tmpFile);
      await unlink(tmpFile).catch(() => {});
      return {
        audio: new Uint8Array(audioBuffer),
        format: 'mp3',
      };
    } catch (err) {
      await unlink(tmpFile).catch(() => {});
      const delay = EDGE_TTS_BASE_DELAY_MS * Math.pow(2, attempt);
      if (attempt < EDGE_TTS_MAX_RETRIES - 1) {
        console.warn(`[edge-tts] Attempt ${attempt + 1}/${EDGE_TTS_MAX_RETRIES} failed: ${err}. Retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw new Error(`Edge TTS failed after ${EDGE_TTS_MAX_RETRIES} attempts: ${err}`);
      }
    }
  }

  // Unreachable, but TypeScript needs it
  throw new Error('Edge TTS: unexpected retry loop exit');
}

/**
 * ElevenLabs TTS implementation (direct API call with voice-specific endpoint)
 */
async function generateElevenLabsTTS(
  config: TTSModelConfig,
  text: string,
): Promise<TTSGenerationResult> {
  const baseUrl = config.baseUrl || TTS_PROVIDERS['elevenlabs-tts'].defaultBaseUrl;
  const requestedFormat = config.format || 'mp3';
  const clampedSpeed = Math.min(1.2, Math.max(0.7, config.speed || 1.0));
  const outputFormatMap: Record<string, string> = {
    mp3: 'mp3_44100_128',
    opus: 'opus_48000_96',
    pcm: 'pcm_44100',
    wav: 'wav_44100',
    ulaw: 'ulaw_8000',
    alaw: 'alaw_8000',
  };
  const outputFormat = outputFormatMap[requestedFormat] || outputFormatMap.mp3;

  const response = await fetch(
    `${baseUrl}/text-to-speech/${encodeURIComponent(config.voice)}?output_format=${outputFormat}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': config.apiKey!,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          speed: clampedSpeed,
        },
      }),
    },
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`ElevenLabs TTS API error: ${errorText || response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    audio: new Uint8Array(arrayBuffer),
    format: requestedFormat,
  };
}

/**
 * Get current TTS configuration from settings store
 * Note: This function should only be called in browser context
 */
export async function getCurrentTTSConfig(): Promise<TTSModelConfig> {
  if (typeof window === 'undefined') {
    throw new Error('getCurrentTTSConfig() can only be called in browser context');
  }

  // Lazy import to avoid circular dependency
  const { useSettingsStore } = await import('@/lib/store/settings');
  const { ttsProviderId, ttsVoice, ttsSpeed, ttsProvidersConfig } = useSettingsStore.getState();

  const providerConfig = ttsProvidersConfig?.[ttsProviderId];

  return {
    providerId: ttsProviderId,
    apiKey: providerConfig?.apiKey,
    baseUrl: providerConfig?.baseUrl,
    voice: ttsVoice,
    speed: ttsSpeed,
  };
}

// Re-export from constants for convenience
export { getAllTTSProviders, getTTSProvider, getTTSVoices } from './constants';

// Export normalizeForTTS for testing
export { normalizeForTTSSync as _normalizeForTTS_test };

/**
 * Escape XML special characters for SSML
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
