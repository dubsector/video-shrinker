import type { ConversionPhase, ConvertResult } from './convert';
import type { ConvertRequest, ConvertResponse } from './convert.worker';
import { PauseGate } from './pauseGate';

export type ConversionRequest = {
  file: File;
  targetSizeBytes: number;
  preferHevc: boolean;
  stripMetadata: boolean;
  onProgress: (progress: number, phase: ConversionPhase, pausable: boolean) => void;
};

export type ConversionHandle = {
  result: Promise<ConvertResult>;
  pause: () => void;
  resume: () => void;
};

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
  const result = import('./convert').then(({ convertVideo }) =>
    convertVideo(request.file, request.targetSizeBytes, {
      preferHevc: request.preferHevc,
      stripMetadata: request.stripMetadata,
      pauseGate: gate,
      onProgress: request.onProgress,
    }),
  );
  return { result, pause: () => gate.pause(), resume: () => gate.resume() };
}

function runInWorker(request: ConversionRequest): ConversionHandle {
  const target = getWorker();
  const post = (message: ConvertRequest) => target.postMessage(message);
  // Swapped out if the conversion falls back to the page, so pause and
  // resume keep reaching whatever is actually running.
  let controls = { pause: () => post({ type: 'pause' }), resume: () => post({ type: 'resume' }) };

  const result = new Promise<ConvertResult>((resolve, reject) => {
    let started = false;
    const cleanup = () => {
      target.removeEventListener('message', onMessage);
      target.removeEventListener('error', onError);
    };
    const onMessage = (event: MessageEvent<ConvertResponse>) => {
      started = true;
      const message = event.data;
      if (message.type === 'progress') {
        request.onProgress(message.progress, message.phase, message.pausable);
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
  });

  post({
    type: 'convert',
    file: request.file,
    targetSizeBytes: request.targetSizeBytes,
    preferHevc: request.preferHevc,
    stripMetadata: request.stripMetadata,
  });
  return { result, pause: () => controls.pause(), resume: () => controls.resume() };
}

export async function startConversion(request: ConversionRequest): Promise<ConversionHandle> {
  return !workerBroken && (await isWorkerSuitable()) ? runInWorker(request) : runInPage(request);
}
