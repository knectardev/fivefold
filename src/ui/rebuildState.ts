export type RebuildPhase = 'idle' | 'pending' | 'rebuilding';

export interface RebuildState {
  phase: RebuildPhase;
  lastError: string | null;
}

type Listener = (state: RebuildState) => void;

const state: RebuildState = {
  phase: 'idle',
  lastError: null,
};

const listeners = new Set<Listener>();

export function getRebuildState(): RebuildState {
  return { ...state };
}

export function setRebuildPhase(phase: RebuildPhase, error: string | null = null): void {
  state.phase = phase;
  state.lastError = error;
  for (const l of listeners) l(getRebuildState());
}

export function onRebuildState(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Debounce helper for geometry rebuilds. */
export function createDebouncedRunner(
  delayMs: number,
  run: () => void | Promise<void>,
): { schedule: () => void; cancel: () => void; flush: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;

  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const flush = () => {
    cancel();
    const gen = ++generation;
    setRebuildPhase('rebuilding');
    Promise.resolve()
      .then(() => run())
      .then(() => {
        if (gen === generation) setRebuildPhase('idle');
      })
      .catch((err: unknown) => {
        if (gen === generation) {
          if (err instanceof Error && err.message === 'superseded') {
            setRebuildPhase('idle');
            return;
          }
          setRebuildPhase('idle', err instanceof Error ? err.message : String(err));
        }
      });
  };

  const schedule = () => {
    setRebuildPhase('pending');
    cancel();
    timer = setTimeout(flush, delayMs);
  };

  return { schedule, cancel, flush };
}
