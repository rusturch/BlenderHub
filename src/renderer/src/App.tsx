import { useEffect, useState } from 'react'
import Sidebar from './components/Sidebar'
import type { Page } from './components/Sidebar'
import TitleBar from './components/TitleBar'
import DropOverlay from './components/DropOverlay'
import { DialogProvider } from './components/Dialog'
import { LanguageProvider } from './lib/i18n'
import { getLauncherApi } from './lib/preview-fallback'
import { uiGet, uiSet } from './lib/ui-store'
import ProjectsPage from './pages/Projects'
import InstallsPage from './pages/Installs'
import AddonsPage from './pages/Addons'
import SyncPage from './pages/Sync'
import ActivityPage from './pages/Activity'
import SettingsPage from './pages/Settings'

export default function App() {
  const [page, setPage] = useState<Page>('projects')
  const [projectsVersion, setProjectsVersion] = useState<string>('all')
  const [installsSearch, setInstallsSearch] = useState<string>('')
  const [addonsSearch, setAddonsSearch] = useState<string>('')
  const [settingsHighlight, setSettingsHighlight] = useState<string | null>(null)
  // bumped after a completed drag-and-drop: remounts the page area so the target
  // tab re-reads its data even when the drop landed on the tab already open
  const [dropEpoch, setDropEpoch] = useState(0)
  // the sidebar renders it, the title bar toggles it — so it lives in their parent
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => uiGet('sidebar.collapsed') === '1')

  useEffect(() => {
    uiSet('sidebar.collapsed', sidebarCollapsed ? '1' : '0')
  }, [sidebarCollapsed])

  const navigate = (target: Page): void => {
    // plain sidebar navigation clears any prefilled search / settings focus
    if (target === 'installs') setInstallsSearch('')
    if (target === 'addons') setAddonsSearch('')
    setSettingsHighlight(null)
    setPage(target)
  }

  const openSettings = (highlight?: string): void => {
    setSettingsHighlight(highlight ?? null)
    setPage('settings')
  }

  const showProjectsForVersion = (version: string): void => {
    setProjectsVersion(version)
    setPage('projects')
  }

  const showInstallsForVersion = (version: string): void => {
    setInstallsSearch(version)
    setPage('installs')
  }

  // the tray's page shortcuts land here regardless of which page is currently open
  useEffect(() => getLauncherApi().api.tray.onNavigate(navigate), [])

  const handleDropComplete = (target: Page | null, addonSearch: string | null): void => {
    if (!target) return
    // not navigate(): it would wipe the add-on search being handed over
    setAddonsSearch(target === 'addons' && addonSearch ? addonSearch : '')
    if (target === 'installs') setInstallsSearch('')
    setSettingsHighlight(null)
    setDropEpoch((epoch) => epoch + 1)
    setPage(target)
  }

  return (
    <LanguageProvider>
      <DialogProvider>
        <div className="flex h-full flex-col">
          <TitleBar
            onUpdateClick={() => openSettings('updates')}
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={() => setSidebarCollapsed((prev) => !prev)}
          />
          <div className="flex min-h-0 flex-1">
            <Sidebar
              current={page}
              onNavigate={navigate}
              onUpdateClick={() => openSettings('updates')}
              collapsed={sidebarCollapsed}
            />
            <main className="min-w-0 flex-1" key={dropEpoch}>
              {page === 'projects' && (
                <ProjectsPage
                  versionFilter={projectsVersion}
                  onVersionFilterChange={setProjectsVersion}
                  onShowInstalls={showInstallsForVersion}
                />
              )}
              {page === 'installs' && (
                <InstallsPage onShowProjects={showProjectsForVersion} initialSearch={installsSearch} />
              )}
              {page === 'addons' && <AddonsPage onOpenSettings={openSettings} initialSearch={addonsSearch} />}
              {page === 'sync' && <SyncPage onShowInstalls={showInstallsForVersion} />}
              {page === 'activity' && <ActivityPage />}
              {page === 'settings' && <SettingsPage highlight={settingsHighlight ?? undefined} />}
            </main>
          </div>
          <DropOverlay onDone={handleDropComplete} />
        </div>
      </DialogProvider>
    </LanguageProvider>
  )
}
