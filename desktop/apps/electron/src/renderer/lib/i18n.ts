/**
 * i18next setup for the renderer. Auto-detects locale via browser-language
 * detector, falls back to zh-CN. Resources are embedded inline (no async
 * fetch) so the renderer can render immediately on boot.
 *
 * Consumers:
 *   - main.tsx wraps <App /> in <I18nextProvider i18n={i18n}>
 *   - components call useTranslation() to get t()
 */
import i18next from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { initReactI18next } from 'react-i18next'

// Inline locales for the template. For larger apps, move these into
// packages/shared/src/i18n/locales and lazy-load with `i18next-http-backend`.
import en from '@app/shared/i18n/locales/en.json'
import zh from '@app/shared/i18n/locales/zh.json'

// initImmediate: false keeps init synchronous when resources are inline.
// This guarantees the first render already has translations, so react-i18next's
// default Suspense path never trips on a missing boundary.
i18next
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: 'en',
    supportedLngs: ['en', 'zh'],
    interpolation: { escapeValue: false },
    initImmediate: false,
    react: { useSuspense: false },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: 'i18nextLng',
    },
    resources: {
      en: { translation: en },
      zh: { translation: zh },
    },
  })

export const i18n = i18next
