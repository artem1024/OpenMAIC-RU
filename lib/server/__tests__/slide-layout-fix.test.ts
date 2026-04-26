/**
 * Tests for the persist-time slide-layout-fix pass — focused on the
 * `estimateTextHeight` helper that drives `growTextHeight` (and, after
 * Б2b, autoShrinkTexts).
 *
 * The historical estimator collapsed every HTML tag — including inline
 * ones like <strong>, <em>, <span> — to a newline, which inflated the
 * estimate for HTML written by the AI (e.g. lessons with bullet lists
 * containing inline emphasis). For the L5.S1 bullet (3 × <p> with
 * <strong> markers and a margin-bottom) the old estimator returned
 * ~347px for content that browsers render in ~186px.
 *
 * The fix: split tags into block-level (<p>, <div>, <li>, <ul>, <ol>,
 * <hN>, <blockquote>, <br>) which DO produce a line break, and inline
 * tags which are stripped without inserting a newline.
 */
import { describe, test, expect } from 'vitest';
import type { Scene } from '@/lib/types/stage';
import { estimateTextHeight, fixSlideLayouts } from '../slide-layout-fix';

type CanvasElement = {
  id: string;
  type: string;
  left: number;
  top: number;
  width: number;
  height: number;
  content?: string;
  path?: string;
};

function makeSceneWithElements(elements: CanvasElement[]): Scene {
  return {
    id: 's-test',
    title: 'test',
    type: 'slide',
    content: {
      type: 'slide',
      canvas: {
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements,
      },
    },
  } as unknown as Scene;
}

/**
 * Wrap a text element in a tight container shape so that growTextHeight is
 * bounded — required for autoShrink integration tests, since otherwise the
 * grow pass swallows any internal clip before shrink can run.
 *
 * `padBottom` controls how much room the container leaves below the text;
 * tighter pad ⇒ smaller post-grow height. Container width/height are
 * clamped to `findContainers`' minimums (>=120w, >=80h, path "M 0 0 ...").
 */
function withTightContainer(text: CanvasElement, padBottom = 30): CanvasElement[] {
  const container: CanvasElement = {
    id: 'container_' + text.id,
    type: 'shape',
    left: text.left - 10,
    top: text.top - 10,
    width: Math.max(120, text.width + 20),
    height: Math.max(80, text.height + padBottom + 10),
    path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z',
  };
  return [container, text];
}

describe('estimateTextHeight (Б2a)', () => {
  test('plain <p> text — single short line at 18px in 400px width', () => {
    const h = estimateTextHeight('<p style="font-size: 18px;">Короткий текст.</p>', 400);
    // 1 line × 18 × 1.45 ≈ 26 + 8 pad ≈ 34. Allow a generous range to
    // tolerate the +0.4 phantom-line accumulator in the helper.
    expect(h).toBeGreaterThanOrEqual(20);
    expect(h).toBeLessThanOrEqual(50);
  });

  test('three <p>+<strong> bullets in 440px ≈ browser-rendered ~186px', () => {
    // Reproduction of L5.S1 bullet-list. Old (STRIP_TAGS → \n) returned
    // ~347px because each <strong> introduced two extra newlines per <p>.
    const html =
      '<p style="font-size: 18px; margin-bottom: 12px;">• <strong>Цель курса:</strong> Изучить эволюцию ИИ от первых идей до современных нейросетей.</p>' +
      '<p style="font-size: 18px; margin-bottom: 12px;">• <strong>Что узнаете:</strong> Историю развития нейросетей и ключевые архитектурные прорывы.</p>' +
      '<p style="font-size: 18px;">• <strong>Особенности:</strong> Интерактивные слайды с примерами и визуализациями.</p>';
    const h = estimateTextHeight(html, 440);
    // Expected: roughly 3 lines × 18 × 1.45 ≈ 78–135 depending on wrap;
    // crucially ≤ 230 so that auto-shrink stays inside the 200px patched
    // box without reporting a fake "cannot fit" warning.
    expect(h).toBeGreaterThan(60);
    expect(h).toBeLessThan(230);
  });

  test('inline <em>/<span>/<strong> do NOT add line breaks', () => {
    const plain = estimateTextHeight(
      '<p style="font-size: 16px;">Простой текст без тегов.</p>',
      400,
    );
    const withInline = estimateTextHeight(
      '<p style="font-size: 16px;">Простой <strong>текст</strong> без <em>тегов</em>.</p>',
      400,
    );
    // Inline tags must produce the same estimate (string length is similar
    // after both inline and block stripping pass).
    expect(Math.abs(withInline - plain)).toBeLessThanOrEqual(4);
  });

  test('<br>, <br/>, <br /> all introduce a line break', () => {
    const oneLine = estimateTextHeight('<p style="font-size: 16px;">A B C</p>', 400);
    for (const br of ['<br>', '<br/>', '<br />', '<BR/>']) {
      const twoLines = estimateTextHeight(`<p style="font-size: 16px;">A${br}B${br}C</p>`, 400);
      expect(twoLines).toBeGreaterThan(oneLine);
    }
  });

  test('no tags — bare text — produces sensible estimate', () => {
    const h = estimateTextHeight('Просто текст без обёртки', 400);
    // 1 line at fallback 16px × 1.45 ≈ 23 + 8 ≈ 31, plus the 0.4-line
    // phantom in the helper. Lower bound is loose to tolerate that.
    expect(h).toBeGreaterThanOrEqual(15);
    expect(h).toBeLessThanOrEqual(60);
  });

  test('empty / whitespace-only content returns 0', () => {
    expect(estimateTextHeight('', 400)).toBe(0);
    expect(estimateTextHeight('<p></p>', 400)).toBe(0);
    expect(estimateTextHeight('<p>   </p>', 400)).toBe(0);
  });

  test('two <p> blocks return more than a single equivalent paragraph', () => {
    const single = estimateTextHeight('<p style="font-size: 16px;">Текст</p>', 400);
    const double = estimateTextHeight(
      '<p style="font-size: 16px;">Текст</p><p style="font-size: 16px;">Ещё текст</p>',
      400,
    );
    expect(double).toBeGreaterThan(single);
  });

  test('<li>, <ul>, <h2>, <blockquote> all act as block tags', () => {
    const para = estimateTextHeight('<p style="font-size: 16px;">Один Два Три</p>', 400);
    const list = estimateTextHeight(
      '<ul style="font-size: 16px;"><li>Один</li><li>Два</li><li>Три</li></ul>',
      400,
    );
    const heading = estimateTextHeight(
      '<h2 style="font-size: 16px;">Один</h2><h2 style="font-size: 16px;">Два</h2>',
      400,
    );
    const quote = estimateTextHeight(
      '<blockquote style="font-size: 16px;">Один</blockquote><blockquote style="font-size: 16px;">Два</blockquote>',
      400,
    );
    // Block tags create real line breaks; the multi-block estimates must
    // be larger than a single-paragraph estimate of the same word counts.
    expect(list).toBeGreaterThan(para);
    expect(heading).toBeGreaterThan(para);
    expect(quote).toBeGreaterThan(para);
  });
});

describe('autoShrinkTexts (Б2b)', () => {
  test('clipped text gets font shrunk; bbox does not exceed grow cap', () => {
    // 2 paragraphs at 18px, ~22 chars each, in a 200×40 text box wrapped by a
    // tight container so growTextHeight is capped to the container's bottom
    // (~68px), which is still less than the required ~133px → shrink fires.
    const html =
      '<p style="font-size: 18px;">Несколько слов в строке</p>' +
      '<p style="font-size: 18px;">Ещё несколько слов тут</p>';
    const text: CanvasElement = {
      id: 'text_clip',
      type: 'text',
      left: 60,
      top: 60,
      width: 200,
      height: 40,
      content: html,
    };
    const els = withTightContainer(text);
    const reports = fixSlideLayouts([makeSceneWithElements(els)]);
    const shrinkLine = reports[0]?.messages.find((m) => m.startsWith('shrink text_clip'));
    expect(shrinkLine).toBeDefined();
    // Box height must never exceed the grow-pass cap (container bottom - top).
    // Container is text.height + 20 = 60 tall at top=50, so capped at ~108.
    expect(text.height).toBeLessThanOrEqual(108);
    expect(text.content).not.toMatch(/font-size:\s*18px/);
    expect(text.content).toMatch(/font-size:\s*1[2-7]px/);
  });

  test('text that fits is left untouched', () => {
    const html = '<p style="font-size: 16px;">Короткий</p>';
    const el: CanvasElement = {
      id: 'text_ok',
      type: 'text',
      left: 100,
      top: 100,
      width: 400,
      height: 80,
      content: html,
    };
    fixSlideLayouts([makeSceneWithElements([el])]);
    expect(el.content).toBe(html);
    expect(el.height).toBe(80);
  });

  test('cannot fit even at 12px floor → skip-shrink, content untouched', () => {
    // Many long paragraphs at 18px in a tight container — even after delta=6
    // (→12px floor) the content still overflows. Must skip-shrink.
    const html =
      '<p style="font-size: 18px;">Очень длинный параграф со множеством слов и подробностями текста для проверки</p>'.repeat(
        6,
      );
    const text: CanvasElement = {
      id: 'text_too_tall',
      type: 'text',
      left: 60,
      top: 60,
      width: 180,
      height: 40,
      content: html,
    };
    const before = text.content;
    const els = withTightContainer(text);
    const reports = fixSlideLayouts([makeSceneWithElements(els)]);
    const skipLine = reports[0]?.messages.find((m) => m.includes('skip-shrink text_too_tall'));
    expect(skipLine).toBeDefined();
    expect(text.content).toBe(before);
  });

  test('text with no explicit font-size → skip-shrink, content untouched', () => {
    const text: CanvasElement = {
      id: 'text_no_fs',
      type: 'text',
      left: 60,
      top: 60,
      width: 200,
      height: 30,
      content: '<p>Длинный текст здесь</p>'.repeat(2),
    };
    const before = text.content;
    const els = withTightContainer(text);
    const reports = fixSlideLayouts([makeSceneWithElements(els)]);
    const skipLine = reports[0]?.messages.find(
      (m) => m.includes('skip-shrink text_no_fs') && m.includes('no shrinkable explicit font-size'),
    );
    expect(skipLine).toBeDefined();
    expect(text.content).toBe(before);
  });

  test('all sizes already at 12px floor → skip-shrink', () => {
    const html = '<p style="font-size: 12px;">Текст</p>'.repeat(8);
    const text: CanvasElement = {
      id: 'text_floor',
      type: 'text',
      left: 60,
      top: 60,
      width: 200,
      height: 30,
      content: html,
    };
    const els = withTightContainer(text);
    fixSlideLayouts([makeSceneWithElements(els)]);
    expect(text.content).toBe(html);
  });

  test('relative font-size hierarchy is preserved across the shrink', () => {
    // Two sizes: a 28px header and 18px body. After shrink they go down by
    // the same delta, so the header is still strictly larger than the body.
    const html =
      '<p style="font-size: 28px;">Заголовок</p>' +
      '<p style="font-size: 18px;">Один два три четыре пять</p>'.repeat(3);
    const text: CanvasElement = {
      id: 'text_hier',
      type: 'text',
      left: 60,
      top: 60,
      width: 200,
      height: 60,
      content: html,
    };
    const els = withTightContainer(text);
    fixSlideLayouts([makeSceneWithElements(els)]);
    const sizes = Array.from((text.content || '').matchAll(/font-size:\s*(\d+)px/g)).map((m) =>
      Number(m[1]),
    );
    expect(sizes.length).toBeGreaterThanOrEqual(2);
    const header = sizes[0];
    const body = sizes[sizes.length - 1];
    expect(header).toBeGreaterThan(body);
  });
});

describe('dropSevereFlowOverlaps', () => {
  test('drops a clamped lower note card instead of overlapping prior text', () => {
    const els: CanvasElement[] = [
      {
        id: 'body',
        type: 'text',
        left: 60,
        top: 439,
        width: 440,
        height: 122,
        content:
          '<p style="font-size: 16px;">• Пункт один</p><p style="font-size: 16px;">• Пункт два</p>',
      },
      {
        id: 'note_bg',
        type: 'shape',
        left: 60,
        top: 553,
        width: 880,
        height: 100,
        path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z',
      },
      {
        id: 'note_text',
        type: 'text',
        left: 80,
        top: 565,
        width: 840,
        height: 76,
        content:
          '<p style="font-size: 18px;"><strong>Урок истории:</strong> заметка не помещается.</p>',
      },
    ];
    const scene = makeSceneWithElements(els);
    (scene as unknown as { actions: Array<{ type: string; elementId?: string }> }).actions = [
      { type: 'spotlight', elementId: 'note_text' },
    ];

    const reports = fixSlideLayouts([scene]);
    const remaining = new Set(els.map((e) => e.id));

    expect(remaining.has('body')).toBe(true);
    expect(remaining.has('note_bg')).toBe(false);
    expect(remaining.has('note_text')).toBe(false);
    expect(reports[0]?.messages.some((m) => m.startsWith('drop-overlap'))).toBe(true);
    expect((scene as unknown as { actions: unknown[] }).actions).toEqual([]);
  });

  test('drops stacked orphan text blocks, keeping the first readable item', () => {
    const els: CanvasElement[] = [
      {
        id: 'bullet_1',
        type: 'text',
        left: 60,
        top: 474,
        width: 420,
        height: 70,
        content: '<p style="font-size: 16px;">• Градиентный спуск</p>',
      },
      {
        id: 'bullet_2',
        type: 'text',
        left: 60,
        top: 491,
        width: 420,
        height: 70,
        content: '<p style="font-size: 16px;">• Многослойность</p>',
      },
      {
        id: 'bullet_3',
        type: 'text',
        left: 60,
        top: 491,
        width: 420,
        height: 70,
        content: '<p style="font-size: 16px;">• Триумф 1989 г.</p>',
      },
    ];

    fixSlideLayouts([makeSceneWithElements(els)]);
    expect(els.map((e) => e.id)).toEqual(['bullet_1']);
  });

  test('preserves mild text bbox overlap that renders with normal line spacing', () => {
    const els: CanvasElement[] = [
      {
        id: 'bullet_1',
        type: 'text',
        left: 80,
        top: 340,
        width: 380,
        height: 96,
        content: '<p style="font-size: 18px;">• Гонка вычислений: краткий текст</p>',
      },
      {
        id: 'bullet_2',
        type: 'text',
        left: 80,
        top: 425,
        width: 380,
        height: 88,
        content: '<p style="font-size: 16px;">• Стена данных: краткий текст</p>',
      },
    ];

    fixSlideLayouts([makeSceneWithElements(els)]);
    expect(els.map((e) => e.id)).toEqual(['bullet_1', 'bullet_2']);
  });
});
