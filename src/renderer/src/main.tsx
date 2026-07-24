import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import ThemeEditorWindow from './ThemeEditorWindow'
import { initAutoHideScrollbars } from './lib/scrollbar'
import { initTheme } from './lib/theme'
import { initUiStore } from './lib/ui-store'

initAutoHideScrollbars()

// the floating theme-editor window loads the same bundle under this hash
const standalone = window.location.hash === '#theme-editor'

// display settings hydrate before the first render so `useState(() => uiGet(...))`
// initializers see the persisted values instead of defaults; the theme applies
// right after for the same reason — no flash of the default colors
void initUiStore().finally(() => {
  initTheme()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>{standalone ? <ThemeEditorWindow /> : <App />}</StrictMode>
  )
})
