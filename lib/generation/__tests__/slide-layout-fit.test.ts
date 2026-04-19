/**
 * Tests for slide-layout-fit — the post-process pass that grows shape
 * heights and shifts stacked cards to accommodate longer-than-anticipated
 * Cyrillic text returned by the AI.
 */
import { describe, test, expect } from 'vitest';
import { fitSlideLayout, measureTextHeight } from '../slide-layout-fit';
import type {
  PPTElement,
  PPTShapeElement,
  PPTTextElement,
} from '@/lib/types/slides';

const CANVAS = { width: 1000, height: 562.5 };

function shape(
  id: string,
  left: number,
  top: number,
  width: number,
  height: number,
  fill = '#ffffff',
): PPTShapeElement {
  return {
    id,
    type: 'shape',
    left,
    top,
    width,
    height,
    rotate: 0,
    path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z',
    viewBox: [1, 1],
    fill,
    fixedRatio: false,
  };
}

function text(
  id: string,
  left: number,
  top: number,
  width: number,
  height: number,
  content: string,
): PPTTextElement {
  return {
    id,
    type: 'text',
    left,
    top,
    width,
    height,
    rotate: 0,
    content,
    defaultFontName: 'Microsoft YaHei',
    defaultColor: '#333333',
  };
}

describe('measureTextHeight', () => {
  test('single short line at 16px in 360px width returns one-line height', () => {
    const h = measureTextHeight(
      '<p style="font-size: 16px;">Короткий текст</p>',
      360,
    );
    // 1 line × 16 × 1.5 = 24, +4 pad = 28
    expect(h).toBeGreaterThanOrEqual(24);
    expect(h).toBeLessThanOrEqual(36);
  });

  test('long Russian description in 360px wraps to 2 lines', () => {
    const h = measureTextHeight(
      '<p style="font-size: 16px;">Накопление O₂ в атмосфере, необходимого для дыхания.</p>',
      360,
    );
    // chars≈51, charsPerLine=floor(360/(16*0.55))=40 → 2 lines × 16 × 1.5 = 48 + 4 = 52
    expect(h).toBeGreaterThanOrEqual(40);
    expect(h).toBeLessThanOrEqual(60);
  });

  test('two paragraphs sum heights', () => {
    const single = measureTextHeight('<p style="font-size: 16px;">A</p>', 360);
    const double = measureTextHeight(
      '<p style="font-size: 16px;">A</p><p style="font-size: 16px;">B</p>',
      360,
    );
    expect(double).toBeGreaterThan(single);
  });

  test('no font-size in HTML uses fallback', () => {
    const h = measureTextHeight('<p>Plain</p>', 360, 20);
    // 1 line × 20 × 1.5 = 30, +4 = 34
    expect(h).toBeGreaterThanOrEqual(28);
    expect(h).toBeLessThanOrEqual(40);
  });
});

describe('fitSlideLayout', () => {
  test('returns elements unchanged when nothing overflows', () => {
    const els: PPTElement[] = [
      shape('bg', 100, 100, 400, 200),
      text('t', 110, 110, 380, 30, '<p style="font-size: 16px;">OK</p>'),
    ];
    const { elements, warnings } = fitSlideLayout(els, CANVAS);
    expect(warnings).toEqual([]);
    const t = elements.find((e) => e.id === 't') as PPTTextElement;
    expect(t.top).toBe(110);
    // text height should grow to at least one line of 16 × 1.5 = 24
    expect(t.height).toBeGreaterThanOrEqual(24);
  });

  test('grows shape to wrap its over-tall text', () => {
    const els: PPTElement[] = [
      shape('bg', 550, 140, 390, 90),
      text(
        'desc',
        570,
        185,
        360,
        46,
        '<p style="font-size: 16px;">Накопление O₂ в атмосфере, необходимого для дыхания.</p>',
      ),
    ];
    const { elements } = fitSlideLayout(els, CANVAS);
    const bg = elements.find((e) => e.id === 'bg')! as PPTShapeElement;
    const desc = elements.find((e) => e.id === 'desc')! as PPTTextElement;
    // text grew
    expect(desc.height).toBeGreaterThan(46);
    // shape grew to wrap text + padding
    expect(bg.height).toBeGreaterThanOrEqual(desc.top + desc.height - bg.top);
  });

  test('shifts cards in same column down to maintain gap', () => {
    // Two cards in right column, 90px each, 20px gap (140-230, 250-340).
    // Each contains a 2-line desc that needs ~48px → bg should grow → card 2 must shift.
    const els: PPTElement[] = [
      shape('bg1', 550, 140, 390, 90),
      text(
        't1',
        570,
        150,
        360,
        52,
        '<p style="font-size: 20px;"><strong>1. Источник кислорода</strong></p>',
      ),
      text(
        'd1',
        570,
        185,
        360,
        46,
        '<p style="font-size: 16px;">Накопление O₂ в атмосфере, необходимого для дыхания.</p>',
      ),
      shape('bg2', 550, 250, 390, 90),
      text(
        't2',
        570,
        260,
        360,
        52,
        '<p style="font-size: 20px;"><strong>2. Основа пищевых цепей</strong></p>',
      ),
      text(
        'd2',
        570,
        295,
        360,
        46,
        '<p style="font-size: 16px;">Растения кормят травоядных, а те — хищников.</p>',
      ),
    ];
    const { elements } = fitSlideLayout(els, CANVAS);
    const bg1 = elements.find((e) => e.id === 'bg1') as PPTShapeElement;
    const bg2 = elements.find((e) => e.id === 'bg2') as PPTShapeElement;
    const t2 = elements.find((e) => e.id === 't2') as PPTTextElement;
    expect(bg1.height).toBeGreaterThan(90);
    // bg2 must start AFTER bg1 ends (no overlap)
    expect(bg2.top).toBeGreaterThanOrEqual(bg1.top + bg1.height);
    // text inside bg2 must follow bg2 (was shifted in lockstep)
    expect(t2.top).toBeGreaterThanOrEqual(bg2.top);
  });

  test('grows colored stripe in lockstep with bg shape', () => {
    // bg + colored 8px-wide stripe at same top, same height.
    const els: PPTElement[] = [
      shape('bg', 550, 140, 390, 90),
      shape('stripe', 550, 140, 8, 90, '#2196f3'),
      text(
        'd',
        570,
        185,
        360,
        46,
        '<p style="font-size: 16px;">Накопление O₂ в атмосфере, необходимого для дыхания.</p>',
      ),
    ];
    const { elements } = fitSlideLayout(els, CANVAS);
    const bg = elements.find((e) => e.id === 'bg') as PPTShapeElement;
    const stripe = elements.find((e) => e.id === 'stripe') as PPTShapeElement;
    expect(bg.height).toBeGreaterThan(90);
    expect(stripe.height).toBe(bg.height);
    expect(stripe.top).toBe(bg.top);
  });

  test('fixes title-description overlap inside a card', () => {
    const els: PPTElement[] = [
      shape('bg', 550, 140, 390, 90),
      // title H=52 ends at 202, but desc starts at 185 → overlap
      text(
        't',
        570,
        150,
        360,
        52,
        '<p style="font-size: 20px;"><strong>Заголовок</strong></p>',
      ),
      text(
        'd',
        570,
        185,
        360,
        46,
        '<p style="font-size: 16px;">Описание.</p>',
      ),
    ];
    const { elements } = fitSlideLayout(els, CANVAS);
    const t = elements.find((e) => e.id === 't') as PPTTextElement;
    const d = elements.find((e) => e.id === 'd') as PPTTextElement;
    // d.top must be >= t.top + t.height (no overlap)
    expect(d.top).toBeGreaterThanOrEqual(t.top + t.height);
  });

  test('warns when result overflows viewport', () => {
    // Place a tall text near the bottom that, after measuring, exceeds canvas height.
    const els: PPTElement[] = [
      text(
        'x',
        50,
        500,
        300,
        20,
        // 5+ lines worth at 20px wrapping in 300px width
        '<p style="font-size: 20px;">' +
          'Очень длинный текст, который никак не помещается в свой бокс и растёт вниз гораздо ниже viewport-границы canvas-а слайда.'.repeat(
            3,
          ) +
          '</p>',
      ),
    ];
    const { warnings } = fitSlideLayout(els, CANVAS);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/overflow/i);
  });

  test('does not modify the input array (returns new objects)', () => {
    const original = text(
      't',
      0,
      0,
      300,
      20,
      '<p style="font-size: 16px;">Длинный текст русский, не помещается в маленький бокс.</p>',
    );
    const els: PPTElement[] = [original];
    const { elements } = fitSlideLayout(els, CANVAS);
    expect(original.height).toBe(20); // unchanged
    expect(elements[0]).not.toBe(original);
    expect((elements[0] as PPTTextElement).height).toBeGreaterThan(20);
  });

  test('handles empty / single-element inputs', () => {
    expect(fitSlideLayout([], CANVAS).elements).toEqual([]);
    const single: PPTElement[] = [
      text('t', 0, 0, 300, 30, '<p style="font-size: 16px;">x</p>'),
    ];
    const { elements, warnings } = fitSlideLayout(single, CANVAS);
    expect(elements).toHaveLength(1);
    expect(warnings).toEqual([]);
  });
});
