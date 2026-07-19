import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { initAutoHideScrollbars } from './lib/scrollbar'
import { initTheme } from './lib/theme'
import { initUiStore } from './lib/ui-store'

initAutoHideScrollbars()

// display settings hydrate before the first render so `useState(() => uiGet(...))`
// initializers see the persisted values instead of defaults; the theme applies
// right after for the same reason — no flash of the default colors
void initUiStore().finally(() => {
  initTheme()
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
})
