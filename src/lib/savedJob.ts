// Keeps the loaded video, its settings and any finished result in IndexedDB,
// so the work survives the page being thrown away. Phones do that to
// backgrounded tabs whenever they want the memory back (a lock screen or a
// quick trip to another app is enough), and the page then reloads from
// scratch when the user returns. Everything here is best effort: a browser
// without IndexedDB, or without the space for the video, simply loses the
// work on a reload the way it always did.
import type { ConvertResult } from './convert';

export type SavedSettings = {
  targetMb: number;
  forceH264: boolean;
  stripMetadata: boolean;
};

export type SavedState = {
  settings: SavedSettings;
  /** True from the moment a conversion starts until it finishes or fails. */
  converting: boolean;
  /** How many times in a row an interrupted conversion has been restarted on its own. */
  restarts: number;
  /** A finished result, with `sameAsSource` standing in for a blob that is the source file itself. */
  result: (Omit<ConvertResult, 'blob'> & { blob: Blob | null; sameAsSource: boolean }) | null;
};

export type SavedJob = { file: File; state: SavedState | null };

const DB_NAME = 'video-shrinker';
const STORE = 'job';
const FILE_KEY = 'file';
const STATE_KEY = 'state';

// A job nobody came back for in a day is stale, not interrupted.
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

async function run<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = body(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function warn(err: unknown): void {
  console.warn('[video-shrinker] Could not update the saved job:', err);
}

// Writes run one after another in the order they were asked for, so a clear
// that follows a save can't be overtaken by the save's quota check.
let queue: Promise<void> = Promise.resolve();

function serial(write: () => Promise<void>): Promise<void> {
  queue = queue.then(write).catch(warn);
  return queue;
}

/** Saves a newly loaded video, replacing whatever was saved before. */
export function saveFile(file: File): Promise<void> {
  return serial(async () => {
    // Storing the video copies it, so don't start a copy that can't fit.
    const estimate = await navigator.storage?.estimate?.();
    const free = estimate?.quota !== undefined && estimate.usage !== undefined ? estimate.quota - estimate.usage : Infinity;
    await run('readwrite', (store) => {
      store.delete(STATE_KEY);
      if (file.size < free) store.put({ file, savedAt: Date.now() }, FILE_KEY);
      else store.delete(FILE_KEY);
    });
  });
}

export function saveState(state: SavedState): Promise<void> {
  return serial(async () => {
    await run('readwrite', (store) => {
      store.put(state, STATE_KEY);
    });
  });
}

export function toSavedResult(result: ConvertResult, source: File): NonNullable<SavedState['result']> {
  const sameAsSource = result.blob === source;
  return { ...result, blob: sameAsSource ? null : result.blob, sameAsSource };
}

export function fromSavedResult(saved: NonNullable<SavedState['result']>, source: File): ConvertResult {
  const { sameAsSource, blob, ...rest } = saved;
  return { ...rest, blob: sameAsSource || !blob ? source : blob };
}

export function clearJob(): Promise<void> {
  return serial(async () => {
    await run('readwrite', (store) => {
      store.delete(FILE_KEY);
      store.delete(STATE_KEY);
    });
  });
}

export async function loadJob(): Promise<SavedJob | null> {
  try {
    const saved = await run<{ file: File; savedAt: number } | undefined>('readonly', (store) => store.get(FILE_KEY));
    if (!saved?.file) return null;
    if (Date.now() - saved.savedAt > MAX_AGE_MS) {
      void clearJob();
      return null;
    }
    const state = await run<SavedState | undefined>('readonly', (store) => store.get(STATE_KEY));
    return { file: saved.file, state: state ?? null };
  } catch (err) {
    warn(err);
    return null;
  }
}
