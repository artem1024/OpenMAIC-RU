/**
 * Unit tests for the prompt loader's snippet + conditional-block + variable
 * pipeline. Focus is on the {{#if}} block support added from upstream PR #490
 * and on the USE_FILE_PROMPTS / USE_CONDITIONAL_PROMPT_BLOCKS feature flags.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  buildPrompt,
  clearPromptCache,
  interpolateVariables,
  isConditionalBlocksEnabled,
  isFilePromptsEnabled,
  loadPrompt,
  processConditionalBlocks,
  processSnippets,
} from '../loader';

describe('processConditionalBlocks', () => {
  beforeEach(() => {
    delete process.env.USE_CONDITIONAL_PROMPT_BLOCKS;
  });

  test('keeps content when condition is truthy', () => {
    const out = processConditionalBlocks('a {{#if foo}}YES{{/if}} b', { foo: true });
    expect(out).toBe('a YES b');
  });

  test('removes content when condition is falsy', () => {
    const out = processConditionalBlocks('a {{#if foo}}NO{{/if}} b', { foo: false });
    expect(out).toBe('a  b');
  });

  test('removes content when condition is missing', () => {
    const out = processConditionalBlocks('a {{#if missing}}NO{{/if}} b', {});
    expect(out).toBe('a  b');
  });

  test('handles multiple independent blocks', () => {
    const tpl = '{{#if a}}A{{/if}} | {{#if b}}B{{/if}} | {{#if c}}C{{/if}}';
    const out = processConditionalBlocks(tpl, { a: true, b: false, c: 1 });
    expect(out).toBe('A |  | C');
  });

  test('handles multi-line content inside blocks', () => {
    const tpl = '{{#if x}}\nline1\nline2\n{{/if}}';
    const out = processConditionalBlocks(tpl, { x: true });
    expect(out).toBe('\nline1\nline2\n');
  });

  test('treats string values as truthy/falsy correctly', () => {
    expect(processConditionalBlocks('{{#if s}}KEEP{{/if}}', { s: 'hello' })).toBe('KEEP');
    expect(processConditionalBlocks('{{#if s}}DROP{{/if}}', { s: '' })).toBe('');
  });

  test('does NOT support nesting (documented limitation)', () => {
    // The non-greedy regex consumes up to the first {{/if}} — by design.
    // Nested blocks should be expressed as flat siblings or as snippets.
    const tpl = '{{#if outer}}A{{#if inner}}B{{/if}}C{{/if}}';
    const out = processConditionalBlocks(tpl, { outer: true, inner: true });
    // Expected behaviour: outer match is "A{{#if inner}}B" and outer kept it,
    // then the orphan "C{{/if}}" remains unprocessed.
    expect(out).toContain('A');
    expect(out).toContain('B');
    expect(out).toContain('C{{/if}}');
  });

  test('is a no-op when USE_CONDITIONAL_PROMPT_BLOCKS=false', () => {
    process.env.USE_CONDITIONAL_PROMPT_BLOCKS = 'false';
    const tpl = '{{#if foo}}KEEP{{/if}}';
    const out = processConditionalBlocks(tpl, { foo: false });
    expect(out).toBe(tpl);
    expect(isConditionalBlocksEnabled()).toBe(false);
  });
});

describe('interpolateVariables (regression — must not eat {{#if}} markers)', () => {
  test('leaves {{#if foo}} markers in place', () => {
    // {{#if foo}} starts with '#' which the \w+ class excludes, so the
    // existing variable regex must NOT match it.
    const out = interpolateVariables('{{#if foo}}body{{/if}} {{x}}', { x: 'X' });
    expect(out).toBe('{{#if foo}}body{{/if}} X');
  });
});

describe('processSnippets', () => {
  test('inlines a real snippet file', () => {
    // tts-speech-guidelines.md ships in our fork
    const out = processSnippets('intro {{snippet:tts-speech-guidelines}} outro');
    expect(out).toContain('intro ');
    expect(out).toContain('Speech Text Quality');
    expect(out).toContain(' outro');
  });
});

describe('buildPrompt — end-to-end pipeline', () => {
  beforeEach(() => {
    clearPromptCache();
    delete process.env.USE_FILE_PROMPTS;
    delete process.env.USE_CONDITIONAL_PROMPT_BLOCKS;
  });

  test('processing order is snippets → conditionals → variables', () => {
    // Use the real requirements-to-outlines template — this exercises all
    // three processing stages together.
    const result = buildPrompt('requirements-to-outlines', {
      requirement: 'Тестовый запрос',
      language: 'ru-RU',
      pdfContent: 'None',
      availableImages: 'None',
      userProfile: '',
      imageEnabled: true,
      videoEnabled: false,
      mediaEnabled: true,
      hasSourceImages: false,
      mediaPolicyMessage: '',
      researchContext: 'None',
      teacherContext: '',
      maxInteractive: 1,
      maxVideos: 0,
      minDurationMin: 5,
      maxDurationMin: 10,
      scenesPerMinute: 1,
      minScenes: 5,
      maxScenes: 10,
    });
    expect(result).not.toBeNull();
    if (!result) return;

    // imageEnabled=true → image-instructions snippet must be inlined
    expect(result.system).toContain('AI-Generated Image Requests');
    // videoEnabled=false → video-instructions snippet must be absent
    expect(result.system).not.toContain('AI-Generated Video Requests');
    // mediaEnabled=true → safety guidelines included
    expect(result.system).toContain('Content Safety Guidelines for Generation Prompts');
    // Variable interpolation worked
    expect(result.user).toContain('Тестовый запрос');
  });

  test('with all media disabled, no media snippets are included', () => {
    const result = buildPrompt('requirements-to-outlines', {
      requirement: 'plain text course',
      language: 'ru-RU',
      pdfContent: 'None',
      availableImages: 'None',
      userProfile: '',
      imageEnabled: false,
      videoEnabled: false,
      mediaEnabled: false,
      hasSourceImages: false,
      mediaPolicyMessage: '',
      researchContext: 'None',
      teacherContext: '',
      maxInteractive: 1,
      maxVideos: 0,
      minDurationMin: 5,
      maxDurationMin: 10,
      scenesPerMinute: 1,
      minScenes: 5,
      maxScenes: 10,
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.system).not.toContain('AI-Generated Image Requests');
    expect(result.system).not.toContain('AI-Generated Video Requests');
    expect(result.system).not.toContain('Content Safety Guidelines for Generation Prompts');
    // suggestedImageIds row should be hidden too
    expect(result.system).not.toContain('Suggested image IDs to use');
    // mediaGenerations row should be hidden too
    expect(result.system).not.toContain('AI-generated media requests');
  });

  test('RU TTS guidelines snippet is included via slide-actions/quiz-actions/etc.', () => {
    // tts-speech-guidelines is unconditional in slide-actions/system.md and
    // the other *-actions templates that drive speech synthesis.
    // This is the "RU invariant" smoke-check from the upstream-integration
    // plan — make sure the migration didn't accidentally drop it.
    const result = buildPrompt('slide-actions', {});
    expect(result).not.toBeNull();
    if (!result) return;
    // The Russian "ё" / "женского рода" rule must reach the model.
    expect(result.system).toContain('letter ё');
    expect(result.system).toContain('feminine grammatical forms');
  });

  test('mediaElementDisabled flag triggers the explicit "do not create media" checklist line', () => {
    const result = buildPrompt('slide-content', {
      title: 'Урок 1',
      description: 'Описание',
      keyPoints: '1. one\n2. two',
      elements: 'auto',
      assignedImages: 'None',
      canvas_width: 1000,
      canvas_height: 562.5,
      teacherContext: '',
      layoutHint: '',
      imageElementEnabled: false,
      generatedImageEnabled: false,
      generatedVideoEnabled: false,
      mediaElementEnabled: false,
      mediaElementDisabled: true,
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.system).toContain('Do NOT create image or video elements');
    // Image/video element specs must be absent
    expect(result.system).not.toContain('### ImageElement');
    expect(result.system).not.toContain('### VideoElement');
  });

  test('imageElementEnabled (with generated images) inlines image schema + gen note', () => {
    const result = buildPrompt('slide-content', {
      title: 'Урок 2',
      description: 'D',
      keyPoints: '1. a',
      elements: 'auto',
      assignedImages: 'img_1',
      canvas_width: 1000,
      canvas_height: 562.5,
      teacherContext: '',
      layoutHint: '',
      imageElementEnabled: true,
      generatedImageEnabled: true,
      generatedVideoEnabled: false,
      mediaElementEnabled: true,
      mediaElementDisabled: false,
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.system).toContain('### ImageElement');
    expect(result.system).toContain('AI-Generated Images');
    expect(result.system).not.toContain('### VideoElement');
  });
});

describe('feature flag — USE_FILE_PROMPTS', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearPromptCache();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    delete process.env.USE_FILE_PROMPTS;
  });

  test('default is enabled', () => {
    expect(isFilePromptsEnabled()).toBe(true);
  });

  test('USE_FILE_PROMPTS=false makes loadPrompt return null (fail-loud, no TS fallback)', () => {
    process.env.USE_FILE_PROMPTS = 'false';
    expect(isFilePromptsEnabled()).toBe(false);
    expect(loadPrompt('requirements-to-outlines')).toBeNull();
  });

  test('USE_FILE_PROMPTS=0 also disables', () => {
    process.env.USE_FILE_PROMPTS = '0';
    expect(isFilePromptsEnabled()).toBe(false);
  });
});
