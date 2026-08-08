import i18n, { type BackendModule } from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';

export const LANGUAGE_STORAGE_KEY = 'language-preference';

// English is excluded from the glob because it is also imported statically
// below. Listing it both ways made the build warn that the dynamic import
// could not move it into its own chunk — true, and intended, but noise on
// every build.
const localeModules = import.meta.glob<{ default: Record<string, unknown> }>([
  './locales/*.json',
  '!./locales/en.json',
]);

export const availableLanguages = [
  'en',
  ...Object.keys(localeModules).map((path) => path.replace('./locales/', '').replace('.json', '')),
].sort();

// English ships in the main bundle so the first paint never waits on a
// locale chunk; every other language is code-split and fetched on demand.
// The split chunks end up in the precache manifest, so installed apps can
// switch languages offline.
const lazyLocaleBackend: BackendModule = {
  type: 'backend',
  init() {},
  read(language, _namespace, callback) {
    // Already in the bundle, so it never needs fetching.
    if (language === 'en') {
      callback(null, en);
      return;
    }
    const loader = localeModules[`./locales/${language}.json`];
    if (!loader) {
      callback(new Error(`No locale file for ${language}`), null);
      return;
    }
    loader().then(
      (module) => callback(null, module.default),
      (error) => callback(error, null),
    );
  },
};

i18n
  .use(lazyLocaleBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    // Only an explicit choice in the picker is persisted; plain visits
    // re-detect from the device language every launch.
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
      caches: [],
      // Browsers report codes our files don't use directly: nb/nn (Bokmål,
      // Nynorsk), legacy iw for Hebrew, fil for Filipino (ISO 639-1 tl),
      // and the traditional-script Chinese variants (zh-Hant*, zh-HK,
      // zh-MO), which read better as zh-TW than simplified zh. The aliases
      // must be applied to the detected code itself: i18next resolves an
      // unknown code to its base language before fallbackLng is consulted,
      // so a fallbackLng map never sees them.
      convertDetectedLanguage: (code) => {
        if (/^zh-(Hant|HK|MO|TW)/i.test(code)) return 'zh-TW';
        const aliases: Record<string, string> = { nb: 'no', nn: 'no', iw: 'he', fil: 'tl' };
        return aliases[code.split('-')[0]] ?? code;
      },
    },
    supportedLngs: availableLanguages,
    nonExplicitSupportedLngs: false,
    fallbackLng: 'en',
    partialBundledLanguages: true,
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });

function applyDocumentLanguage(language: string) {
  document.documentElement.lang = language;
  document.documentElement.dir = i18n.dir(language);
}

i18n.on('languageChanged', applyDocumentLanguage);
if (i18n.resolvedLanguage) applyDocumentLanguage(i18n.resolvedLanguage);

export default i18n;
