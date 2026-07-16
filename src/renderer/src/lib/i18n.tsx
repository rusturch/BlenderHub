import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { uiGet, uiSet } from './ui-store'

// Dictionaries are every JSON file in ../locales, discovered at build time by
// Vite — drop a new locales/<code>.json in and it shows up in the language
// picker with no code change. `en` is the source of truth for the key set and
// the fallback for any key a translation is missing. Translator workflow:
// npm run i18n:export / i18n:import.
type Dictionary = Record<string, string>

const DEFAULT_LANGUAGE = 'en'

const modules = import.meta.glob<{ default: Dictionary }>('../locales/*.json', { eager: true })

const DICTIONARIES: Record<string, Dictionary> = {}
for (const [path, mod] of Object.entries(modules)) {
  const code = path.match(/([^/]+)\.json$/)?.[1]
  if (code) DICTIONARIES[code] = mod.default
}

export type Language = string

/** Native name of a language code ('ru' → 'Русский'), falling back to the code. */
export function languageLabel(code: Language): string {
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code)
    if (name && name.toLowerCase() !== code.toLowerCase()) {
      return name.charAt(0).toUpperCase() + name.slice(1)
    }
  } catch {
    // Intl unavailable or code unrecognized — fall through to the raw code
  }
  return code.toUpperCase()
}

/** Every language that has a locales/<code>.json file: the default first, rest by name. */
export const AVAILABLE_LANGUAGES: Language[] = Object.keys(DICTIONARIES).sort((a, b) => {
  if (a === DEFAULT_LANGUAGE) return -1
  if (b === DEFAULT_LANGUAGE) return 1
  return languageLabel(a).localeCompare(languageLabel(b))
})

interface LanguageContextValue {
  language: Language
  setLanguage: (language: Language) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}

const LanguageContext = createContext<LanguageContextValue | null>(null)

function readStoredLanguage(): Language {
  const stored = uiGet('launcher.language')
  return stored && DICTIONARIES[stored] ? stored : DEFAULT_LANGUAGE
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return Object.entries(vars).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, String(value)),
    template
  )
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(() => readStoredLanguage())

  useEffect(() => {
    uiSet('launcher.language', language)
  }, [language])

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) =>
      interpolate(DICTIONARIES[language]?.[key] ?? DICTIONARIES[DEFAULT_LANGUAGE]?.[key] ?? key, vars),
    [language]
  )

  const value = useMemo(() => ({ language, setLanguage, t }), [language, t])

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
}

export function useTranslation(): LanguageContextValue {
  const ctx = useContext(LanguageContext)
  if (!ctx) throw new Error('useTranslation must be used within LanguageProvider')
  return ctx
}
