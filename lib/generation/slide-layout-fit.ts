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
 *   4. Pull overflowing columns up into spare headroom above them.
 *   5. Squeeze inter-card gaps in columns that still overflow.
 *   6. Drop cards that start entirely below the viewport (AI placed them there).
 *   7. Warn about any residual overflow.
 */
import type {
  PPTElement,
  PPTLatexElement,
  PPTTextElement,
  PPTShapeElement,
} from '@/lib/types/slides';

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

// Minimum gap to preserve when squeezing columns to fit viewport.
const MIN_SQUEEZED_GAP = 2;

// Top margin: pull-up never brings a card above this Y.
const MIN_COLUMN_TOP = 10;

// Safe bottom: we target leaving a small margin from the canvas edge.
const SAFE_BOTTOM_MARGIN = 5;

// Tolerance for bbox containment / overlap checks (handles AI off-by-1).
const BBOX_TOL = 3;

export interface FitMetrics {
  /** Max element bottom over canvas.height, 0 when slide fits. */
  residualOverflowPx: number;
  /** Max unresolved geometric collision after attempted reflow, 0 when none remain. */
  residualCollisionPx: number;
  /** Max (required - height) across text elements, 0 when nothing clipped. */
  residualClippedPx: number;
  /** IDs involved in unresolved collisions that should trigger a retry. */
  collisionElementIds: string[];
  /** IDs that Step 6 dropped because they sat entirely below the viewport. */
  droppedElementIds: string[];
  /** IDs whose bottom still exceeds canvas.height after the full pipeline. */
  overflowElementIds: string[];
}

export interface FitResult {
  elements: PPTElement[];
  warnings: string[];
  metrics: FitMetrics;
}

const EMPTY_METRICS: FitMetrics = {
  residualOverflowPx: 0,
  residualCollisionPx: 0,
  residualClippedPx: 0,
  collisionElementIds: [],
  droppedElementIds: [],
  overflowElementIds: [],
};

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
function isLatex(el: PPTElement): el is PPTLatexElement {
  return el.type === 'latex';
}
function isShape(el: PPTElement): el is PPTShapeElement {
  return el.type === 'shape';
}

function isFlowMember(el: PPTElement): el is PPTTextElement | PPTLatexElement {
  return isText(el) || isLatex(el);
}

function cardKey(card: Card): string {
  return card.bg?.id ?? card.members[0].id;
}

function overlapsX(a: { left: number; right: number }, b: { left: number; right: number }): boolean {
  return a.left < b.right && b.left < a.right;
}

interface CollisionReport {
  residualCollisionPx: number;
  collisionElementIds: Set<string>;
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

type OwnerMatch = { owner: PPTShapeElement; tightness: number; via: 'bbox' | 'align' };

function findBboxOwner(el: Sized, shapes: PPTShapeElement[]): OwnerMatch | null {
  let best: OwnerMatch | null = null;
  for (const s of shapes) {
    if (s.id === el.id) continue;
    if (!bboxContains(s, el)) continue;
    const area = s.width * s.height;
    if (!best || area < best.tightness) best = { owner: s, tightness: area, via: 'bbox' };
  }
  return best;
}

// Alignment-based ownership: the AI sometimes generates a text whose
// rendered height exceeds the bg shape (e.g. text height=86 inside a card
// shape height=60). bbox-containment fails, so the text becomes an orphan
// and the bg shape never grows. Alignment recovers these cases by treating
// a non-shape element as a member if it is left/top-aligned with a real
// card bg and horizontally fits inside it.
function findAlignmentOwner(el: Sized, shapes: PPTShapeElement[]): OwnerMatch | null {
  // Alignment owner only for non-shape (text/latex/image). Allowing shapes
  // here risks shape↔shape alignment cycles for nested or overlapping frames.
  if (isShape(el)) return null;

  let best: OwnerMatch | null = null;
  for (const bg of shapes) {
    if (bg.id === el.id) continue;
    // Skinny stripes / decorative thin bars cannot host members.
    if (bg.width < 80 || bg.height < 30) continue;
    // Tiny decorative elements should stay singletons.
    if (el.width < 20 || el.height < 20) continue;
    // Member must occupy a meaningful share of bg width.
    if (el.width < bg.width * 0.3) continue;

    const topAligned = Math.abs(el.top - bg.top) <= 10;
    const leftAligned = el.left >= bg.left - 2 && el.left <= bg.left + bg.width * 0.3;
    const xOverlap =
      Math.min(el.left + el.width, bg.left + bg.width) - Math.max(el.left, bg.left);
    const xOverlapPct = xOverlap / Math.min(el.width, bg.width);
    if (!(topAligned && leftAligned && xOverlapPct >= 0.7)) continue;

    const area = bg.width * bg.height;
    if (!best || area < best.tightness) best = { owner: bg, tightness: area, via: 'align' };
  }
  return best;
}

function buildCards(elements: Sized[]): Card[] {
  const shapes = elements.filter(isShape);
  // For each element, find an owner shape via bbox-containment OR
  // top/left-alignment. Both candidates compete: alignment wins when its
  // owner area is within 1.2× of the bbox owner (tighter or just slightly
  // larger), so an inner card beats an outer decorative frame even if the
  // text vertically overflows the inner card.
  const ownerByEl = new Map<string, PPTShapeElement>();
  for (const el of elements) {
    const bbox = findBboxOwner(el, shapes);
    const align = findAlignmentOwner(el, shapes);
    let chosen: OwnerMatch | null = null;
    if (bbox && align) {
      chosen = align.tightness <= bbox.tightness * 1.2 ? align : bbox;
    } else {
      chosen = align ?? bbox ?? null;
    }
    if (chosen) ownerByEl.set(el.id, chosen.owner);
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

  // Sort text/latex flow-members top-to-bottom and fix vertical overlaps.
  // Text can grow above; latex is rigid but must move when text expands.
  const flowMembers = card.members.filter(isFlowMember).sort((a, b) => a.top - b.top);
  for (let i = 1; i < flowMembers.length; i++) {
    const prev = flowMembers[i - 1];
    const cur = flowMembers[i];
    const minTop = prev.top + prev.height; // elements already include their own leading/padding
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

function shiftCardAndFollowing(columns: Card[][], target: Card, dy: number): boolean {
  const col = columns.find((candidate) => candidate.includes(target));
  if (!col) {
    shiftCard(target, dy);
    return true;
  }
  const start = col.indexOf(target);
  for (let i = start; i < col.length; i++) {
    shiftCard(col[i], dy);
  }
  return true;
}

function affectedCardsForShift(columns: Card[][], target: Card): Card[] {
  const col = columns.find((candidate) => candidate.includes(target));
  if (!col) return [target];
  const start = col.indexOf(target);
  return col.slice(start);
}

/**
 * Wide intro text is often emitted as a singleton text block spanning most of
 * the canvas, followed by cards below it. Column reflow only sees card columns,
 * so it can miss a cross-column intro→card collision. Resolve these collisions
 * late in the pipeline; if shifting would push a card below the safe viewport,
 * keep geometry stable and return metrics so the Б5 retry hook can simplify
 * the scene instead.
 */
function resolveWideTextCollisions(
  cards: Card[],
  columns: Card[][],
  canvasWidth: number,
  safeBottom: number,
): CollisionReport {
  const collisionElementIds = new Set<string>();
  let residualCollisionPx = 0;
  const wideTextCards = cards.filter((card) => {
    if (card.bg || card.members.length !== 1) return false;
    const member = card.members[0];
    return isText(member) && member.width >= canvasWidth * 0.6;
  });

  for (const textCard of wideTextCards) {
    const wideText = textCard.members[0] as PPTTextElement;
    const neededTop = wideText.top + wideText.height + CARD_GAP;
    const wideBounds = { left: wideText.left, right: wideText.left + wideText.width };

    for (const card of cards) {
      if (card === textCard) continue;
      if (card.top <= wideText.top) continue;
      if (!overlapsX(wideBounds, card)) continue;
      if (card.top >= neededTop || card.bottom <= wideText.top) continue;

      const dy = neededTop - card.top;
      const affected = affectedCardsForShift(columns, card);
      const lastBottomAfterShift = Math.max(...affected.map((affectedCard) => affectedCard.bottom + dy));
      if (lastBottomAfterShift <= safeBottom + BBOX_TOL) {
        shiftCardAndFollowing(columns, card, dy);
        continue;
      }

      residualCollisionPx = Math.max(residualCollisionPx, dy);
      collisionElementIds.add(wideText.id);
      collisionElementIds.add(cardKey(card));
    }
  }

  return { residualCollisionPx, collisionElementIds };
}

/**
 * Deduplicate shape elements with near-identical bbox. AI (and the layout-fix
 * pass) occasionally emit two shapes stacked exactly on top of each other —
 * they're invisible to the user (bottom one is occluded) but confuse card
 * building (both claim to own the same children). Keep the first, drop the
 * rest. Lines and other non-shape elements are untouched.
 */
function dedupeShapes(elements: PPTElement[]): { kept: PPTElement[]; dropped: number } {
  const DUP_TOL = 2;
  const kept: PPTElement[] = [];
  const seenShapes: PPTShapeElement[] = [];
  let dropped = 0;
  for (const el of elements) {
    if (!isShape(el)) {
      kept.push(el);
      continue;
    }
    const dup = seenShapes.find(
      (s) =>
        Math.abs(s.left - el.left) <= DUP_TOL &&
        Math.abs(s.top - el.top) <= DUP_TOL &&
        Math.abs(s.width - el.width) <= DUP_TOL &&
        Math.abs(s.height - el.height) <= DUP_TOL,
    );
    if (dup) {
      dropped += 1;
      continue;
    }
    seenShapes.push(el);
    kept.push(el);
  }
  return { kept, dropped };
}

export function fitSlideLayout(
  elements: PPTElement[],
  canvas: { width: number; height: number },
): FitResult {
  const warnings: string[] = [];
  if (!elements || elements.length === 0) {
    return { elements: elements ?? [], warnings, metrics: { ...EMPTY_METRICS } };
  }

  // Work on shallow copies — caller treats result as new state.
  let cloned: PPTElement[] = elements.map((e) => ({ ...e }));

  // Step 0: drop duplicate shapes before card building so they don't create
  // phantom containers with identical bbox.
  const deduped = dedupeShapes(cloned);
  if (deduped.dropped > 0) {
    cloned = deduped.kept;
    warnings.push(`slide-layout-fit: dropped ${deduped.dropped} duplicate shape(s)`);
  }

  // Skip line elements: they use start/end coordinates, not top/height. They
  // pass through untouched and are not laid out by this pass.
  const sized = cloned.filter(hasHeight);

  const cards = buildCards(sized);

  // Snapshot card tops BEFORE any grow/shift/squeeze. Step 6 only drops a
  // card if it was below the viewport originally AND remained below after
  // all rescue steps; otherwise a card that legitimately rode down because
  // its sibling grew would be silently destroyed.
  const originalTops = new Map<string, number>();
  for (const c of cards) {
    originalTops.set(c.bg?.id ?? c.members[0].id, c.top);
  }

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

  const safeBottom = canvas.height - SAFE_BOTTOM_MARGIN;

  // Step 4: per-column pull-up — if a column overflows, shift it up into the
  // headroom above its topmost card (capped by MIN_COLUMN_TOP).
  for (const col of columns) {
    if (col.length === 0) continue;
    const lastBottom = col[col.length - 1].bottom;
    if (lastBottom <= safeBottom) continue;
    const overflow = lastBottom - safeBottom;
    const headroom = col[0].top - MIN_COLUMN_TOP;
    const pull = Math.min(overflow, Math.max(0, headroom));
    if (pull > 0) {
      for (const c of col) shiftCard(c, -pull);
    }
  }

  // Step 5: per-column gap squeeze — if still overflowing, compress inter-card
  // gaps down to MIN_SQUEEZED_GAP, distributing the reduction proportionally.
  for (const col of columns) {
    if (col.length < 2) continue;
    const lastBottom = col[col.length - 1].bottom;
    if (lastBottom <= safeBottom) continue;
    const overflow = lastBottom - safeBottom;
    let totalReducible = 0;
    for (let i = 1; i < col.length; i++) {
      const gap = col[i].top - col[i - 1].bottom;
      totalReducible += Math.max(0, gap - MIN_SQUEEZED_GAP);
    }
    if (totalReducible <= 0) continue;
    const ratio = Math.min(1, overflow / totalReducible);
    for (let i = 1; i < col.length; i++) {
      const gap = col[i].top - col[i - 1].bottom;
      const reducible = Math.max(0, gap - MIN_SQUEEZED_GAP);
      const reduce = reducible * ratio;
      if (reduce <= 0) continue;
      for (let j = i; j < col.length; j++) shiftCard(col[j], -reduce);
    }
  }

  // Step 5b: resolve cross-column collisions where a wide singleton intro text
  // spans above lower cards. If there is no safe room to move the lower cards,
  // report residualCollisionPx so the upstream retry hook can simplify content.
  const collisionReport = resolveWideTextCollisions(cards, columns, canvas.width, safeBottom);
  if (collisionReport.residualCollisionPx > 0) {
    warnings.push(
      `slide-layout-fit: residual collision — wide text overlaps lower card(s) by ${collisionReport.residualCollisionPx.toFixed(
        1,
      )}px`,
    );
  }

  // Step 6: drop cards that start entirely below the safe viewport — they are
  // invisible by definition and only produce warnings. AI sometimes stacks an
  // extra block far below when it runs out of composition ideas.
  const dropBound = canvas.height - 20;
  const dropIds = new Set<string>();
  let droppedCount = 0;
  for (const c of cards) {
    const key = c.bg?.id ?? c.members[0].id;
    const originalTop = originalTops.get(key) ?? c.top;
    if (originalTop >= dropBound && c.top >= dropBound) {
      for (const m of c.members) dropIds.add(m.id);
      droppedCount++;
    }
  }
  let finalElements: PPTElement[] = cloned;
  if (dropIds.size > 0) {
    finalElements = cloned.filter((e) => !dropIds.has(e.id));
    warnings.push(
      `slide-layout-fit: dropped ${droppedCount} card(s)/${dropIds.size} element(s) entirely below viewport`,
    );
  }

  // Step 6b: round top/left/width/height to integers. Step 5's ratio
  // multiplication otherwise leaves fractional pixels (e.g. 200.39) that
  // accumulate into hairline misalignment between elements that should share
  // a row and surprise downstream tooling expecting integer geometry.
  for (const e of finalElements) {
    if (!hasHeight(e)) continue;
    e.top = Math.round(e.top);
    e.left = Math.round(e.left);
    e.width = Math.round(e.width);
    e.height = Math.round(e.height);
  }

  // Step 7: compute metrics + final warn. residualOverflow uses maxBottom over
  // canvas.height; residualClipped uses required-vs-height per text element;
  // overflowElementIds collects every element whose bottom still exceeds the
  // canvas (Б5 retry trigger upstream of warning).
  let maxBottom = 0;
  let residualClippedPx = 0;
  const overflowElementIds: string[] = [];
  for (const e of finalElements) {
    if (!hasHeight(e)) continue;
    const b = e.top + e.height;
    if (b > maxBottom) maxBottom = b;
    if (b > canvas.height + BBOX_TOL) overflowElementIds.push(e.id);
    if (isText(e)) {
      const required = measureTextHeight(e.content, e.width);
      const clipped = Math.max(0, required - e.height);
      if (clipped > residualClippedPx) residualClippedPx = clipped;
    }
  }
  const metrics: FitMetrics = {
    residualOverflowPx: Math.max(0, maxBottom - canvas.height),
    residualCollisionPx: collisionReport.residualCollisionPx,
    residualClippedPx,
    collisionElementIds: Array.from(collisionReport.collisionElementIds),
    droppedElementIds: Array.from(dropIds),
    overflowElementIds,
  };
  if (maxBottom > canvas.height + BBOX_TOL) {
    warnings.push(
      `slide-layout-fit: residual overflow — max element bottom ${maxBottom.toFixed(
        1,
      )}px exceeds canvas height ${canvas.height}px`,
    );
  }

  return { elements: finalElements, warnings, metrics };
}
