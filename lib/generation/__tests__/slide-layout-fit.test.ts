/**
 * Tests for slide-layout-fit — the post-process pass that grows shape
 * heights and shifts stacked cards to accommodate longer-than-anticipated
 * Cyrillic text returned by the AI.
 */
import { describe, test, expect } from 'vitest';
import { fitSlideLayout, measureTextHeight } from '../slide-layout-fit';
import type {
  PPTElement,
  PPTLatexElement,
  PPTShapeElement,
  PPTTableElement,
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

function latex(
  id: string,
  left: number,
  top: number,
  width: number,
  height: number,
): PPTLatexElement {
  return {
    id,
    type: 'latex',
    left,
    top,
    width,
    height,
    rotate: 0,
    latex: 'E = mc^2',
    html: '<span>E = mc^2</span>',
  };
}

function table(
  id: string,
  left: number,
  top: number,
  width: number,
  height: number,
): PPTTableElement {
  return {
    id,
    type: 'table',
    left,
    top,
    width,
    height,
    rotate: 0,
    colWidths: [0.34, 0.33, 0.33],
    cellMinHeight: 30,
    outline: { width: 1, style: 'solid', color: '#cbd5e1' },
    data: [
      [
        { id: `${id}-r1c1`, text: 'Параметр', colspan: 1, rowspan: 1 },
        { id: `${id}-r1c2`, text: 'Нейрон', colspan: 1, rowspan: 1 },
        { id: `${id}-r1c3`, text: 'Сеть', colspan: 1, rowspan: 1 },
      ],
      [
        { id: `${id}-r2c1`, text: 'Роль', colspan: 1, rowspan: 1 },
        { id: `${id}-r2c2`, text: 'Сигнал', colspan: 1, rowspan: 1 },
        { id: `${id}-r2c3`, text: 'Обучение', colspan: 1, rowspan: 1 },
      ],
    ],
  };
}

describe('measureTextHeight', () => {
  test('single short line at 16px in 360px width returns one-line height', () => {
    const h = measureTextHeight('<p style="font-size: 16px;">Короткий текст</p>', 360);
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
      text('t', 570, 150, 360, 52, '<p style="font-size: 20px;"><strong>Заголовок</strong></p>'),
      text('d', 570, 185, 360, 46, '<p style="font-size: 16px;">Описание.</p>'),
    ];
    const { elements } = fitSlideLayout(els, CANVAS);
    const t = elements.find((e) => e.id === 't') as PPTTextElement;
    const d = elements.find((e) => e.id === 'd') as PPTTextElement;
    // d.top must be >= t.top + t.height (no overlap)
    expect(d.top).toBeGreaterThanOrEqual(t.top + t.height);
  });

  test('F6 latex flow: growing text pushes formula down and grows shape', () => {
    const els: PPTElement[] = [
      shape('bg', 60, 100, 420, 120),
      text(
        'body',
        80,
        120,
        380,
        40,
        '<p style="font-size: 18px;">' +
          'Градиент показывает направление наибольшего роста функции, поэтому при обучении мы движемся в противоположную сторону, уменьшая ошибку модели. '.repeat(
            2,
          ) +
          '</p>',
      ),
      latex('formula', 80, 170, 380, 40),
    ];
    const { elements } = fitSlideLayout(els, CANVAS);
    const bg = elements.find((e) => e.id === 'bg') as PPTShapeElement;
    const body = elements.find((e) => e.id === 'body') as PPTTextElement;
    const formula = elements.find((e) => e.id === 'formula') as PPTLatexElement;

    expect(body.height).toBeGreaterThan(40);
    expect(formula.top).toBeGreaterThanOrEqual(body.top + body.height);
    expect(bg.height).toBeGreaterThan(120);
    expect(bg.top + bg.height).toBeGreaterThanOrEqual(formula.top + formula.height);
  });

  test('F6 latex flow: formula outside the card is not moved by card text', () => {
    const els: PPTElement[] = [
      shape('bg', 60, 100, 420, 120),
      text(
        'body',
        80,
        120,
        380,
        40,
        '<p style="font-size: 18px;">' +
          'Длинное описание внутри карточки должно растянуть фон, но не должно влиять на формулу в соседней области слайда. '.repeat(
            2,
          ) +
          '</p>',
      ),
      latex('formula', 600, 170, 300, 40),
    ];
    const { elements } = fitSlideLayout(els, CANVAS);
    const formula = elements.find((e) => e.id === 'formula') as PPTLatexElement;
    expect(formula.top).toBe(170);
  });

  test('P2 table flow: table inside a card moves below expanded text', () => {
    const els: PPTElement[] = [
      shape('bg', 350, 380, 520, 181),
      text(
        'body',
        370,
        396,
        480,
        165,
        '<p style="font-size: 18px;">' +
          'Биологический нейрон получает сигналы через дендриты, суммирует их и передает импульс дальше. '.repeat(
            2,
          ) +
          '</p>',
      ),
      table('comparison', 370, 431, 480, 130),
    ];
    const { elements, metrics } = fitSlideLayout(els, CANVAS);
    const body = elements.find((e) => e.id === 'body') as PPTTextElement;
    const comparison = elements.find((e) => e.id === 'comparison') as PPTTableElement;

    expect(comparison.top).toBeGreaterThanOrEqual(body.top + body.height);
    expect(metrics.residualOverlapPx).toBe(0);
    expect(metrics.overlapElementIds).toEqual([]);
  });

  test('P2 table flow: table below a short title remains stable', () => {
    const els: PPTElement[] = [
      shape('bg', 80, 60, 520, 260),
      text('title', 100, 80, 480, 30, '<p style="font-size: 20px;">Аналогия структур</p>'),
      table('comparison', 100, 130, 480, 130),
    ];
    const { elements, metrics } = fitSlideLayout(els, CANVAS);
    const comparison = elements.find((e) => e.id === 'comparison') as PPTTableElement;

    expect(comparison.top).toBe(130);
    expect(metrics.residualOverlapPx).toBe(0);
  });

  test('P1 generic overlap metrics: catches residual text-text overlap across split columns', () => {
    const els: PPTElement[] = [
      text('seed', 0, 10, 100, 40, '<p style="font-size: 16px;">A</p>'),
      text('bridge', 80, 100, 120, 80, '<p style="font-size: 16px;">B</p>'),
      text('overlap', 170, 120, 100, 80, '<p style="font-size: 16px;">C</p>'),
    ];
    const { metrics, warnings } = fitSlideLayout(els, CANVAS);

    expect(metrics.residualOverlapPx).toBeGreaterThan(10);
    expect(metrics.overlapElementIds).toEqual(expect.arrayContaining(['bridge', 'overlap']));
    expect(warnings.some((w) => w.includes('residual overlap'))).toBe(true);
  });

  test('F5 wide text collision: lower card in another column shifts below intro text', () => {
    const els: PPTElement[] = [
      shape('left', 60, 190, 360, 120),
      shape('right', 650, 190, 280, 120),
      text('intro', 150, 100, 700, 120, '<p style="font-size: 18px;">Краткое вступление.</p>'),
    ];
    const { elements, metrics } = fitSlideLayout(els, CANVAS);
    const intro = elements.find((e) => e.id === 'intro') as PPTTextElement;
    const right = elements.find((e) => e.id === 'right') as PPTShapeElement;

    expect(right.top).toBeGreaterThanOrEqual(intro.top + intro.height + 10);
    expect(metrics.residualCollisionPx).toBe(0);
    expect(metrics.collisionElementIds).toEqual([]);
  });

  test('F5 wide text collision: impossible shift records retry metrics', () => {
    const els: PPTElement[] = [
      shape('left', 60, 270, 360, 100),
      shape('right', 650, 270, 280, 285),
      text('intro', 150, 100, 700, 190, '<p style="font-size: 18px;">Краткое вступление.</p>'),
    ];
    const { elements, metrics, warnings } = fitSlideLayout(els, CANVAS);
    const right = elements.find((e) => e.id === 'right') as PPTShapeElement;

    expect(right.top).toBe(270);
    expect(metrics.residualCollisionPx).toBeGreaterThan(10);
    expect(metrics.collisionElementIds).toEqual(expect.arrayContaining(['intro', 'right']));
    expect(warnings.some((w) => w.includes('residual collision'))).toBe(true);
  });

  test('warns when overflow cannot be fixed by pull-up or squeeze', () => {
    // Text starts near the top (no headroom to pull up) and is so tall it
    // overflows even after fitting. Single-element column has no gaps to squeeze.
    const els: PPTElement[] = [
      text(
        'x',
        50,
        10,
        300,
        20,
        '<p style="font-size: 20px;">' +
          'Очень длинный текст, который никак не помещается в свой бокс и растёт вниз гораздо ниже viewport-границы canvas-а слайда.'.repeat(
            5,
          ) +
          '</p>',
      ),
    ];
    const { warnings } = fitSlideLayout(els, CANVAS);
    expect(warnings.some((w) => /overflow/i.test(w))).toBe(true);
  });

  test('pulls a single-card column up when the card overflows and has headroom', () => {
    // Card at top=500 with computed bottom=680 → overflows 562.5 canvas.
    // With 500px of headroom above, pull-up should move it entirely into view.
    const els: PPTElement[] = [
      shape('bg', 60, 500, 420, 180),
      text(
        'hdr',
        80,
        520,
        380,
        52,
        '<p style="font-size: 20px;"><strong>Исторический контекст</strong></p>',
      ),
      text(
        'body',
        80,
        572,
        380,
        103,
        '<p style="font-size: 18px;">• Пункт один</p><p style="font-size: 18px;">• Пункт два</p><p style="font-size: 18px;">• Пункт три</p>',
      ),
    ];
    const { elements, warnings } = fitSlideLayout(els, CANVAS);
    const bg = elements.find((e) => e.id === 'bg') as PPTShapeElement;
    const body = elements.find((e) => e.id === 'body') as PPTTextElement;
    // Pulled up enough that nothing overflows.
    expect(bg.top + bg.height).toBeLessThanOrEqual(CANVAS.height + 3);
    expect(body.top + body.height).toBeLessThanOrEqual(CANVAS.height + 3);
    // Order preserved: body still after header.
    expect(body.top).toBeGreaterThan(bg.top);
    expect(warnings.filter((w) => /residual/i.test(w))).toHaveLength(0);
  });

  test('squeezes inter-card gaps when column still overflows after pull-up', () => {
    // Three cards at top=10, 200, 400. Top card already at minimum — no pull-up possible.
    // Gaps 90+90 = 180px of squeeze room. Overflow must be satisfied by squeezing.
    const els: PPTElement[] = [
      shape('c1', 60, 10, 400, 100),
      shape('c2', 60, 200, 400, 100),
      shape('c3', 60, 400, 400, 200), // bottom=600 → overflow 42.5
    ];
    const { elements } = fitSlideLayout(els, CANVAS);
    const c3 = elements.find((e) => e.id === 'c3') as PPTShapeElement;
    expect(c3.top + c3.height).toBeLessThanOrEqual(CANVAS.height + 3);
  });

  test('drops cards that pull-up+squeeze cannot rescue', () => {
    // c1 fills most of the viewport → no headroom, no squeezable gap for c2.
    // c2 at top=700 cannot be brought back — drop it.
    const els: PPTElement[] = [
      shape('c1', 60, 10, 400, 545),
      shape('below', 60, 700, 400, 100),
      text('bt', 80, 720, 360, 60, '<p style="font-size: 16px;">invisible</p>'),
    ];
    const { elements, warnings } = fitSlideLayout(els, CANVAS);
    expect(elements.find((e) => e.id === 'below')).toBeUndefined();
    expect(elements.find((e) => e.id === 'bt')).toBeUndefined();
    expect(elements.find((e) => e.id === 'c1')).toBeDefined();
    expect(warnings.some((w) => /dropped/i.test(w))).toBe(true);
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
    const single: PPTElement[] = [text('t', 0, 0, 300, 30, '<p style="font-size: 16px;">x</p>')];
    const { elements, warnings } = fitSlideLayout(single, CANVAS);
    expect(elements).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  // Regression: L5.S8 «Градиентный спуск» — three cards with a 60px-tall
  // shape and an 86px-tall text. Text vertically overflows the shape, so
  // pre-B1 bbox containment failed and the text became an orphan; the shape
  // never grew, and texts visually leaked into the next card. With B1's
  // alignment-based ownership, each text is a member of its shape, the
  // shape grows, and subsequent cards shift down without overlap.
  test('B1 cascade: over-tall text becomes shape member via alignment', () => {
    const longContent =
      '<p style="font-size: 18px;">Метод оптимизации, который использует градиент для пошагового движения к минимуму функции потерь — основа обучения нейросетей.</p>';
    const els: PPTElement[] = [
      shape('card1', 60, 50, 880, 60, '#e8f7f8'),
      text('text1', 80, 60, 840, 86, longContent),
      shape('card2', 60, 130, 880, 60, '#e8f7f8'),
      text('text2', 80, 140, 840, 86, longContent),
      shape('card3', 60, 210, 880, 60, '#e8f7f8'),
      text('text3', 80, 220, 840, 86, longContent),
    ];
    const { elements } = fitSlideLayout(els, CANVAS);
    const card1 = elements.find((e) => e.id === 'card1') as PPTShapeElement;
    const card2 = elements.find((e) => e.id === 'card2') as PPTShapeElement;
    const card3 = elements.find((e) => e.id === 'card3') as PPTShapeElement;
    const text1 = elements.find((e) => e.id === 'text1') as PPTTextElement;
    const text3 = elements.find((e) => e.id === 'text3') as PPTTextElement;

    // All three shapes grew to wrap their text members.
    expect(card1.height).toBeGreaterThan(60);
    expect(card2.height).toBeGreaterThan(60);
    expect(card3.height).toBeGreaterThan(60);

    // Cards shifted down so no overlap between consecutive cards.
    expect(card2.top).toBeGreaterThanOrEqual(card1.top + card1.height);
    expect(card3.top).toBeGreaterThanOrEqual(card2.top + card2.height);

    // Texts moved with their shapes (lockstep).
    expect(text1.top).toBeGreaterThanOrEqual(card1.top);
    expect(text3.top).toBeGreaterThanOrEqual(card3.top);

    // Nothing was dropped — all six elements remain.
    expect(elements).toHaveLength(6);
  });

  // Regression: accent-stripe pattern. A 5px-wide colored stripe sits at the
  // exact (left, top) of a card bg of the same height. With B1's alignment
  // path, isShape(stripe) → null, so the stripe is matched to the bg via
  // bbox only, becoming a true card member that grows in lockstep.
  test('B1 accent stripe: over-tall text grows bg, skinny stripe locks via bbox', () => {
    const els: PPTElement[] = [
      shape('bg', 60, 200, 450, 60, '#ffffff'),
      shape('stripe', 60, 200, 5, 60, '#00b7c2'),
      text(
        'desc',
        80,
        207,
        420,
        86,
        '<p style="font-size: 18px;">Развитие архитектур: от перцептрона Розенблатта через CNN и RNN к современным трансформерам ChatGPT.</p>',
      ),
    ];
    const { elements } = fitSlideLayout(els, CANVAS);
    const bg = elements.find((e) => e.id === 'bg') as PPTShapeElement;
    const stripe = elements.find((e) => e.id === 'stripe') as PPTShapeElement;

    expect(bg.height).toBeGreaterThan(60);
    expect(stripe.height).toBe(bg.height);
    expect(stripe.top).toBe(bg.top);
  });

  // Regression: a slim underline shape (height=3) sitting just below a title
  // text must NOT become a member of the title and must NOT be claimed by
  // any other element. Pre-B1 bbox-only logic already kept it singleton;
  // the test guards against alignment guards being relaxed accidentally.
  test('B1 title-underline: slim shape stays singleton, never coupled to title', () => {
    const els: PPTElement[] = [
      text(
        'title',
        60,
        10,
        880,
        80,
        '<p style="font-size: 32px;"><strong>История нейросетей</strong></p>',
      ),
      shape('underline', 60, 88, 880, 3, '#00b7c2'),
    ];
    const { elements } = fitSlideLayout(els, CANVAS);
    const underline = elements.find((e) => e.id === 'underline') as PPTShapeElement;

    // Underline keeps its decorative height — never grew with title content.
    expect(underline.height).toBe(3);
    // Underline keeps its original left/width — wasn't pulled into a card.
    expect(underline.left).toBe(60);
    expect(underline.width).toBe(880);
  });

  test('P4 contrast guard: white title below dark header is recolored', () => {
    const title = text(
      'title',
      80,
      98,
      840,
      70,
      '<p style="font-size: 32px; color: #ffffff;"><strong>Проблема выравнивания</strong></p>',
    );
    title.defaultColor = '#ffffff';

    const { elements, warnings } = fitSlideLayout(
      [shape('header', 0, 0, 1000, 90, '#1e40af'), title],
      CANVAS,
    );
    const fittedTitle = elements.find((e) => e.id === 'title') as PPTTextElement;

    expect(fittedTitle.defaultColor).toBe('#1f2937');
    expect(fittedTitle.content).toContain('color: #1f2937');
    expect(warnings.some((w) => w.includes('low-contrast white text'))).toBe(true);
  });

  test('P4 contrast guard: white title inside dark header stays white', () => {
    const title = text(
      'title',
      80,
      20,
      840,
      50,
      '<p style="font-size: 32px; color: #ffffff;"><strong>Проблема выравнивания</strong></p>',
    );
    title.defaultColor = '#ffffff';

    const { elements, warnings } = fitSlideLayout(
      [shape('header', 0, 0, 1000, 90, '#1e40af'), title],
      CANVAS,
    );
    const fittedTitle = elements.find((e) => e.id === 'title') as PPTTextElement;

    expect(fittedTitle.defaultColor).toBe('#ffffff');
    expect(fittedTitle.content).toContain('color: #ffffff');
    expect(warnings.some((w) => w.includes('low-contrast white text'))).toBe(false);
  });

  test('P4 contrast guard: non-white text is unchanged on light background', () => {
    const title = text(
      'title',
      80,
      98,
      840,
      70,
      '<p style="font-size: 32px; color: #334155;"><strong>Проблема выравнивания</strong></p>',
    );
    title.defaultColor = '#334155';

    const { elements } = fitSlideLayout([title], CANVAS);
    const fittedTitle = elements.find((e) => e.id === 'title') as PPTTextElement;

    expect(fittedTitle.defaultColor).toBe('#334155');
    expect(fittedTitle.content).toContain('color: #334155');
  });

  test('Б5 metrics — fitting slide returns zeroed metrics', () => {
    const els: PPTElement[] = [
      shape('bg', 60, 60, 880, 100),
      text('title', 80, 80, 840, 40, '<p style="font-size: 24px;">Заголовок</p>'),
    ];
    const result = fitSlideLayout(els, CANVAS);
    expect(result.metrics).toBeDefined();
    expect(result.metrics.residualOverflowPx).toBe(0);
    expect(result.metrics.residualCollisionPx).toBe(0);
    expect(result.metrics.residualOverlapPx).toBe(0);
    expect(result.metrics.residualClippedPx).toBe(0);
    expect(result.metrics.collisionElementIds).toEqual([]);
    expect(result.metrics.overlapElementIds).toEqual([]);
    expect(result.metrics.droppedElementIds).toEqual([]);
    expect(result.metrics.overflowElementIds).toEqual([]);
  });

  test('Б5 metrics — empty input returns zeroed metrics', () => {
    const result = fitSlideLayout([], CANVAS);
    expect(result.elements).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.metrics.residualOverflowPx).toBe(0);
    expect(result.metrics.residualCollisionPx).toBe(0);
    expect(result.metrics.residualOverlapPx).toBe(0);
    expect(result.metrics.residualClippedPx).toBe(0);
    expect(result.metrics.collisionElementIds).toEqual([]);
    expect(result.metrics.overlapElementIds).toEqual([]);
    expect(result.metrics.droppedElementIds).toEqual([]);
    expect(result.metrics.overflowElementIds).toEqual([]);
  });
});
