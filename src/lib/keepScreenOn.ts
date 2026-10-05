/**
 * Holds a screen wake lock until the returned function is called, so a long
 * conversion isn't cut short by the phone dimming and locking itself. The
 * browser drops the lock whenever the page is hidden, so it is asked for
 * again each time the page comes back into view.
 *
 * Does nothing where the Screen Wake Lock API is missing or refused (low
 * battery, or a browser that only grants it to visible, focused pages).
 */
export function keepScreenOn(): () => void {
  if (!('wakeLock' in navigator)) return () => {};
  let sentinel: WakeLockSentinel | null = null;
  let requesting = false;
  let stopped = false;

  const acquire = () => {
    if (stopped || sentinel || requesting || document.visibilityState !== 'visible') return;
    requesting = true;
    navigator.wakeLock.request('screen').then(
      (lock) => {
        requesting = false;
        if (stopped) {
          void lock.release();
          return;
        }
        sentinel = lock;
        lock.addEventListener('release', () => {
          if (sentinel === lock) sentinel = null;
        });
      },
      () => {
        requesting = false;
      },
    );
  };

  document.addEventListener('visibilitychange', acquire);
  acquire();
  return () => {
    stopped = true;
    document.removeEventListener('visibilitychange', acquire);
    void sentinel?.release();
    sentinel = null;
  };
}
