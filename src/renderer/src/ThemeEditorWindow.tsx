import { useEffect } from 'react'
import { DialogProvider } from './components/Dialog'
import { LanguageProvider, useTranslation } from './lib/i18n'
import { ThemeCard } from './pages/settings/ThemeCard'

// The floating theme-editor window (#theme-editor): just the Theme card in its
// own OS window, so colors can be tweaked while browsing the main window. Every
// change persists through ui-state and reaches other windows live (ui-store
// onUiChanged), no extra wiring here.

export default function ThemeEditorWindow() {
  return (
    <LanguageProvider>
      <DialogProvider>
        <EditorContent />
      </DialogProvider>
    </LanguageProvider>
  )
}

function EditorContent() {
  const { t } = useTranslation()

  useEffect(() => {
    document.title = `${t('settings.themes')} — Blender Hub`
  }, [t])

  return (
    <div className="h-full overflow-auto p-4">
      <ThemeCard standalone />
    </div>
  )
}
