/**
 * Pauses a running conversion and lets it pick up where it stopped.
 *
 * Mediabunny suspends an execute() call when the signal it was handed aborts,
 * and resumes on the next execute(). An AbortSignal can only fire once, so
 * every resume swaps in a fresh one for the next pause.
 */
export class PauseGate {
  private controller = new AbortController();
  private waiters: (() => void)[] = [];
  private isPaused = false;

  get paused(): boolean {
    return this.isPaused;
  }

  /** The signal to hand to the next execute() call. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  pause(): void {
    if (this.isPaused) return;
    this.isPaused = true;
    this.controller.abort();
  }

  resume(): void {
    if (!this.isPaused) return;
    this.isPaused = false;
    this.controller = new AbortController();
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  /** Resolves straight away while running, or on the next resume() while paused. */
  whenResumed(): Promise<void> {
    if (!this.isPaused) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
