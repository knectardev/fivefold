import { describe, expect, it } from 'vitest';
import { makeParams, analyticalVolumes } from './params';
import { extractDissectionSolids } from './extract';
import { buildCornerCapTransfer } from './thirds';

describe('dissection CSG extract', () => {
  it('extracts core, 8 corners, 6 caps with matching volumes', () => {
    const p = makeParams(1);
    const a = analyticalVolumes(p);
    // Moderate tessellation for test speed
    const solids = extractDissectionSolids(p, 32, 16);

    expect(solids.corners).toHaveLength(8);
    expect(solids.caps).toHaveLength(6);

    // Mesh volumes approximate analytical (sphere tessellation error)
    expect(solids.core.volume).toBeGreaterThan(a.core * 0.9);
    expect(solids.core.volume).toBeLessThan(a.core * 1.05);

    expect(solids.allCorners.volume).toBeGreaterThan(a.allCorners * 0.85);
    expect(solids.allCorners.volume).toBeLessThan(a.allCorners * 1.15);

    expect(solids.allCaps.volume).toBeGreaterThan(a.allCaps * 0.85);
    expect(solids.allCaps.volume).toBeLessThan(a.allCaps * 1.15);

    // Equal mesh volumes ⇒ symmetric-difference halves match
    expect(solids.allCorners.volume).toBeCloseTo(solids.allCaps.volume, 3);

    const sumCorners = solids.corners.reduce((s, c) => s + c.volume, 0);
    const sumCaps = solids.caps.reduce((s, c) => s + c.volume, 0);
    expect(sumCorners).toBeCloseTo(solids.allCorners.volume, 2);
    expect(sumCaps).toBeCloseTo(solids.allCaps.volume, 2);
  }, 60_000);

  it('builds 24 thirds volume-paired to 24 cap sectors', () => {
    const p = makeParams(1);
    const solids = extractDissectionSolids(p, 32, 16);
    const transfer = buildCornerCapTransfer(p, solids.corners, solids.caps);

    expect(transfer.thirds).toHaveLength(24);
    expect(transfer.sectors).toHaveLength(24);
    expect(transfer.pairs).toHaveLength(24);
    expect(transfer.movablePieceCount).toBe(24);
    expect(transfer.notes.length).toBeGreaterThan(0);

    const thirdSum = transfer.thirds.reduce((s, t) => s + t.volume, 0);
    expect(thirdSum).toBeGreaterThan(solids.allCorners.volume * 0.75);
  }, 60_000);
});
