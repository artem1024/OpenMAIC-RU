/**
 * slide-layout-fit.ts
 *
 * Post-processes AI-generated slide canvas elements to fix layout issues
 * caused by Russian/Cyrillic text being longer than fixed-height containers
 * the AI emits.
 *
 * Pipeline:
 *   1. Measure required height of every text element from its rendered length.
 *   2. Grow background shape elements to wrap their contained texts.
 *   3. Shift cards (groups of elements stacked vertically in the same column)
 *      down so they don't overlap after step 2.
 *   4. Warn if the result overflows the viewport (caller decides what to do).
 */
import type { PPTElement, PPTTextElement, PPTShapeElement } from '@/lib/types/slides';

/**
 * Subset of PPTElement that has a `height` property (everything except
 * PPTLineElement, which uses start/end coordinates instead).
 */
type Sized = Exclude<PPTElement, { type: 'line' }>;

function hasHeight(el: PPTElement): el is Sized {
  return el.type !== 'line';
}

// Approx average glyph width (in font-size units) for Cyrillic mixed with
// digits/latin. Calibrated against the slide-content prompt's 1000×562 canvas
// and 16-20px text. Slightly wider than CJK because Cyrillic glyphs are
// proportional and tend to be wider than Han.
const CHAR_WIDTH_RATIO = 0.55;

// Default line-height multiplier when text element omits lineHeight.
const DEFAULT_LINE_HEIGHT = 1.5;

// Inner padding inside shape backgrounds (top + bottom).
const SHAPE_PADDING = 5;

// Minimum gap to enforce between sibling cards when shifting.
const CARD_GAP = 10;

// Tolerance for bbox containment / overlap checks (handles AI off-by-1).
const BBOX_TOL = 3;

interface FitResult {
  elements: PPTElement[];
  warnings: string[];
}

/** Strip HTML tags but preserve paragraph boundaries as `\n`. */
function stripHtml(html: string): string[] {
  if (!html) return [''];
  // Split on </p> boundaries first to count paragraphs.
  const paragraphs = html
    .split(/<\/p>/i)
    .map((p) => p.replace(/<[^>]+>/g, '').trim())
    .filter((p) => p.length > 0);
  return paragraphs.length > 0 ? paragraphs : [html.replace(/<[^>]+>/g, '').trim()];
}

/** Extract the first inline `font-size: Npx` from HTML content. */
function extractFontSize(html: string, fallback: number): number {
  const m = html.match(/font-size\s*:\s*(\d+(?:\.\d+)?)\s*px/i);
  return m ? parseFloat(m[1]) : fallback;
}

/**
 * Estimate the rendered height of a text element.
 *
 * Algorithm: for each `<p>` paragraph, compute chars_per_line from width and
 * font-size, then lines = ceil(plain_chars / chars_per_line), paragraph
 * height = lines × font_size × line_height. Sum across paragraphs and add a
 * small breathing-room pad. Always returns at least one line of font-size.
 */
export function measureTextHeight(
  content: string,
  width: number,
  fontSizeFallback = 16,
  lineHeightMul = DEFAULT_LINE_HEIGHT,
): number {
  const fontSize = extractFontSize(content, fontSizeFallback);
  const paragraphs = stripHtml(content);
  const charsPerLine = Math.max(1, Math.floor(width / (fontSize * CHAR_WIDTH_RATIO)));
  let totalLines = 0;
  for (const p of paragraphs) {
    // Count grapheme-ish chars: subscript digits/entities collapse to ~1 char.
    const len = Math.max(1, [...p].length);
    totalLines += Math.max(1, Math.ceil(len / charsPerLine));
  }
  const height = totalLines * fontSize * lineHeightMul;
  // small breathing pad so descenders don't kiss the bottom edge
  return Math.ceil(height + 4);
}

function isText(el: PPTElement): el is PPTTextElement {
  return el.type === 'text';
}
function isShape(el: PPTElement): el is PPTShapeElement {
  return el.type === 'shape';
}

function bboxContains(outer: Sized, inner: Sized, tol = BBOX_TOL): boolean {
  return (
    inner.left + tol >= outer.left &&
    inner.left + inner.width <= outer.left + outer.width + tol &&
    inner.top + tol >= outer.top &&
    inner.top + inner.height <= outer.top + outer.height + tol
  );
}

/**
 * Group elements into cards. A card = a background shape + all elements that
 * are bbox-contained in it. An element may belong to at most one card (the
 * smallest containing shape wins). Elements not contained anywhere are kept
 * as singletons.
 */
interface Card {
  bg: PPTShapeElement | null; // null for singleton non-shape elements
  members: Sized[]; // including bg if present
  top: number;
  bottom: number;
  left: number;
  right: number;
}

function buildCards(elements: Sized[]): Card[] {
  const shapes = elements.filter(isShape);
  // For each non-shape, find the smallest shape containing it.
  // For each shape, find the smallest *other* shape containing it (a card bg
  // can itself be inside a larger decorative frame — we want the inner one).
  const ownerByEl = new Map<string, PPTShapeElement>();
  for (const el of elements) {
    let bestOwner: PPTShapeElement | null = null;
    let bestArea = Infinity;
    for (const s of shapes) {
      if (s.id === el.id) continue;
      if (!bboxContains(s, el)) continue;
      const area = s.width * s.height;
      if (area < bestArea) {
        bestArea = area;
        bestOwner = s;
      }
    }
    if (bestOwner) ownerByEl.set(el.id, bestOwner);
  }

  const cardByBgId = new Map<string, Card>();
  const orphans: Sized[] = [];
  for (const el of elements) {
    const owner = ownerByEl.get(el.id);
    if (!owner) {
      // Element is not contained in any other shape. If it's a shape that
      // owns members, it's a card bg; otherwise it's an orphan.
      const ownsMembers = elements.some((e) => ownerByEl.get(e.id)?.id === el.id);
      if (isShape(el) && ownsMembers) {
        if (!cardByBgId.has(el.id)) {
          cardByBgId.set(el.id, {
            bg: el,
            members: [el],
            top: el.top,
            bottom: el.top + el.height,
            left: el.left,
            right: el.left + el.width,
          });
        }
      } else {
        orphans.push(el);
      }
    } else {
      let card = cardByBgId.get(owner.id);
      if (!card) {
        card = {
          bg: owner,
          members: [owner],
          top: owner.top,
          bottom: owner.top + owner.height,
          left: owner.left,
          right: owner.left + owner.width,
        };
        cardByBgId.set(owner.id, card);
      }
      card.members.push(el);
    }
  }

  const cards: Card[] = [...cardByBgId.values()];
  for (const o of orphans) {
    cards.push({
      bg: null,
      members: [o],
      top: o.top,
      bottom: o.top + o.height,
      left: o.left,
      right: o.left + o.width,
    });
  }
  return cards;
}

/** Group cards into vertical columns by horizontal overlap. */
function groupColumns(cards: Card[]): Card[][] {
  const remaining = [...cards];
  const columns: Card[][] = [];
  while (remaining.length > 0) {
    const seed = remaining.shift()!;
    const col: Card[] = [seed];
    for (let i = remaining.length - 1; i >= 0; i--) {
      const c = remaining[i];
      // horizontal overlap with seed bg or any member
      if (c.left < seed.right && seed.left < c.right) {
        col.push(c);
        remaining.splice(i, 1);
      }
    }
    col.sort((a, b) => a.top - b.top);
    columns.push(col);
  }
  return columns;
}

/**
 * Within a single card: ensure text elements have correct height, fix
 * overlaps between texts, grow the bg shape to wrap them. Returns the new
 * card height delta (final_height - original_height); always >= 0.
 */
function fitCard(card: Card): number {
  // Re-measure all texts in card. Don't shrink (preserve AI-chosen visual rhythm).
  for (const m of card.members) {
    if (!isText(m)) continue;
    const required = measureTextHeight(m.content, m.width, 16, m.lineHeight ?? DEFAULT_LINE_HEIGHT);
    if (required > m.height) m.height = required;
  }

  // Sort texts top-to-bottom, fix vertical overlaps among them.
  const texts = card.members.filter(isText).sort((a, b) => a.top - b.top);
  for (let i = 1; i < texts.length; i++) {
    const prev = texts[i - 1];
    const cur = texts[i];
    const minTop = prev.top + prev.height; // no extra gap — text elements already include leading
    if (cur.top < minTop) cur.top = minTop;
  }

  if (!card.bg) {
    // Singleton: card height = element height; no shape to grow.
    const newBottom = Math.max(...card.members.map((m) => m.top + m.height));
    const delta = newBottom - card.bottom;
    card.bottom = newBottom;
    return Math.max(0, delta);
  }

  // Compute required shape height = max member bottom relative to bg.top + padding.
  const memberBottoms = card.members
    .filter((m) => m.id !== card.bg!.id)
    .map((m) => m.top + m.height);
  if (memberBottoms.length === 0) return 0;
  const maxMemberBottom = Math.max(...memberBottoms);
  const requiredBgBottom = maxMemberBottom + SHAPE_PADDING;
  const requiredBgHeight = requiredBgBottom - card.bg.top;

  let delta = 0;
  if (requiredBgHeight > card.bg.height) {
    delta = requiredBgHeight - card.bg.height;
    card.bg.height = requiredBgHeight;
    card.bottom = card.bg.top + card.bg.height;

    // Other shape members that span the full height of the bg (e.g. a colored
    // left stripe with same top and same height) — grow them in lockstep.
    for (const m of card.members) {
      if (m.id === card.bg.id) continue;
      if (!isShape(m)) continue;
      const wasFullHeight = Math.abs(m.top - card.bg.top) <= BBOX_TOL;
      const wasFullHeightCovered =
        Math.abs(m.top + m.height - (card.bg.top + (card.bg.height - delta))) <= BBOX_TOL;
      if (wasFullHeight && wasFullHeightCovered) {
        m.height = card.bg.height;
      }
    }
  } else {
    card.bottom = card.bg.top + card.bg.height;
  }
  return delta;
}

/** Shift every element in a card down by dy (mutates). */
function shiftCard(card: Card, dy: number) {
  if (dy === 0) return;
  for (const m of card.members) {
    m.top += dy;
  }
  card.top += dy;
  card.bottom += dy;
}

export function fitSlideLayout(
  elements: PPTElement[],
  canvas: { width: number; height: number },
): FitResult {
  const warnings: string[] = [];
  if (!elements || elements.length === 0) return { elements: elements ?? [], warnings };

  // Work on shallow copies — caller treats result as new state.
  const cloned: PPTElement[] = elements.map((e) => ({ ...e }));

  // Skip line elements: they use start/end coordinates, not top/height. They
  // pass through untouched and are not laid out by this pass.
  const sized = cloned.filter(hasHeight);

  const cards = buildCards(sized);

  // Step 1+2: fit each card individually (measure texts, grow shape).
  for (const c of cards) {
    fitCard(c);
  }

  // Step 3: per-column vertical reflow — push cards below down to maintain order.
  const columns = groupColumns(cards);
  for (const col of columns) {
    for (let i = 1; i < col.length; i++) {
      const prev = col[i - 1];
      const cur = col[i];
      // If `cur` was originally below prev's original bottom but prev now ends
      // past cur.top, shift cur (and propagate to subsequent cards).
      const prevBottom = prev.bottom;
      if (cur.top < prevBottom + CARD_GAP) {
        const dy = prevBottom + CARD_GAP - cur.top;
        for (let j = i; j < col.length; j++) shiftCard(col[j], dy);
      }
    }
  }

  // Step 4: warn if anything ended up outside the viewport vertically.
  let maxBottom = 0;
  for (const e of sized) {
    const b = e.top + e.height;
    if (b > maxBottom) maxBottom = b;
  }
  if (maxBottom > canvas.height + BBOX_TOL) {
    warnings.push(
      `slide-layout-fit: vertical overflow — max element bottom ${maxBottom.toFixed(
        1,
      )}px exceeds canvas height ${canvas.height}px`,
    );
  }

  return { elements: cloned, warnings };
}
