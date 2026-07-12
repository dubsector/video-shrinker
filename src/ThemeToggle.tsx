import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import './ThemeToggle.css';

type Theme = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'theme-preference';

function getStoredTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
}

function SystemIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="4" width="16" height="10" rx="1.5" />
      <path d="M7 17h6M10 14v3" strokeLinecap="round" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="10" cy="10" r="4" />
      <path
        d="M10 1.5v2M10 16.5v2M18.5 10h-2M3.5 10h-2M15.6 4.4l-1.4 1.4M5.8 14.2l-1.4 1.4M15.6 15.6l-1.4-1.4M5.8 5.8 4.4 4.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor">
      <path d="M17 12.5A7 7 0 0 1 7.5 3 7.5 7.5 0 1 0 17 12.5Z" />
    </svg>
  );
}

const OPTIONS: { value: Theme; labelKey: string; icon: () => React.ReactNode }[] = [
  { value: 'system', labelKey: 'theme.system', icon: SystemIcon },
  { value: 'light', labelKey: 'theme.light', icon: SunIcon },
  { value: 'dark', labelKey: 'theme.dark', icon: MoonIcon },
];

function ThemeToggle() {
  const { t } = useTranslation();
  const [theme, setTheme] = useState<Theme>(getStoredTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  return (
    <div className="theme-toggle" role="radiogroup" aria-label={t('theme.label')}>
      {OPTIONS.map(({ value, labelKey, icon: Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          aria-label={t(labelKey)}
          title={t(labelKey)}
          className={theme === value ? 'active' : ''}
          onClick={() => setTheme(value)}
        >
          <Icon />
        </button>
      ))}
    </div>
  );
}

export default ThemeToggle;
