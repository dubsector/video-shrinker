import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { availableLanguages, LANGUAGE_STORAGE_KEY } from './i18n';
import './LanguagePicker.css';

const AUTO = 'auto';

// A language's own name for itself ("Deutsch", "日本語") so every entry is
// readable to the person who needs it, whatever language is active.
// Building an Intl.DisplayNames costs real time and the answer never
// changes, so every result is kept for the life of the page.
const endonyms = new Map<string, string>();

function endonym(code: string): string {
  const cached = endonyms.get(code);
  if (cached !== undefined) return cached;
  let name = code;
  try {
    const named = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    if (named && named !== code) name = named.charAt(0).toLocaleUpperCase(code) + named.slice(1);
  } catch {
    // Keep the raw code for locales the browser can't name, and cache
    // that too so the failure isn't retried on every render.
  }
  endonyms.set(code, name);
  return name;
}

function GlobeIcon() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="10" cy="10" r="8" />
      <ellipse cx="10" cy="10" rx="3.5" ry="8" />
      <path d="M2 10h16M3 5.5h14M3 14.5h14" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="m4.5 10.5 4 4 7-9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LanguagePicker() {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // With a single locale file there is nothing to pick.
  if (availableLanguages.length < 2) return null;

  const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
  const selection = stored && availableLanguages.includes(stored) ? stored : AUTO;
  const shownCode = selection === AUTO ? (i18n.resolvedLanguage ?? 'en') : selection;

  const choose = (value: string) => {
    if (value === AUTO) {
      localStorage.removeItem(LANGUAGE_STORAGE_KEY);
      // Re-run detection from the device language now that the override
      // is gone; changeLanguage(undefined) asks the detector again.
      i18n.changeLanguage();
    } else {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, value);
      i18n.changeLanguage(value);
    }
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const options = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? Math.min(index + 1, options.length - 1) : Math.max(index - 1, 0);
    options[next]?.focus();
  };

  return (
    <div className="language-picker" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="language-picker-trigger"
        aria-label={t('language.label')}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <GlobeIcon />
        <span className="language-picker-code">{shownCode.toUpperCase()}</span>
        <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path d="m2.5 4.5 3.5 3.5 3.5-3.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="language-picker-menu" role="listbox" aria-label={t('language.label')} onKeyDown={onMenuKeyDown}>
          <button
            type="button"
            role="option"
            aria-selected={selection === AUTO}
            className={selection === AUTO ? 'selected' : ''}
            onClick={() => choose(AUTO)}
          >
            <span>{t('language.auto')}</span>
            {selection === AUTO && <CheckIcon />}
          </button>
          <div className="language-picker-divider" role="presentation" />
          {availableLanguages.map((code) => (
            <button
              key={code}
              type="button"
              role="option"
              aria-selected={selection === code}
              className={selection === code ? 'selected' : ''}
              ref={selection === code ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
              onClick={() => choose(code)}
            >
              <span>{endonym(code)}</span>
              {selection === code && <CheckIcon />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default LanguagePicker;
