import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { defaultParams } from '../model/types';
import { createParamsUndoStack, restoreParamsInto } from './undoStack';

describe('params undo stack', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('restores prior state and caps at 3 steps', () => {
    const params = defaultParams();
    const undo = createParamsUndoStack(params);

    params.macroSize = 6;
    undo.note(params);
    vi.advanceTimersByTime(400);

    params.macroSize = 7;
    undo.note(params);
    vi.advanceTimersByTime(400);

    params.macroSize = 8;
    undo.note(params);
    vi.advanceTimersByTime(400);

    params.macroSize = 9;
    undo.note(params);
    vi.advanceTimersByTime(400);

    expect(undo.depth()).toBe(3);

    let snap = undo.undo();
    expect(snap?.macroSize).toBe(8);
    restoreParamsInto(params, snap!);
    expect(params.macroSize).toBe(8);

    snap = undo.undo();
    expect(snap?.macroSize).toBe(7);

    snap = undo.undo();
    expect(snap?.macroSize).toBe(6);

    expect(undo.undo()).toBeNull();
  });

  it('coalesces rapid notes into one step', () => {
    const params = defaultParams();
    const undo = createParamsUndoStack(params);

    params.macroSize = 6;
    undo.note(params);
    params.macroSize = 6.5;
    undo.note(params);
    params.macroSize = 7;
    undo.note(params);
    vi.advanceTimersByTime(400);

    expect(undo.depth()).toBe(1);
    const snap = undo.undo();
    expect(snap?.macroSize).toBe(5); // default
  });

  it('skips notes while suspended', () => {
    const params = defaultParams();
    const undo = createParamsUndoStack(params);
    params.macroSize = 9;
    undo.runSuspended(() => undo.note(params));
    expect(undo.depth()).toBe(0);
  });
});
