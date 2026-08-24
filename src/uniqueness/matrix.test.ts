import { describe, expect, it } from 'vitest';
import { GALLERY_CONFIGS } from './configs12';
import { buildCongruenceMatrix, equivalenceClasses } from './matrix';
import { UNIT_SOLID } from './unitShape';

describe('congruence matrix (gallery empirical)', () => {
  const result = buildCongruenceMatrix(GALLERY_CONFIGS, UNIT_SOLID);

  it('is square of size N', () => {
    expect(result.matrix).toHaveLength(12);
    for (const row of result.matrix) {
      expect(row).toHaveLength(12);
    }
  });

  it('has identity diagonal', () => {
    for (let i = 0; i < 12; i++) {
      expect(result.matrix[i]![i]).toBe(true);
    }
  });

  it('is symmetric', () => {
    for (let i = 0; i < 12; i++) {
      for (let j = 0; j < 12; j++) {
        expect(result.matrix[i]![j]).toBe(result.matrix[j]![i]);
      }
    }
  });

  it('reports equivalence class partition', () => {
    const classes = equivalenceClasses(result);
    expect(classes).toHaveLength(result.classCount);
    const covered = classes.flat().sort((a, b) => a - b);
    expect(covered).toEqual([...Array(12).keys()]);
    // Empirical finding — log for the uniqueness question; do not assert a count.
    // eslint-disable-next-line no-console
    console.log(
      `[gallery] ${result.classCount} distinct classes:`,
      classes.map((g) => g.map((i) => i + 1)),
    );
    expect(result.classCount).toBeGreaterThanOrEqual(1);
    expect(result.classCount).toBeLessThanOrEqual(12);
  });
});
