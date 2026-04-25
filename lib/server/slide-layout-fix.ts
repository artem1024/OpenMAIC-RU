/**
 * Post-generation slide layout validator.
 *
 * Gemini (and other content-generation LLMs) occasionally violate canvas-layout
 * invariants — placing section titles at the bottom of their container, writing
 * cards that extend below the viewport, or undersizing text boxes so content
 * overflows visually. This pass detects and auto-corrects the common failures.
 *
 * Applied in order per scene:
 *   1. title-at-bottom swap  — move a bold/colon title to the top of its card
 *                              and shift siblings down so they clear the title.
 *   2. grow text height      — expand text boxes whose content clearly needs
 *                              more visual height, capped to their container.
 *   3. clamp offscreen       — container-aware: if a card extends below the
 *                              viewport, shift the card plus all children up
 *                              together so relative positions are preserved.
 */

import type { Scene } from '@/lib/types/stage';

type AnyElement = Record<string, unknown> & {
  id: string;
  type: string;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  content?: string;
  path?: string;
};

const MARGIN = 2;
const TITLE_HEIGHT = 32;
const TITLE_PAD = 8;
const TITLE_PAT = /<strong>[^<]{2,60}:<\/strong>/i;
const STRIP_TAGS = /<[^>]+>/g;
// Block-level tags that introduce a visual line break when rendered.
// Inline tags (<strong>, <em>, <span>, ...) must NOT translate to a newline:
// "<p>• <strong>Цель:</strong> текст</p>" is one line, not three.
const BLOCK_TAG_RE = /<br\s*\/?>|<\/?(p|div|li|ul|ol|h[1-6]|blockquote)(\s[^>]*)?>/gi;
const INLINE_TAG_RE = /<[^>]+>/g;

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function h(e: AnyElement): number {
  return num(e.height);
}
function w(e: AnyElement): number {
  return num(e.width);
}
function top(e: AnyElement): number {
  return num(e.top);
}
function left(e: AnyElement): number {
  return num(e.left);
}
function bottom(e: AnyElement): number {
  return top(e) + h(e);
}
function right(e: AnyElement): number {
  return left(e) + w(e);
}

function isInside(child: AnyElement, parent: AnyElement, slack = 4): boolean {
  if (child.top === undefined || child.left === undefined) return false;
  return (
    left(child) >= left(parent) - slack &&
    top(child) >= top(parent) - slack &&
    right(child) <= right(parent) + slack &&
    bottom(child) <= bottom(parent) + slack
  );
}

function findContainers(elements: AnyElement[]): AnyElement[] {
  return elements.filter((e) => {
    if (e.type !== 'shape') return false;
    if (w(e) < 120 || h(e) < 80) return false;
    const path = typeof e.path === 'string' ? e.path : '';
    return path.includes('M 0 0');
  });
}

function isTitleText(e: AnyElement): boolean {
  if (e.type !== 'text') return false;
  const content = typeof e.content === 'string' ? e.content : '';
  if (!TITLE_PAT.test(content)) return false;
  const plain = content.replace(STRIP_TAGS, '').trim();
  return plain.length <= 80 && plain.endsWith(':');
}

function titleAtBottomSwap(
  elements: AnyElement[],
  report: string[],
): number {
  const containers = findContainers(elements);
  let changed = 0;
  for (const cont of containers) {
    const children = elements.filter(
      (e) => e !== cont && isInside(e, cont),
    );
    if (children.length < 2) continue;
    const title = children.find(isTitleText);
    if (!title) continue;
    const midY = top(cont) + h(cont) / 2;
    if (top(title) < midY) continue; // Already in top half.

    const newTitleTop = top(cont) + TITLE_PAD;
    const oldTitleTop = top(title);
    const shiftZoneBottom = newTitleTop + TITLE_HEIGHT + TITLE_PAD;
    const contBottom = top(cont) + h(cont);
    const siblings = children.filter((c) => c !== title);

    title.top = newTitleTop;
    title.height = Math.min(h(title), TITLE_HEIGHT + 12);

    const shifts: string[] = [];
    for (const s of siblings) {
      if (top(s) >= shiftZoneBottom) continue;
      const needed = shiftZoneBottom - top(s);
      const maxAllowed = Math.max(0, contBottom - h(s) - top(s) - MARGIN);
      const applied = Math.min(needed, maxAllowed);
      if (applied > 0) {
        s.top = top(s) + applied;
        shifts.push(`${s.id}+${applied}`);
      }
      if (top(s) < shiftZoneBottom && s.type === 'text') {
        const overlap = shiftZoneBottom - top(s);
        const newH = Math.max(20, h(s) - overlap);
        s.height = newH;
        s.top = shiftZoneBottom;
        shifts.push(`${s.id}↓h=${newH}`);
      }
    }
    report.push(
      `title-swap ${cont.id}: ${title.id} top ${oldTitleTop}→${newTitleTop}${
        shifts.length ? ` [${shifts.join(', ')}]` : ''
      }`,
    );
    changed += 1;
  }
  return changed;
}

export function estimateTextHeight(contentHtml: string, widthPx: number): number {
  const plain = (contentHtml || '')
    .replace(BLOCK_TAG_RE, '\n')
    .replace(INLINE_TAG_RE, '')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
  if (!plain) return 0;
  const sizes = Array.from(contentHtml.matchAll(/font-size:\s*(\d+)px/g)).map(
    (m) => parseInt(m[1], 10),
  );
  const avgSize = sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : 16;
  const lineH = avgSize * 1.45;
  const charsPerLine = Math.max(8, Math.floor(widthPx / (avgSize * 0.55)));
  let lines = 0;
  for (const para of plain.split('\n\n')) {
    if (!para) continue;
    for (const line of para.split('\n')) {
      if (!line) {
        lines += 1;
        continue;
      }
      lines += Math.max(1, Math.ceil(line.length / charsPerLine));
    }
    lines += 0.4;
  }
  return Math.floor(lines * lineH) + 8;
}

function growTextHeight(
  elements: AnyElement[],
  vpH: number,
  report: string[],
): number {
  const containers = findContainers(elements);
  let changed = 0;
  for (const e of elements) {
    if (e.type !== 'text') continue;
    const est = estimateTextHeight((e.content as string) || '', w(e) || 240);
    if (est <= h(e) + 2) continue;
    let parent: AnyElement | null = null;
    for (const c of containers) {
      if (c === e || !isInside(e, c)) continue;
      if (parent === null || h(c) * w(c) < h(parent) * w(parent)) {
        parent = c;
      }
    }
    const maxBot = parent ? top(parent) + h(parent) - MARGIN : vpH - MARGIN;
    const newH = Math.min(est, maxBot - top(e));
    if (newH > h(e) + 2) {
      report.push(`grow-text ${e.id}: h ${h(e)}→${newH} (est ${est})`);
      e.height = newH;
      changed += 1;
    }
  }
  return changed;
}

const SATELLITE_GAP = 20;
const DECOR_HEIGHT = 12;

/**
 * Find "satellite" decorations that visually belong to `cont` but don't fall
 * geometrically inside it: thin shape lines (h <= DECOR_HEIGHT) just above or
 * just below the container, horizontally overlapping with it, not already
 * claimed by any container.
 *
 * Without this, a clamp-up shift moves the container but strands the decorative
 * underline where it was — producing the "blue strike-through through text"
 * artifact observed on lesson 5 scene 18.
 */
function findSatellites(
  cont: AnyElement,
  elements: AnyElement[],
  claimed: Set<AnyElement>,
): AnyElement[] {
  const sats: AnyElement[] = [];
  for (const e of elements) {
    if (e === cont) continue;
    if (claimed.has(e)) continue;
    if (e.type !== 'shape') continue;
    if (h(e) > DECOR_HEIGHT) continue;
    const hOverlap = left(e) < right(cont) && left(cont) < right(e);
    if (!hOverlap) continue;
    const aboveGap = top(cont) - bottom(e);
    const belowGap = top(e) - bottom(cont);
    if ((aboveGap >= -1 && aboveGap <= SATELLITE_GAP) ||
        (belowGap >= -1 && belowGap <= SATELLITE_GAP)) {
      sats.push(e);
    }
  }
  return sats;
}

function clampOffscreen(
  elements: AnyElement[],
  vpH: number,
  report: string[],
): number {
  let changed = 0;
  const containers = findContainers(elements);
  const childrenOf = new Map<string, AnyElement[]>();
  for (const c of containers) childrenOf.set(c.id, []);
  const claimed = new Set<AnyElement>();
  for (const e of elements) {
    if (containers.includes(e)) continue;
    let best: AnyElement | null = null;
    for (const c of containers) {
      if (c === e || !isInside(e, c)) continue;
      if (best === null || h(c) * w(c) < h(best) * w(best)) best = c;
    }
    if (best) {
      childrenOf.get(best.id)!.push(e);
      claimed.add(e);
    }
  }

  const moved = new Set<AnyElement>();

  // Phase 1: container-unit clamp (including satellite decorations).
  for (const cont of containers) {
    const overflow = bottom(cont) - vpH;
    if (overflow <= 1) continue;
    const maxUp = top(cont);
    const shift = Math.min(overflow + MARGIN, maxUp);
    if (shift <= 0) continue;
    const satellites = findSatellites(cont, elements, claimed);
    cont.top = top(cont) - shift;
    moved.add(cont);
    for (const child of childrenOf.get(cont.id)!) {
      child.top = top(child) - shift;
      moved.add(child);
    }
    for (const sat of satellites) {
      sat.top = top(sat) - shift;
      moved.add(sat);
      claimed.add(sat);
    }
    report.push(
      `clamp container ${cont.id}: shifted -${shift} (h=${h(cont)}, +${childrenOf.get(cont.id)!.length} children${
        satellites.length > 0 ? `, +${satellites.length} decoration(s)` : ''
      })`,
    );
    changed += 1 + childrenOf.get(cont.id)!.length + satellites.length;
  }

  // Phase 2: per-element clamp for anything not yet moved. Move-up is preferred,
  // but if it would stack the element on top of a neighbour that shares its
  // horizontal band, shrink the element to fit in the space below that neighbour
  // instead. Avoids the "card slid up over existing text" artefact.
  const hOverlaps = (a: AnyElement, b: AnyElement): boolean => {
    return left(a) < right(b) && left(b) < right(a);
  };

  for (const e of elements) {
    if (moved.has(e)) continue;
    if (e.height === undefined || e.top === undefined) continue;
    if (bottom(e) <= vpH + 1) continue;

    const proposedTop = Math.max(0, vpH - h(e) - MARGIN);
    let collides = false;
    for (const o of elements) {
      if (o === e) continue;
      if (o.height === undefined || o.top === undefined) continue;
      if (top(o) + h(o) <= proposedTop || top(o) >= proposedTop + h(e)) continue;
      if (hOverlaps(e, o)) {
        collides = true;
        break;
      }
    }

    if (!collides) {
      if (proposedTop !== top(e)) {
        report.push(`clamp ${e.id}: top ${top(e)}→${proposedTop} (h=${h(e)})`);
        e.top = proposedTop;
        changed += 1;
      }
      continue;
    }

    // Find lowest "floor" among elements that horizontally overlap e and
    // already fit onscreen. Place e below that floor; shrink to fit.
    let floor = 0;
    for (const o of elements) {
      if (o === e) continue;
      if (o.height === undefined || o.top === undefined) continue;
      if (!hOverlaps(e, o)) continue;
      const oBot = top(o) + h(o);
      if (oBot <= vpH - MARGIN && oBot > floor) floor = oBot;
    }
    const newTop = Math.max(0, floor + 8);
    const newH = vpH - newTop - MARGIN;
    if (newH < 30) {
      // No space to shrink — fall back to move-up and accept overlap.
      e.top = proposedTop;
      report.push(
        `clamp ${e.id}: top ${top(e)}→${proposedTop} (h=${h(e)}, forced — overlap unavoidable)`,
      );
    } else {
      report.push(
        `shrink ${e.id}: top ${top(e)}→${newTop}, h ${h(e)}→${newH} (overlap avoided)`,
      );
      e.top = newTop;
      e.height = newH;
    }
    changed += 1;
  }
  return changed;
}

export interface LayoutFixReport {
  sceneIndex: number;
  sceneTitle: string;
  messages: string[];
  changes: number;
}

export function fixSlideLayouts(scenes: Scene[]): LayoutFixReport[] {
  const reports: LayoutFixReport[] = [];
  scenes.forEach((scene, idx) => {
    const content = scene.content as { type?: string; canvas?: unknown };
    if (content?.type !== 'slide') return;
    const canvas = content.canvas as
      | {
          viewportSize?: number;
          viewportRatio?: number;
          elements?: AnyElement[];
        }
      | undefined;
    if (!canvas || !Array.isArray(canvas.elements) || canvas.elements.length === 0) return;
    const vpW = num(canvas.viewportSize, 1000);
    const vpH = Math.round(vpW * num(canvas.viewportRatio, 0.5625));
    const messages: string[] = [];
    let changes = 0;
    changes += titleAtBottomSwap(canvas.elements, messages);
    changes += growTextHeight(canvas.elements, vpH, messages);
    changes += clampOffscreen(canvas.elements, vpH, messages);
    if (changes > 0) {
      reports.push({
        sceneIndex: idx,
        sceneTitle: scene.title || '',
        messages,
        changes,
      });
    }
  });
  return reports;
}
