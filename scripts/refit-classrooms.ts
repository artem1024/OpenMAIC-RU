/**
 * One-off retrofit script — applies fitSlideLayout to every slide scene of
 * the supplied classroom JSON files and writes them back.
 *
 * Use case: existing classrooms generated before the layout-fit pass landed.
 *
 * Usage:
 *   pnpm dlx tsx scripts/refit-classrooms.ts <path1.json> [<path2.json> ...]
 *
 * Each file is backed up to <path>.bak before being rewritten.
 */
import { readFileSync, writeFileSync } from 'fs';
import { fitSlideLayout } from '../lib/generation/slide-layout-fit';

interface SceneCanvas {
  viewportSize?: number;
  viewportRatio?: number;
  elements: unknown[];
}
interface Scene {
  id: string;
  type: string;
  title?: string;
  content?: { type?: string; canvas?: SceneCanvas };
}
interface Classroom {
  scenes: Scene[];
  [k: string]: unknown;
}

function refitFile(path: string): { changed: boolean; warnings: string[] } {
  const raw = readFileSync(path, 'utf8');
  const cls: Classroom = JSON.parse(raw);
  const warnings: string[] = [];
  let mutated = false;

  for (const scene of cls.scenes ?? []) {
    if (scene.type !== 'slide') continue;
    const canvas = scene.content?.canvas;
    if (!canvas || !Array.isArray(canvas.elements) || canvas.elements.length === 0) continue;

    const viewportSize = canvas.viewportSize ?? 1000;
    const viewportRatio = canvas.viewportRatio ?? 0.5625;
    const canvasDims = {
      width: viewportSize,
      height: viewportSize * viewportRatio,
    };

    // The PPTElement type uses required fields; trust the shape from disk.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const before = JSON.stringify(canvas.elements);
    const fit = fitSlideLayout(canvas.elements as never[], canvasDims);
    canvas.elements = fit.elements;
    const after = JSON.stringify(canvas.elements);

    if (before !== after) mutated = true;
    for (const w of fit.warnings) {
      warnings.push(`scene "${scene.title ?? scene.id}": ${w}`);
    }
  }

  if (mutated) {
    writeFileSync(path + '.bak', raw, 'utf8');
    writeFileSync(path, JSON.stringify(cls, null, 2) + '\n', 'utf8');
  }
  return { changed: mutated, warnings };
}

function main() {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error('usage: refit-classrooms.ts <path.json> [<path2.json> ...]');
    process.exit(1);
  }
  for (const p of paths) {
    try {
      const { changed, warnings } = refitFile(p);
      console.log(`[${changed ? 'fixed' : 'no-op'}] ${p}`);
      for (const w of warnings) console.log(`  warn: ${w}`);
    } catch (err) {
      console.error(`[error] ${p}: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
    }
  }
}

main();
