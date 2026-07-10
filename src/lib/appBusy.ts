// Tracks whether the app has work worth protecting from a reload — a loaded
// file, a running conversion, or a finished result that hasn't been
// downloaded. The update flow (src/UpdatePrompt.tsx) reads this to decide
// between applying an update silently and asking first.

type Listener = (busy: boolean) => void

let busy = false
const listeners = new Set<Listener>()

export function setAppBusy(next: boolean): void {
  if (next === busy) return
  busy = next
  for (const listener of listeners) listener(next)
}

export function isAppBusy(): boolean {
  return busy
}

export function onAppBusyChange(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
