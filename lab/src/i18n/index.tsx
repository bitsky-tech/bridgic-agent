import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { en, type TranslationKey } from './en'
import { zhCN } from './zh-CN'

export type Locale = 'en-US' | 'zh-CN'
export type { TranslationKey }

type TranslationParams = Record<string, string | number>

interface I18nContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  toggleLocale: () => void
  t: (key: TranslationKey, params?: TranslationParams) => string
  formatNumber: (value: number) => string
}

const storageKey = 'bridgic-agent-lab.locale'
const dictionaries: Record<Locale, Record<TranslationKey, string>> = {
  'en-US': en,
  'zh-CN': zhCN,
}

const I18nContext = createContext<I18nContextValue | null>(null)

function detectLocale(): Locale {
  if (typeof window === 'undefined') return 'en-US'

  try {
    const saved = window.localStorage.getItem(storageKey)
    if (saved === 'en-US' || saved === 'zh-CN') return saved
  } catch {
    return window.navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
  }

  return window.navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

export function translate(locale: Locale, key: TranslationKey, params: TranslationParams = {}): string {
  const template = dictionaries[locale][key]
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = params[name]
    return value === undefined ? placeholder : String(value)
  })
}

export function localeSelfName(locale: Locale): string {
  return dictionaries[locale]['language.selfName']
}

export function I18nProvider({
  children,
  initialLocale,
}: {
  children: ReactNode
  initialLocale?: Locale
}) {
  const [locale, setLocale] = useState<Locale>(() => initialLocale ?? detectLocale())

  useEffect(() => {
    document.documentElement.lang = locale
    try {
      window.localStorage.setItem(storageKey, locale)
    } catch {
      return
    }
  }, [locale])

  const t = useCallback(
    (key: TranslationKey, params?: TranslationParams) => translate(locale, key, params),
    [locale],
  )
  const formatter = useMemo(() => new Intl.NumberFormat(locale), [locale])
  const formatNumber = useCallback((value: number) => formatter.format(value), [formatter])
  const toggleLocale = useCallback(
    () => setLocale((current) => current === 'en-US' ? 'zh-CN' : 'en-US'),
    [],
  )

  const value = useMemo<I18nContextValue>(() => ({
    locale,
    setLocale,
    toggleLocale,
    t,
    formatNumber,
  }), [formatNumber, locale, t, toggleLocale])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext)
  if (!context) throw new Error('useI18n must be used inside I18nProvider.')
  return context
}
