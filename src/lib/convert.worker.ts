// Runs convertVideo() off the main thread. Demuxing, muxing and shuttling
// frames between decoder and encoder all happen in JavaScript, and on a phone
// that is enough to make the page stutter while it works. Here none of it
// competes with the UI.
import { type ConversionPhase, convertVideo, type ConvertResult } from './convert';
import { PauseGate } from './pauseGate';

export type ConvertRequest =
  | { type: 'convert'; file: File; targetSizeBytes: number; preferHevc: boolean; stripMetadata: boolean }
  | { type: 'pause' }
  | { type: 'resume' }
  // A worker can't see the page, so the page reports when it is shown or hidden.
  | { type: 'visibility'; visible: boolean };

export type ConvertResponse =
  | { type: 'progress'; progress: number; phase: ConversionPhase; pausable: boolean }
  | { type: 'done'; result: ConvertResult }
  | { type: 'error'; message: string };

let gate: PauseGate | null = null;
let pageVisible = true;
const visibleWaiters: (() => void)[] = [];

function whenVisible(): Promise<void> {
  if (pageVisible) return Promise.resolve();
  return new Promise((resolve) => visibleWaiters.push(resolve));
}

function send(message: ConvertResponse): void {
  self.postMessage(message);
}

self.addEventListener('message', (event: MessageEvent<ConvertRequest>) => {
  const request = event.data;
  if (request.type === 'pause') {
    gate?.pause();
    return;
  }
  if (request.type === 'resume') {
    gate?.resume();
    return;
  }
  if (request.type === 'visibility') {
    pageVisible = request.visible;
    if (pageVisible) {
      for (const wake of visibleWaiters.splice(0)) wake();
    }
    return;
  }

  const ownGate = new PauseGate();
  gate = ownGate;
  convertVideo(request.file, request.targetSizeBytes, {
    preferHevc: request.preferHevc,
    stripMetadata: request.stripMetadata,
    pauseGate: ownGate,
    whenVisible,
    onProgress: (progress, phase, pausable) => send({ type: 'progress', progress, phase, pausable }),
  }).then(
    (result) => send({ type: 'done', result }),
    (err: unknown) => send({ type: 'error', message: err instanceof Error ? err.message : String(err) }),
  ).finally(() => {
    if (gate === ownGate) gate = null;
  });
});
