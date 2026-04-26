import { describe, expect, test } from 'vitest';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import sharp from 'sharp';
import {
  correctGeneratedImageAspectRatios,
  removeSpeechVisualReferencesForRemovedMedia,
  removeUnresolvedMediaPlaceholders,
} from '../classroom-media-generation';
import type { Scene } from '@/lib/types/stage';

function makeSlideScene(): Scene {
  return {
    id: 'scene_1',
    stageId: 'stage_1',
    title: 'Media cleanup',
    order: 1,
    type: 'slide',
    content: {
      type: 'slide',
      canvas: {
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [
          {
            id: 'image_failed',
            type: 'image',
            left: 100,
            top: 100,
            width: 320,
            height: 180,
            rotate: 0,
            src: 'gen_img_failed',
          },
          {
            id: 'image_ok',
            type: 'image',
            left: 500,
            top: 100,
            width: 320,
            height: 180,
            rotate: 0,
            src: '/api/classroom-media/stage_1/media/image_ok.png',
          },
          {
            id: 'text_1',
            type: 'text',
            left: 100,
            top: 320,
            width: 500,
            height: 50,
            rotate: 0,
            content: '<p>Text</p>',
          },
        ],
      },
    },
    actions: [
      { id: 'speech_1', type: 'speech', text: 'Посмотрите на схему.' },
      { id: 'spotlight_1', type: 'spotlight', elementId: 'image_failed' },
      { id: 'laser_1', type: 'laser', elementId: 'image_failed' },
      { id: 'spotlight_2', type: 'spotlight', elementId: 'text_1' },
    ],
  } as unknown as Scene;
}

describe('removeUnresolvedMediaPlaceholders', () => {
  test('removes unresolved media elements and dangling non-speech actions', () => {
    const scene = makeSlideScene();
    const removed = removeUnresolvedMediaPlaceholders([scene]);
    const elements = scene.content.type === 'slide' ? scene.content.canvas.elements : [];

    expect(removed).toEqual([
      {
        sceneId: 'scene_1',
        elementId: 'image_failed',
        type: 'image',
        src: 'gen_img_failed',
      },
    ]);
    expect(elements.find((el) => el.id === 'image_failed')).toBeUndefined();
    expect(elements.find((el) => el.id === 'image_ok')).toBeDefined();
    expect(scene.actions?.map((action) => action.id)).toEqual(['speech_1', 'spotlight_2']);
  });
});

describe('correctGeneratedImageAspectRatios', () => {
  test('contains a generated image within available bottom space without stretching', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openmaic-media-test-'));
    const classroomId = 'c_test';
    const mediaDir = path.join(root, classroomId, 'media');
    await fs.mkdir(mediaDir, { recursive: true });
    await sharp({
      create: {
        width: 1408,
        height: 768,
        channels: 4,
        background: '#ffffff',
      },
    }).png().toFile(path.join(mediaDir, 'gen_img_test.png'));

    const scene = {
      ...makeSlideScene(),
      content: {
        type: 'slide',
        canvas: {
          viewportSize: 1000,
          viewportRatio: 0.5625,
          elements: [
            {
              id: 'image_generated',
              type: 'image',
              left: 100,
              top: 460,
              width: 360,
              height: 82,
              rotate: 0,
              src: `/api/classroom-media/${classroomId}/media/gen_img_test.png`,
            },
          ],
        },
      },
    } as unknown as Scene;

    const corrected = await correctGeneratedImageAspectRatios([scene], classroomId, root);
    const image =
      scene.content.type === 'slide' ? scene.content.canvas.elements[0] as { left: number; width: number; height: number; top: number } : null;
    const ratio = image!.width / image!.height;

    expect(corrected).toBe(1);
    expect(image!.top + image!.height).toBeLessThanOrEqual(562.5);
    expect(Math.abs(ratio - 1408 / 768)).toBeLessThan(0.01);
    expect(image!.width).toBeLessThan(360);
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe('removeSpeechVisualReferencesForRemovedMedia', () => {
  test('removes only visual-reference speech in scenes with removed media', () => {
    const scene = makeSlideScene();
    const changed = removeSpeechVisualReferencesForRemovedMedia(scene ? [scene] : [], [
      { sceneId: 'scene_1', elementId: 'image_failed', type: 'image', src: 'gen_img_failed' },
    ]);

    expect(changed).toBe(1);
    expect(scene.actions?.find((action) => action.id === 'speech_1')).toBeUndefined();
    expect(scene.actions?.find((action) => action.id === 'spotlight_2')).toBeDefined();
  });

  test('does not touch visual words in unaffected scenes', () => {
    const scene = makeSlideScene();
    const changed = removeSpeechVisualReferencesForRemovedMedia([scene], [
      { sceneId: 'other_scene', elementId: 'image_failed', type: 'image', src: 'gen_img_failed' },
    ]);

    expect(changed).toBe(0);
    expect(scene.actions?.find((action) => action.id === 'speech_1')).toBeDefined();
  });

  test('keeps conceptual visual nouns without a look-at cue', () => {
    const scene = makeSlideScene();
    scene.actions = [
      { id: 'speech_concept', type: 'speech', text: 'Схема обучения помогает понять градиентный спуск.' },
    ];
    const changed = removeSpeechVisualReferencesForRemovedMedia([scene], [
      { sceneId: 'scene_1', elementId: 'image_failed', type: 'image', src: 'gen_img_failed' },
    ]);

    expect(changed).toBe(0);
    expect(scene.actions).toHaveLength(1);
  });
});
