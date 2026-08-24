import type { DesignParams } from '../model/types';

const MAX_STEPS = 3;
const COALESCE_MS = 400;

function cloneParams(params: DesignParams): DesignParams {
  return structuredClone(params);
}

/** Copy snapshot fields into the live params object (keeps lil-gui bindings). */
export function restoreParamsInto(
  target: DesignParams,
  source: DesignParams,
): void {
  const snap = cloneParams(source);
  const { parts, ...rest } = snap;
  Object.assign(target, rest);
  target.parts = parts;
}

/**
 * Linear undo stack (max 3). No redo / branching.
 * Call `note` after the live params object has already been mutated.
 * Rapid notes within COALESCE_MS collapse into one undo step.
 */
export function createParamsUndoStack(initial: DesignParams) {
  const stack: DesignParams[] = [];
  let baseline = cloneParams(initial);
  let coalescing = false;
  let coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  let suspended = false;

  function clearCoalesce(): void {
    if (coalesceTimer != null) {
      clearTimeout(coalesceTimer);
      coalesceTimer = null;
    }
    coalescing = false;
  }

  return {
    note(current: DesignParams): void {
      if (suspended) return;
      if (!coalescing) {
        stack.push(baseline);
        if (stack.length > MAX_STEPS) stack.shift();
        coalescing = true;
      }
      if (coalesceTimer != null) clearTimeout(coalesceTimer);
      coalesceTimer = setTimeout(() => {
        baseline = cloneParams(current);
        coalescing = false;
        coalesceTimer = null;
      }, COALESCE_MS);
    },

    undo(): DesignParams | null {
      if (!stack.length) return null;
      clearCoalesce();
      const snap = stack.pop()!;
      baseline = cloneParams(snap);
      return snap;
    },

    /** Skip recording while restoring an undo snapshot. */
    runSuspended<T>(fn: () => T): T {
      suspended = true;
      try {
        return fn();
      } finally {
        suspended = false;
      }
    },

    depth(): number {
      return stack.length;
    },
  };
}
