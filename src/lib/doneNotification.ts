// A phone notification for a shrink that finishes while the app is in the
// background, so a long video doesn't need watching. The permission is only
// asked for from a button shown while a shrink runs, never on launch: that
// is when the alert is useful, and the user is the one who asks for it.
//
// Notifications go through the service worker, because Chrome on Android
// has no `new Notification()`. Inside the Android app, Chrome hands both the
// permission and the notification itself to the app (notification
// delegation, set up in android/), so on Android 13+ the system asks for the
// app's notification permission.

const TAG = 'shrink-done';

export type AlertPermission = NotificationPermission | 'unsupported';

export function doneAlertPermission(): AlertPermission {
  if (typeof Notification === 'undefined' || !('serviceWorker' in navigator)) return 'unsupported';
  return Notification.permission;
}

export async function askForDoneAlerts(): Promise<AlertPermission> {
  if (doneAlertPermission() === 'unsupported') return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

// Only when nobody is looking: on screen, the result already shows.
export async function notifyDone(title: string, body: string): Promise<void> {
  if (doneAlertPermission() !== 'granted' || document.visibilityState === 'visible') return;
  try {
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification(title, {
      body,
      tag: TAG,
      icon: `${import.meta.env.BASE_URL}pwa-192x192.png`,
    });
  } catch {
    // Nothing to do; the result is on screen when the user comes back.
  }
}

// Once the user is back in the app the alert has done its job.
export async function clearDoneAlert(): Promise<void> {
  if (doneAlertPermission() !== 'granted') return;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const shown = await registration?.getNotifications({ tag: TAG });
    for (const notification of shown ?? []) notification.close();
  } catch {
    // Not supported everywhere; leaving it up is harmless.
  }
}
