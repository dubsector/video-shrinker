import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import './InstallPrompt.css';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const INSTALLED_KEY = 'pwa-installed';
const DISMISSED_KEY = 'pwa-install-dismissed';

// display-mode only tells us the app is installed if we're *currently*
// running inside it. If the user installed it previously but opened this
// tab in the regular browser instead, that check misses it — so we also
// remember installs we've seen via the appinstalled event.
function isInstalled() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true ||
    localStorage.getItem(INSTALLED_KEY) === 'true'
  );
}

// Chrome only shows its own install UI automatically for sites that don't
// handle beforeinstallprompt themselves; since this app calls
// preventDefault() below, we're on the hook for surfacing install access.
function InstallPrompt() {
  const { t } = useTranslation();
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    // A dismissal only holds until the next deploy — treated as "not now",
    // not "never" — so people get another chance to notice it post-update.
    if (isInstalled() || localStorage.getItem(DISMISSED_KEY) === __BUILD_INFO__.commit) return;

    const onBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      localStorage.setItem(INSTALLED_KEY, 'true');
      setDeferredPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (!deferredPrompt) return null;

  return (
    <div className="install-banner">
      <img src={`${import.meta.env.BASE_URL}pwa-192x192.png`} alt="" className="install-banner-icon" />
      <div className="install-banner-text">
        <strong>{t('install.title')}</strong>
        <span>{location.hostname}</span>
      </div>
      <button
        type="button"
        className="install-banner-install"
        onClick={async () => {
          await deferredPrompt.prompt();
          await deferredPrompt.userChoice;
          setDeferredPrompt(null);
        }}
      >
        {t('install.action')}
      </button>
      <button
        type="button"
        className="install-banner-dismiss"
        aria-label={t('install.dismiss')}
        onClick={() => {
          localStorage.setItem(DISMISSED_KEY, __BUILD_INFO__.commit);
          setDeferredPrompt(null);
        }}
      >
        &times;
      </button>
    </div>
  );
}

export default InstallPrompt;
