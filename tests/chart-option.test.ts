import { describe, expect, test } from 'vitest';
import type { ChartData } from '@/lib/types/slides';
import { getChartOption } from '@/components/slide-renderer/components/element/ChartElement/chartOption';

const themeColors = ['#2563eb', '#dc2626'];

function data(labels: string[], series: number[][]): ChartData {
  return {
    labels,
    legends: series.map((_, index) => `Series ${index + 1}`),
    series,
  };
}

function labelVisibility(option: unknown): boolean[] {
  return ((option as { series: Array<{ label?: { show?: boolean } }> }).series ?? []).map(
    (series) => series.label?.show ?? false,
  );
}

describe('getChartOption', () => {
  test('line chart hides point labels for dense category data', () => {
    const option = getChartOption({
      type: 'line',
      data: data(['2019', '2020', '2021', '2022', '2023', '2024'], [[1, 2, 3, 4, 5, 6]]),
      themeColors,
    });

    expect(labelVisibility(option)).toEqual([false]);
  });

  test('line chart keeps point labels for sparse single-series data', () => {
    const option = getChartOption({
      type: 'line',
      data: data(['2019', '2020', '2021', '2022'], [[1, 2, 3, 4]]),
      themeColors,
    });

    expect(labelVisibility(option)).toEqual([true]);
  });

  test('area chart hides point labels for multiple series', () => {
    const option = getChartOption({
      type: 'area',
      data: data(
        ['2019', '2020', '2021'],
        [
          [1, 2, 3],
          [3, 2, 1],
        ],
      ),
      themeColors,
    });

    expect(labelVisibility(option)).toEqual([false, false]);
  });
});
