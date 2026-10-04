import { useCallback, useEffect, useRef, useState } from 'react';
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
  // Set when this page is the one applying the update, so the reload that
  // follows is the one the user (or the idle auto-apply) asked for.
  const applyingHere = useRef(false);
  const reloadWaiting = useRef(false);
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, swRegistration) {
      if (swRegistration) setRegistration(swRegistration);
    },
    // Called when a new worker takes over this page, which reloads it by
    // default. That also happens when the update was applied somewhere else:
    // another open copy of the app that was idle applies it by itself, and
    // its worker then takes over every copy at once, so a conversion running
    // here would be killed with no warning. A busy page waits until it is
    // idle instead.
    onNeedReload() {
      if (applyingHere.current || !isAppBusy()) {
        location.reload();
        return;
      }
      if (reloadWaiting.current) return;
      reloadWaiting.current = true;
      const stop = onAppBusyChange((busy) => {
        if (busy) return;
        stop();
        location.reload();
      });
    },
  });
  const applyUpdate = useCallback(() => {
    applyingHere.current = true;
    void updateServiceWorker(true);
  }, [updateServiceWorker]);
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
      applyUpdate();
      return;
    }
    setShowPrompt(true);
    return onAppBusyChange((busy) => {
      if (!busy) applyUpdate();
    });
  }, [needRefresh, applyUpdate]);

  if (!showPrompt) return null;

  return (
    <div className="update-prompt">
      <span>{t('update.available')}</span>
      <button type="button" onClick={applyUpdate}>
        {t('update.reload')}
      </button>
      <button type="button" className="dismiss" onClick={() => setNeedRefresh(false)}>
        {t('update.dismiss')}
      </button>
    </div>
  );
}

export default UpdatePrompt;
