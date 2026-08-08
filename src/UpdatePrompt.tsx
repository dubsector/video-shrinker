import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { isAppBusy, onAppBusyChange } from './lib/appBusy';
import './UpdatePrompt.css';

// Installed apps (especially the Android TWA) can stay resident for days,
// so the registration-time update check alone would never fire again.
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

// Updates apply themselves while there is nothing to lose. A reload
// mid-conversion kills the encode and one on the results screen throws away
// an undownloaded file, so with a file loaded the user gets a prompt
// instead — and if they clear the app back to idle while the prompt is
// still up, the update applies itself then.
function UpdatePrompt() {
  const { t } = useTranslation();
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, swRegistration) {
      if (swRegistration) setRegistration(swRegistration);
    },
  });
  const [showPrompt, setShowPrompt] = useState(false);

  // The timer and listener live in an effect so they are torn down with the
  // component. They used to be registered straight from onRegisteredSW with no
  // cleanup, which double-registered under StrictMode and ran every check
  // twice in development.
  useEffect(() => {
    if (!registration) return;
    const check = () => {
      // Data Saver means the user asked to minimize background traffic,
      // so skip polling; updates still arrive via the registration-time
      // check on the next launch. Read per-check since it can be toggled.
      const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
      if (connection?.saveData) return;
      registration.update().catch(() => {});
    };
    const timer = setInterval(check, UPDATE_CHECK_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [registration]);

  useEffect(() => {
    if (!needRefresh) {
      setShowPrompt(false);
      return;
    }
    if (!isAppBusy()) {
      updateServiceWorker(true);
      return;
    }
    setShowPrompt(true);
    return onAppBusyChange((busy) => {
      if (!busy) updateServiceWorker(true);
    });
  }, [needRefresh, updateServiceWorker]);

  if (!showPrompt) return null;

  return (
    <div className="update-prompt">
      <span>{t('update.available')}</span>
      <button type="button" onClick={() => updateServiceWorker(true)}>
        {t('update.reload')}
      </button>
      <button type="button" className="dismiss" onClick={() => setNeedRefresh(false)}>
        {t('update.dismiss')}
      </button>
    </div>
  );
}

export default UpdatePrompt;
