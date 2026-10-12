// Bookkeeping for outputs written to the origin private file system (see
// outputStorage.ts). Kept apart from it, and free of mediabunny, so the page
// can clear old outputs at startup without loading the conversion engine.
const DIRECTORY = 'outputs';
const LOCK_PREFIX = 'video-shrinker-output:';

export type DiskOutput = {
  writable: FileSystemWritableFileStream;
  /** The finished output, or null if nothing was written. Call once everything is written. */
  finish: () => Promise<Blob | null>;
  /** Deletes whatever was written, for an attempt that failed. Cancel the Output first. */
  discard: () => Promise<void>;
};

type StoredOutput = { name: string; release: () => void };

// Files written by this page (or worker), keyed by the Blob handed out for
// each, so a caller holding only the Blob can let go of what's behind it.
const stored = new Map<Blob, StoredOutput>();
// Files not yet finished, so a new conversion can clear out any an earlier
// one abandoned without discarding.
const pending = new Set<StoredOutput>();

let directory: Promise<FileSystemDirectoryHandle | null> | null = null;

function getDirectory(): Promise<FileSystemDirectoryHandle | null> {
  directory ??= (async () => {
    try {
      if (!navigator.storage?.getDirectory || !navigator.locks) return null;
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle(DIRECTORY, { create: true });
      // createWritable() came to the private file system later than the rest.
      return 'createWritable' in FileSystemFileHandle.prototype ? dir : null;
    } catch {
      return null;
    }
  })();
  return directory;
}

/**
 * A lock held for as long as the file is wanted. The browser lets go of it when
 * the page or worker holding it goes away, which is how a later sweep tells a
 * file another open copy of the app is still using from one left behind.
 */
function holdLock(name: string): Promise<() => void> {
  return new Promise((resolve, reject) => {
    navigator.locks
      .request(LOCK_PREFIX + name, () => new Promise<void>((release) => resolve(release)))
      .catch(reject);
  });
}

async function remove(entry: StoredOutput): Promise<void> {
  const dir = await getDirectory();
  try {
    await dir?.removeEntry(entry.name);
  } catch {
    // Already gone, or still open for writing; the next sweep takes it.
  }
  entry.release();
}

/**
 * A new file in the private file system to write one output into, or null
 * when that can't be used here.
 */
export async function openDiskOutput(): Promise<DiskOutput | null> {
  const dir = await getDirectory();
  if (!dir) return null;

  const name = `${crypto.randomUUID()}.mp4`;
  let entry: StoredOutput | null = null;
  try {
    entry = { name, release: await holdLock(name) };
    pending.add(entry);
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    const own = entry;
    return {
      writable,
      finish: async () => {
        pending.delete(own);
        const file = await handle.getFile();
        if (file.size === 0) {
          await remove(own);
          return null;
        }
        // slice() keeps it on disk; it only gives it the type a download needs.
        const blob = file.slice(0, file.size, 'video/mp4');
        stored.set(blob, own);
        return blob;
      },
      discard: async () => {
        if (!pending.delete(own)) return;
        // A file still open for writing can't be deleted. Once the output has
        // started writing it holds the stream itself and closes it on cancel.
        if (!writable.locked) await writable.abort().catch(() => {});
        await remove(own);
      },
    };
  } catch (err) {
    console.warn('[video-shrinker] Could not write output to storage, keeping it in memory:', err);
    if (entry) {
      pending.delete(entry);
      await remove(entry);
    }
    return null;
  }
}

/** Deletes the file behind `blob`, if it was one of ours. The Blob can't be read afterwards. */
export async function releaseOutput(blob: Blob): Promise<void> {
  const entry = stored.get(blob);
  if (!entry) return;
  stored.delete(blob);
  await remove(entry);
}

/**
 * Deletes every output this page (or worker) wrote, and any left behind by
 * pages that are gone. Outputs another open copy of the app is still showing
 * keep their lock and are left alone.
 */
export async function releaseAllOutputs(): Promise<void> {
  const ours = [...stored.values(), ...pending];
  stored.clear();
  pending.clear();
  await Promise.all(ours.map(remove));

  const dir = await getDirectory();
  if (!dir) return;
  try {
    const names: string[] = [];
    // The DOM library this project builds against doesn't type the iterator.
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(name);
    await Promise.all(
      names.map((name) =>
        navigator.locks.request(LOCK_PREFIX + name, { ifAvailable: true }, async (lock) => {
          if (!lock) return;
          try {
            await dir.removeEntry(name);
          } catch {
            // Still open somewhere; it gets another chance next time.
          }
        }),
      ),
    );
  } catch (err) {
    console.warn('[video-shrinker] Could not clear old outputs:', err);
  }
}
