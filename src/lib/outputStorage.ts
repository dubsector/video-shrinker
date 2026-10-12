// Where encoded output goes while it is being written. Held in memory, a
// conversion keeps every finished byte of the output in RAM, plus a second copy
// while it becomes a Blob, plus the best earlier attempt when a correction pass
// runs. On a phone, with a big target, that can be enough for the browser to
// throw the page away. Written to the origin private file system instead, the
// output lives on disk and the finished Blob reads from there.
//
// Every browser without it (or that refuses it, as private windows can) keeps
// encoding into memory the way it always has.
import { BufferTarget, StreamTarget, type Target } from 'mediabunny';
import { openDiskOutput } from './outputFiles';

export type OutputFile = {
  target: Target;
  /** The finished output, or null if nothing was written. Call once the Output is finalized. */
  finish: () => Promise<Blob | null>;
  /** Deletes whatever was written, for an attempt that failed. Cancel the Output first. */
  discard: () => Promise<void>;
};

/**
 * Somewhere to write one output. Falls back to memory when the private file
 * system can't be used here.
 */
export async function createOutputFile(): Promise<OutputFile> {
  const disk = await openDiskOutput();
  if (disk) {
    return {
      // Writes are gathered into chunks first: every write to the file is a
      // round trip to the browser, and the encoder produces a great many small
      // packets.
      target: new StreamTarget(disk.writable, { chunked: true }),
      finish: disk.finish,
      discard: disk.discard,
    };
  }
  const target = new BufferTarget();
  return {
    target,
    finish: async () => (target.buffer ? new Blob([target.buffer], { type: 'video/mp4' }) : null),
    discard: async () => {},
  };
}
