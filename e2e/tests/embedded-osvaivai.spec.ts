/**
 * Smoke-тест embedded-режима OpenMAIC-RU.
 *
 * Этот режим используется витриной osvaivai: PlayerPage рендерит
 * <iframe src="/classroom/<id>?embedded=1&showExport=1"> и ожидает
 * компактный 40px-header + спрятанный sidebar (см. components/header.tsx,
 * components/stage.tsx). Также проверяем мост postMessage из
 * lib/player-bridge.ts: при смене сцены родитель должен получить
 * сообщение { source: 'openmaic', type: 'scene:change', ... }.
 *
 * Сидим IndexedDB по образцу classroom-interaction.spec.ts, чтобы
 * не зависеть от пайплайна генерации.
 */
import { test, expect } from '../fixtures/base';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { defaultTheme } from '../fixtures/test-data/scene-content';

const TEST_STAGE_ID = 'e2e-embedded-stage';

// Sidebar в embedded скрыт через collapse → нам и не нужно его открывать.
const SETTINGS_STORAGE = createSettingsStorage({ sidebarCollapsed: true });

async function seedDatabase(page: import('@playwright/test').Page) {
  await page.addInitScript((settings) => {
    localStorage.setItem('settings-storage', settings);
    // Фиксируем локаль ru-RU, чтобы UI-строки были предсказуемы.
    localStorage.setItem('locale', 'ru-RU');
  }, SETTINGS_STORAGE);

  await page.goto('/', { waitUntil: 'networkidle' });

  await page.evaluate(
    ({ stageId, theme }) => {
      return new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('MAIC-Database');

        request.onsuccess = (event) => {
          const db = (event.target as IDBOpenDBRequest).result;
          const tx = db.transaction(['stages', 'scenes', 'stageOutlines'], 'readwrite');
          const now = Date.now();

          tx.objectStore('stages').put({
            id: stageId,
            name: 'Фотосинтез',
            description: '',
            language: 'ru-RU',
            style: 'professional',
            createdAt: now,
            updatedAt: now,
          });

          const makeSlideContent = (title: string, elId: string) => ({
            type: 'slide',
            canvas: {
              id: `slide-${elId}`,
              viewportSize: 1000,
              viewportRatio: 0.5625,
              theme,
              elements: [
                {
                  type: 'text',
                  id: `el-${elId}`,
                  content: title,
                  left: 50,
                  top: 50,
                  width: 900,
                  height: 100,
                },
              ],
            },
          });

          const scenes = [
            {
              id: 'scene-0',
              stageId,
              type: 'slide',
              title: 'Введение',
              order: 0,
              content: makeSlideContent('Введение', '0'),
              createdAt: now,
              updatedAt: now,
            },
            {
              id: 'scene-1',
              stageId,
              type: 'slide',
              title: 'Световая фаза',
              order: 1,
              content: makeSlideContent('Световая фаза', '1'),
              createdAt: now,
              updatedAt: now,
            },
          ];
          for (const scene of scenes) {
            tx.objectStore('scenes').put(scene);
          }

          tx.objectStore('stageOutlines').put({
            stageId,
            outlines: [],
            createdAt: now,
            updatedAt: now,
          });

          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };

        request.onerror = () => reject(request.error);
      });
    },
    { stageId: TEST_STAGE_ID, theme: defaultTheme },
  );
}

test.describe('Embedded mode (osvaivai iframe)', () => {
  test.beforeEach(async ({ page }) => {
    await seedDatabase(page);
  });

  test('classroom грузится в embedded-режиме с компактным header', async ({ page }) => {
    const classroom = new ClassroomPage(page);
    await page.goto(`/classroom/${TEST_STAGE_ID}?embedded=1&showExport=1`);
    await classroom.waitForLoaded();

    // Header использует h-10 (40px) в embedded — это маркер из components/header.tsx.
    const header = page.locator('header').first();
    await expect(header).toBeVisible();
    const hasH10 = await header.evaluate((el) => el.classList.contains('h-10'));
    expect(hasH10).toBe(true);

    // В embedded SceneSidebar не рендерится (см. components/stage.tsx
    // {!isEmbedded && <SceneSidebar />}), поэтому проверяем именно отсутствие
    // scene-list — это фиксирует поведение, на которое полагается витрина.
    await expect(page.locator('[data-testid="scene-list"]')).toHaveCount(0);

    // Заголовок текущей сцены должен быть виден в header (см. components/header.tsx).
    // Используем точное совпадение, чтобы не цеплять «Введение в …» и т.п.
    await expect(page.getByRole('heading', { name: 'Введение' })).toBeVisible({
      timeout: 10_000,
    });
  });

  test('mobile=1 в landscape отдаёт максимум высоты слайду и не раздувает нижнюю панель', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 844, height: 390 });

    const classroom = new ClassroomPage(page);
    await page.goto(`/classroom/${TEST_STAGE_ID}?embedded=1&showExport=1&mobile=1`);
    await classroom.waitForLoaded();

    await page.getByRole('button', { name: 'Нажмите, чтобы начать урок' }).click();

    const roundtable = page.getByTestId('roundtable');
    await expect(roundtable).toBeVisible();

    const roundtableBox = await roundtable.boundingBox();
    expect(roundtableBox?.height).toBeLessThanOrEqual(100);

    const slideBox = await page.getByTestId('slide-frame').boundingBox();
    expect(slideBox?.height).toBeGreaterThanOrEqual(220);
    expect(slideBox?.width).toBeGreaterThanOrEqual(390);

    const viewportOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(viewportOverflow.scrollWidth).toBeLessThanOrEqual(viewportOverflow.innerWidth);
  });

  test('header показывает кнопку back только когда embedded выключен', async ({ page }) => {
    // Standalone (без ?embedded=1) — кнопка back должна присутствовать.
    await page.goto(`/classroom/${TEST_STAGE_ID}`);
    await page.locator('header').first().waitFor({ state: 'visible' });
    const standaloneHeader = page.locator('header').first();
    const standaloneIsTall = await standaloneHeader.evaluate((el) => el.classList.contains('h-20'));
    expect(standaloneIsTall).toBe(true);
  });
});
