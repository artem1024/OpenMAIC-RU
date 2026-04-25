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
import { estimateTextHeight } from '../slide-layout-fix';

describe('estimateTextHeight (Б2a)', () => {
  test('plain <p> text — single short line at 18px in 400px width', () => {
    const h = estimateTextHeight(
      '<p style="font-size: 18px;">Короткий текст.</p>',
      400,
    );
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
    const oneLine = estimateTextHeight(
      '<p style="font-size: 16px;">A B C</p>',
      400,
    );
    for (const br of ['<br>', '<br/>', '<br />', '<BR/>']) {
      const twoLines = estimateTextHeight(
        `<p style="font-size: 16px;">A${br}B${br}C</p>`,
        400,
      );
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
    const single = estimateTextHeight(
      '<p style="font-size: 16px;">Текст</p>',
      400,
    );
    const double = estimateTextHeight(
      '<p style="font-size: 16px;">Текст</p><p style="font-size: 16px;">Ещё текст</p>',
      400,
    );
    expect(double).toBeGreaterThan(single);
  });

  test('<li>, <ul>, <h2>, <blockquote> all act as block tags', () => {
    const para = estimateTextHeight(
      '<p style="font-size: 16px;">Один Два Три</p>',
      400,
    );
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
