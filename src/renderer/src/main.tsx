import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { initAutoHideScrollbars } from './lib/scrollbar'
import { initUiStore } from './lib/ui-store'

initAutoHideScrollbars()

// display settings hydrate before the first render so `useState(() => uiGet(...))`
// initializers see the persisted values instead of defaults
void initUiStore().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
})
