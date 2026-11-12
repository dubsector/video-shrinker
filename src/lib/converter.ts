import type { ConversionPhase, ConvertResult } from './convert';
import type { ConvertRequest, ConvertResponse } from './convert.worker';
import { loadEncoderBias, rememberEncoderObservation } from './encoderBias';
import { whenPageVisible } from './pageVisibility';
import { PauseGate } from './pauseGate';

export type ConversionRequest = {
  file: File;
  targetSizeBytes: number;
  preferHevc: boolean;
  stripMetadata: boolean;
  /** `attempt` counts the encodes of this conversion from 1. */
  onProgress: (progress: number, phase: ConversionPhase, pausable: boolean, attempt: number) => void;
};

export type ConversionHandle = {
  /** Rejects with ConversionCancelledError after cancel(). */
  result: Promise<ConvertResult>;
  pause: () => void;
  resume: () => void;
  /** Stops the conversion for good and deletes whatever it had written. */
  cancel: () => void;
};

/** What `result` rejects with after cancel(), so it isn't shown as a failure. */
export class ConversionCancelledError extends Error {
  constructor() {
    super('The conversion was cancelled.');
    this.name = 'ConversionCancelledError';
  }
}

// One worker, created ahead of the first conversion and kept for the next.
// Null once it has failed to start, after which everything runs in the page.
let worker: Worker | null = null;
let workerBroken = false;
let workerSuitable: Promise<boolean> | null = null;

/**
 * Whether conversions should run in a worker. The worker path needs WebCodecs
 * encode there and, for its per-file ffmpeg fallback, nested workers. Any
 * browser that encodes video through WebCodecs has both. Browsers that can't
 * run every conversion on ffmpeg.wasm anyway, which brings its own worker, so
 * those keep the page path that has always worked for them.
 */
function isWorkerSuitable(): Promise<boolean> {
  workerSuitable ??=
    typeof Worker === 'undefined'
      ? Promise.resolve(false)
      : import('./capabilities').then(({ canEncodeAvc }) => canEncodeAvc()).catch(() => false);
  return workerSuitable;
}

function getWorker(): Worker {
  worker ??= new Worker(new URL('./convert.worker.ts', import.meta.url), { type: 'module' });
  return worker;
}

/**
 * Starts loading the conversion engine so pressing Convert has nothing left
 * to wait for. Nothing waits on this.
 */
export function prepareConverter(): void {
  void isWorkerSuitable().then((suitable) => {
    if (suitable && !workerBroken) getWorker();
    else void import('./convert');
  });
}

function runInPage(request: ConversionRequest): ConversionHandle {
  const gate = new PauseGate();
  const canceller = new AbortController();
  const result = import('./convert')
    .then(({ convertVideo }) =>
      convertVideo(request.file, request.targetSizeBytes, {
        preferHevc: request.preferHevc,
        stripMetadata: request.stripMetadata,
        encoderBias: loadEncoderBias(),
        pauseGate: gate,
        whenVisible: whenPageVisible,
        cancelSignal: canceller.signal,
        onProgress: (progress, phase, pausable, attempt) => {
          if (!canceller.signal.aborted) request.onProgress(progress, phase, pausable, attempt);
        },
      }),
    )
    .then(
      (converted) => {
        if (!canceller.signal.aborted) return converted;
        // Finished in the moment it was being cancelled; nobody wants it now.
        releaseOutputs();
        throw new ConversionCancelledError();
      },
      (err: unknown) => {
        if (!canceller.signal.aborted) throw err;
        releaseOutputs();
        throw new ConversionCancelledError();
      },
    );
  return {
    result,
    pause: () => gate.pause(),
    resume: () => gate.resume(),
    cancel: () => {
      canceller.abort();
      // A paused conversion is waiting on the gate and would never notice.
      gate.resume();
    },
  };
}

function runInWorker(request: ConversionRequest): ConversionHandle {
  const target = getWorker();
  const post = (message: ConvertRequest) => target.postMessage(message);
  // Swapped out if the conversion falls back to the page, so pause and
  // resume keep reaching whatever is actually running.
  let controls = {
    pause: () => post({ type: 'pause' }),
    resume: () => post({ type: 'resume' }),
    // Replaced below once the promise's own reject is in reach.
    cancel: () => {},
  };

  const reportVisibility = () => post({ type: 'visibility', visible: document.visibilityState === 'visible' });

  const result = new Promise<ConvertResult>((resolve, reject) => {
    let started = false;
    const cleanup = () => {
      target.removeEventListener('message', onMessage);
      target.removeEventListener('error', onError);
      document.removeEventListener('visibilitychange', reportVisibility);
    };
    const onMessage = (event: MessageEvent<ConvertResponse>) => {
      started = true;
      const message = event.data;
      if (message.type === 'progress') {
        request.onProgress(message.progress, message.phase, message.pausable, message.attempt);
      } else if (message.type === 'done') {
        cleanup();
        resolve(message.result);
      } else {
        cleanup();
        reject(new Error(message.message));
      }
    };
    // A worker that never got going (a script that wouldn't load, say) is
    // retired, and this conversion reruns in the page instead of failing.
    const onError = (event: Event) => {
      cleanup();
      event.preventDefault();
      target.terminate();
      worker = null;
      if (!started) {
        workerBroken = true;
        const fallback = runInPage(request);
        controls = fallback;
        fallback.result.then(resolve, reject);
      } else {
        reject(new Error((event as ErrorEvent).message || 'The conversion stopped unexpectedly.'));
      }
    };
    target.addEventListener('message', onMessage);
    target.addEventListener('error', onError);
    document.addEventListener('visibilitychange', reportVisibility);
    // Stopping the worker is the one cancel that works whatever it is doing,
    // the ffmpeg engine included, which can't be interrupted any other way.
    // The files it was writing lose their locks with it, so the sweep in
    // releaseOutputs() deletes them. The next conversion starts a new worker.
    controls.cancel = () => {
      cleanup();
      target.terminate();
      if (worker === target) worker = null;
      releaseOutputs();
      reject(new ConversionCancelledError());
    };
  });

  reportVisibility();
  post({
    type: 'convert',
    file: request.file,
    targetSizeBytes: request.targetSizeBytes,
    preferHevc: request.preferHevc,
    stripMetadata: request.stripMetadata,
    // Read here: a worker has no localStorage of its own.
    encoderBias: loadEncoderBias(),
  });
  return { result, pause: () => controls.pause(), resume: () => controls.resume(), cancel: () => controls.cancel() };
}

/**
 * Deletes finished results kept on disk: the worker's, the page's, and any
 * left behind by an earlier visit. Call once the result on screen is gone.
 */
export function releaseOutputs(): void {
  worker?.postMessage({ type: 'release' } satisfies ConvertRequest);
  void import('./outputFiles').then(({ releaseAllOutputs }) => releaseAllOutputs());
}

export async function startConversion(request: ConversionRequest): Promise<ConversionHandle> {
  const handle = !workerBroken && (await isWorkerSuitable()) ? runInWorker(request) : runInPage(request);
  // Learn from how this one landed, for the next conversion on this device.
  handle.result.then(
    (converted) => {
      if (converted.encoderObservation) rememberEncoderObservation(converted.encoderObservation);
    },
    () => {},
  );
  return handle;
}
